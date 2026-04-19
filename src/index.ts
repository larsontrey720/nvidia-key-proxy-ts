/**
 * Nvidia API Key Rotation Proxy - TypeScript/Hono
 * 
 * Deployable to: Bun, Cloudflare Workers, Vercel Edge
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'

const BASE_URL = 'https://integrate.api.nvidia.com'

// API keys from environment variable (comma-separated) or hardcoded fallback
// Set NVIDIA_API_KEYS in Vercel Environment Variables: nvapi-key1,nvapi-key2,nvapi-key3
const API_KEYS: string[] = (process.env.NVIDIA_API_KEYS?.split(',').map(k => k.trim()).filter(Boolean) || [
  // Fallback keys (remove before deploying to production)
]).filter(k => k.length > 0)

if (API_KEYS.length === 0) {
  console.error('[PROXY] ERROR: No API keys configured! Set NVIDIA_API_KEYS env var.')
}

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
  // Fix for z-ai/glm models that need higher max_tokens
  if (!requestBody.max_tokens) {
    requestBody.max_tokens = 32768
  }
  
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
      // Clone body and add model-specific params
      const modifiedBody = { ...requestBody, stream: true }
      
      // Add default temperature and top_p if not provided
      if (modifiedBody.temperature === undefined) {
        modifiedBody.temperature = 0.7
      }
      if (modifiedBody.top_p === undefined) {
        modifiedBody.top_p = 1.0
      }
      
      // For z-ai/glm4.7, ensure chat_template_kwargs is set for clean output
      if (modifiedBody.model === 'z-ai/glm4.7' && !modifiedBody.chat_template_kwargs) {
        modifiedBody.chat_template_kwargs = {
          enable_thinking: false,
          clear_thinking: true
        }
        console.log(`[PROXY] Added chat_template_kwargs for z-ai/glm4.7`)
      }
      
      const bodyString = JSON.stringify(modifiedBody)
      
      const headers = buildHeaders(currentIdx)
      headers.set('Content-Type', 'application/json')
      
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
        continue
      }
      
      currentKeyIndex = currentIdx
      
      const reader = response.body?.getReader()
      if (!reader) return c.text('No body', 500)
      
      if (clientWantsStream) {
        // Pure streaming - forward chunks as-is from Nvidia
        return new Response(
          new ReadableStream({
            async start(controller) {
              let totalBytes = 0
              let chunkCount = 0
              
              try {
                while (true) {
                  const { done, value } = await reader.read()
                  if (done) break
                  controller.enqueue(value)
                  totalBytes += value.length
                  chunkCount++
                }
                console.log(`[PROXY] ← ${response.status} (${Date.now() - startTime}ms, ${chunkCount} chunks, ${totalBytes} bytes)`)
              } catch (e) {
                console.error(`[PROXY] Stream error: ${e}`)
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
              'X-Accel-Buffering': 'no',
              'Access-Control-Allow-Origin': '*',
            }
          }
        )
      } else {
        // JSON reassembly - collect all data then return as JSON
        const chunks: string[] = []
        const decoder = new TextDecoder()
        let totalBytes = 0
        
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            chunks.push(decoder.decode(value, { stream: true }))
            totalBytes += value.length
          }
          
          const fullSSE = chunks.join('')
          const messages: string[] = []
          const reasoningParts: string[] = []
          
          for (const line of fullSSE.split('\n')) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim()
              if (data === '[DONE]') continue
              try {
                const parsed = JSON.parse(data)
                const delta = parsed.choices?.[0]?.delta
                if (delta) {
                  if (delta.content) messages.push(delta.content)
          
          const finalJson = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: requestBody.model || 'unknown',
            choices: [{
              index: 0,
              message: { 
                role: 'assistant', 
                content: messages.join(''),
                ...(reasoningParts.length > 0 && { reasoning_content: reasoningParts.join('') })
              },
              finish_reason: 'stop'
            }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
          }
          
          console.log(`[PROXY] ← ${response.status} (${Date.now() - startTime}ms, re-assembled ${totalBytes} bytes)`)
          return c.json(finalJson)
          
        } catch (e) {
          console.error(`[PROXY] Re-assembly error: ${e}`)
          return c.json({ error: String(e) }, 502)
        }
      }
      
    } catch (error) {
      console.error(`[PROXY] ERROR: ${error}`)
      return c.json({ error: String(error) }, 502)
    }
  }
})

// Export for Vercel Edge
export default app
