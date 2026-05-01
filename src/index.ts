/**
 * Nvidia API Key Rotation Proxy - TypeScript/Hono
 * 
 * Deployable to: Bun, Cloudflare Workers, Vercel Edge
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'

const BASE_URL = 'https://integrate.api.nvidia.com'

const API_KEYS: string[] = (process.env.NVIDIA_API_KEYS?.split(',').map(k => k.trim()).filter(Boolean) || [
]).filter(k => k.length > 0)

if (API_KEYS.length === 0) {
  console.error('[PROXY] ERROR: No API keys configured! Set NVIDIA_API_KEYS env var.')
}

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
      const modifiedBody = { ...requestBody, stream: true }
      
      modifiedBody.temperature = 0.75
      modifiedBody.top_p = 1.0
      
      if (modifiedBody.model === 'z-ai/glm4.7' && !modifiedBody.chat_template_kwargs) {
        modifiedBody.chat_template_kwargs = {
          enable_thinking: false,
          clear_thinking: true
        }
        console.log(`[PROXY] Added chat_template_kwargs for z-ai/glm4.7`)
      }

      if (modifiedBody.model === 'moonshotai/kimi-k2.5' && !modifiedBody.chat_template_kwargs) {
        modifiedBody.chat_template_kwargs = { thinking: false }
        console.log(`[PROXY] Added chat_template_kwargs for moonshotai/kimi-k2.5 (thinking disabled)`)
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
        const needsNormalization = requestBody.model?.includes('stepfun') || requestBody.model?.includes('step-3.5')
        
        return new Response(
          new ReadableStream({
            async start(controller) {
              const encoder = new TextEncoder()
              const decoder = new TextDecoder()
              let totalBytes = 0
              let chunkCount = 0
              
              try {
                while (true) {
                  const { done, value } = await reader.read()
                  if (done) break
                  
                  if (needsNormalization) {
                    const text = decoder.decode(value, { stream: true })
                    const lines = text.split('\n')
                    const normalizedLines: string[] = []
                    
                    for (const line of lines) {
                      if (line.startsWith('data: ') && !line.includes('[DONE]')) {
                        try {
                          const data = JSON.parse(line.slice(6))
                          const delta = data.choices?.[0]?.delta
                          if (delta && 'reasoning' in delta) {
                            delete delta.reasoning
                          }
                          // Strip <think>...</think> tags from content field
                          // stepfun embeds these in content alongside reasoning_content
                          if (delta?.content && typeof delta.content === 'string') {
                            delta.content = delta.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
                            if (delta.content === '') delta.content = null
                          }
                          normalizedLines.push('data: ' + JSON.stringify(data))
                        } catch {
                          normalizedLines.push(line)
                        }
                      } else {
                        normalizedLines.push(line)
                      }
                    }
                    const normalized = normalizedLines.join('\n')
                    controller.enqueue(encoder.encode(normalized))
                    totalBytes += normalized.length
                  } else {
                    controller.enqueue(value)
                    totalBytes += value.length
                  }
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
                  if (delta.content) {
                    messages.push(delta.content)
                  } else if (delta.reasoning_content) {
                    reasoningParts.push(delta.reasoning_content)
                  }
                }
              } catch {
                // Skip malformed lines
              }
            }
          }
          
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

export default app
