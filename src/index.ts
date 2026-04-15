/**
 * Nvidia API Key Rotation Proxy - TypeScript/Hono
 * 
 * Deployable to: Bun, Cloudflare Workers, Vercel Edge
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'

const BASE_URL = 'https://integrate.api.nvidia.com'

const API_KEYS: string[] = [
  'nvapi-YOUR_KEY_HERE',
  'nvapi-YOUR_KEY_HERE',
]

const HEARTBEAT_INTERVAL_MS = 3000
const HEARTBEAT_BYTE = ': keep-alive\n\n'

let currentKeyIndex = 0
let totalRequests = 0
let total429s = 0

const app = new Hono()

app.use('*', cors())

app.get('/', (c) => {
  return c.json({
    status: 'ok',
    keys: API_KEYS.length,
    currentKey: currentKeyIndex + 1,
    stats: { totalRequests, total429s }
  })
})

app.all('/v1/*', async (c) => {
  totalRequests++
  const startTime = Date.now()
  
  const path = c.req.path.startsWith('/v1') ? c.req.path.slice(3) : c.req.path
  const method = c.req.method
  const url = `${BASE_URL}/v1${path}`
  
  const triedKeys = new Set<number>()
  let currentIdx = currentKeyIndex
  
  const rawBody = method !== 'GET' ? await c.req.arrayBuffer() : undefined
  const requestBody = rawBody ? JSON.parse(new TextDecoder().decode(rawBody)) : {}
  const clientWantsStream = requestBody.stream === true
  
  const buildHeaders = (keyIndex: number): Headers => {
    const headers = new Headers()
    c.req.raw.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase()
      if (!['host', 'connection', 'content-length', 'authorization'].includes(lowerKey)) {
        headers.set(key, value)
      }
    })
    headers.set('Authorization', `Bearer ${API_KEYS[keyIndex]}`)
    return headers
  }
  
  console.log(`[PROXY] ${method} ${path} → key=${currentIdx + 1}/${API_KEYS.length}`)
  
  while (true) {
    triedKeys.add(currentIdx)
    
    try {
      const modifiedBody = { ...requestBody, stream: true }
      const bodyString = JSON.stringify(modifiedBody)
      
      const headers = buildHeaders(currentIdx)
      headers.set('Content-Type', 'application/json')
      headers.set('Content-Length', String(new TextEncoder().encode(bodyString).length))
      
      const response = await fetch(url, {
        method,
        headers,
        body: method !== 'GET' ? bodyString : undefined,
      })
      
      if (response.status === 429) {
        console.log(`[PROXY] 429 from key ${currentIdx + 1}`)
        total429s++
        
        const nextIdx = (currentIdx + 1) % API_KEYS.length
        
        if (triedKeys.has(nextIdx)) {
          console.log(`[PROXY] All keys exhausted`)
          return c.json({ error: 'All API keys rate limited' }, 429)
        }
        
        currentIdx = nextIdx
        currentKeyIndex = nextIdx
        console.log(`[PROXY] → key ${nextIdx + 1}`)
        continue
      }
      
      currentKeyIndex = currentIdx
      
      const reader = response.body?.getReader()
      if (!reader) return c.text('No body', 500)
      
      // Stream with heartbeat
      return new Response(
        new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder()
            const decoder = new TextDecoder()
            let totalBytes = 0
            let chunkCount = 0
            let firstChunkReceived = false
            let heartbeatTimer: any = null
            const chunks: string[] = []
            
            const sendHeartbeat = () => {
              if (!firstChunkReceived) {
                controller.enqueue(encoder.encode(HEARTBEAT_BYTE))
              }
            }
            
            heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS)
            
            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                
                if (!firstChunkReceived) {
                  firstChunkReceived = true
                  if (heartbeatTimer) clearInterval(heartbeatTimer)
                }
                
                controller.enqueue(value)
                totalBytes += value.length
                chunkCount++
                
                if (!clientWantsStream) {
                  chunks.push(decoder.decode(value, { stream: true }))
                }
              }
              
              if (!clientWantsStream && chunks.length > 0) {
                // Re-assemble JSON for non-streaming clients
                const fullSSE = chunks.join('')
                const messages: string[] = []
                
                for (const line of fullSSE.split('\n')) {
                  if (line.startsWith('data: ')) {
                    const data = line.slice(6).trim()
                    if (data === '[DONE]') continue
                    try {
                      const parsed = JSON.parse(data)
                      if (parsed.choices?.[0]?.delta?.content) {
                        messages.push(parsed.choices[0].delta.content)
                      }
                    } catch {}
                  }
                }
                
                const finalJson = {
                  id: `chatcmpl-${Date.now()}`,
                  object: 'chat.completion',
                  created: Math.floor(Date.now() / 1000),
                  model: requestBody.model || 'unknown',
                  choices: [{
                    index: 0,
                    message: { role: 'assistant', content: messages.join('') },
                    finish_reason: 'stop'
                  }],
                  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
                }
                
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalJson)}\n\n`))
                controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              }
              
              console.log(`[PROXY] ← ${response.status} (${Date.now() - startTime}ms, ${chunkCount} chunks, ${totalBytes} bytes)`)
            } catch (e) {
              console.log(`[PROXY] Error: ${e}`)
              if (heartbeatTimer) clearInterval(heartbeatTimer)
            } finally {
              controller.close()
            }
          }
        }),
        {
          status: response.status,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
          }
        }
      )
      
    } catch (error) {
      console.error(`[PROXY] ERROR: ${error}`)
      return c.json({ error: String(error) }, 502)
    }
  }
})

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

// Vercel Edge Function config
export const config = {
  runtime: 'edge',
}

// Default export for Vercel/Bun
export default app

// Named export for Cloudflare Workers
export { app }
