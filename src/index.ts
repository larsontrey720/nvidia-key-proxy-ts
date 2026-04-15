/**
 * Nvidia API Key Rotation Proxy - TypeScript/Hono
 * 
 * Deployable to: Bun, Cloudflare Workers, Vercel Edge
 * 
 * Features:
 * - OpenAI-compatible API proxy
 * - Automatic key rotation on 429
 * - Keep-Alive Stream Relay (prevents gateway timeouts)
 * - Forced streaming with heartbeat during "thinking" phase
 * - JSON re-assembly for non-streaming requests
 * - CORS enabled
 */

import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { cors } from 'hono/cors'

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const BASE_URL = 'https://integrate.api.nvidia.com'

// Add 2-5 API keys here. Keys are rotated circularly when a 429 is received.
const API_KEYS: string[] = [
  'nvapi-YOUR_KEY_HERE',
  'nvapi-YOUR_KEY_HERE',
  // Add more keys here
]

// Keep-alive settings
const HEARTBEAT_INTERVAL_MS = 3000  // Send heartbeat every 3 seconds
const HEARTBEAT_BYTE = ': keep-alive\n\n'  // SSE comment (invisible to client)

// Key state (for serverless, this resets on each cold start - use KV for persistence)
let currentKeyIndex = 0

// Stats
let totalRequests = 0
let total429s = 0

// ─── APP ─────────────────────────────────────────────────────────────────────

const app = new Hono()

// Enable CORS for all routes
app.use('*', cors())

// Health check
app.get('/', (c) => {
  return c.json({
    status: 'ok',
    keys: API_KEYS.length,
    currentKey: currentKeyIndex + 1,
    features: ['keep-alive-relay', 'forced-streaming', 'json-reassembly'],
    stats: { totalRequests, total429s }
  })
})

// Proxy all /v1/* requests to Nvidia
app.all('/v1/*', async (c) => {
  totalRequests++
  const startTime = Date.now()
  
  // Extract path after /v1
  const path = c.req.path.startsWith('/v1') ? c.req.path.slice(3) : c.req.path
  const method = c.req.method
  const url = `${BASE_URL}/v1${path}`
  
  // Track which keys we've tried
  const triedKeys = new Set<number>()
  let currentIdx = currentKeyIndex
  
  // Get request body and check if client wants streaming
  const rawBody = method !== 'GET' ? await c.req.arrayBuffer() : undefined
  const requestBody = rawBody ? JSON.parse(new TextDecoder().decode(rawBody)) : {}
  const clientWantsStream = requestBody.stream === true
  
  // Build headers (forward all except host/connection)
  const buildHeaders = (keyIndex: number, forceStream: boolean = true): Headers => {
    const headers = new Headers()
    
    // Copy original headers
    c.req.raw.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase()
      if (!['host', 'connection', 'content-length', 'authorization'].includes(lowerKey)) {
        headers.set(key, value)
      }
    })
    
    // Set authorization with our key
    headers.set('Authorization', `Bearer ${API_KEYS[keyIndex]}`)
    
    // Force streaming for upstream (we'll re-assemble if client wants JSON)
    if (forceStream && rawBody) {
      const modifiedBody = { ...requestBody, stream: true }
      // Content-Length will be set by fetch
    }
    
    return headers
  }
  
  console.log(`[PROXY] ${method} ${path} → key=${currentIdx + 1}/${API_KEYS.length} (clientWantsStream=${clientWantsStream})`)
  
  // Retry loop for key rotation
  while (true) {
    triedKeys.add(currentIdx)
    
    try {
      // Always force streaming from upstream for keep-alive benefits
      const modifiedBody = { ...requestBody, stream: true }
      const bodyString = JSON.stringify(modifiedBody)
      
      const headers = buildHeaders(currentIdx)
      headers.set('Content-Type', 'application/json')
      headers.set('Content-Length', String(new TextEncoder().encode(bodyString).length))
      
      // Make request to Nvidia (always streaming internally)
      const response = await fetch(url, {
        method,
        headers,
        body: method !== 'GET' ? bodyString : undefined,
        // @ts-ignore - duplex is needed for streaming
        duplex: 'half',
      })
      
      // Check for 429
      if (response.status === 429) {
        console.log(`[PROXY] 429 from key ${currentIdx + 1}`)
        total429s++
        
        // Rotate to next key
        const nextIdx = (currentIdx + 1) % API_KEYS.length
        
        if (triedKeys.has(nextIdx)) {
          // All keys exhausted
          console.log(`[PROXY] All ${API_KEYS.length} keys exhausted, returning 429`)
          return c.json({
            error: 'All API keys rate limited',
            keys_tried: triedKeys.size
          }, 429)
        }
        
        currentIdx = nextIdx
        currentKeyIndex = nextIdx
        console.log(`[PROXY] 429 → rotating to key ${nextIdx + 1}/${API_KEYS.length}`)
        continue
      }
      
      // Success - update global key index
      currentKeyIndex = currentIdx
      
      // Handle the streaming response with keep-alive relay
      const reader = response.body?.getReader()
      if (!reader) {
        return c.text('No body', 500)
      }
      
      if (clientWantsStream) {
        // ─── STREAMING CLIENT: Pipe through with heartbeat ───────────────────────
        console.log(`[PROXY] Client wants stream - piping with heartbeat...`)
        
        return new Response(
          new ReadableStream({
            async start(controller) {
              const encoder = new TextEncoder()
              let totalBytes = 0
              let chunkCount = 0
              let firstChunkReceived = false
              let heartbeatTimer: ReturnType<typeof setInterval> | null = null
              
              // Heartbeat function - sends invisible SSE comments
              const sendHeartbeat = () => {
                if (!firstChunkReceived) {
                  console.log(`[PROXY] Sending heartbeat...`)
                  controller.enqueue(encoder.encode(HEARTBEAT_BYTE))
                }
              }
              
              // Start heartbeat timer
              heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS)
              
              try {
                while (true) {
                  const { done, value } = await reader.read()
                  
                  if (done) {
                    console.log(`[PROXY] Stream complete`)
                    break
                  }
                  
                  // First real data received - stop heartbeats
                  if (!firstChunkReceived) {
                    firstChunkReceived = true
                    if (heartbeatTimer) clearInterval(heartbeatTimer)
                    console.log(`[PROXY] First chunk received - stopping heartbeat`)
                  }
                  
                  controller.enqueue(value)
                  totalBytes += value.length
                  chunkCount++
                }
                
                const duration = Date.now() - startTime
                console.log(`[PROXY] ← ${response.status} (${duration}ms, ${chunkCount} chunks, ${totalBytes} bytes)`)
              } catch (e) {
                console.log(`[PROXY] Stream error: ${e}`)
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
      } else {
        // ─── JSON CLIENT: Re-assemble from stream with heartbeat ─────────────────
        console.log(`[PROXY] Client wants JSON - re-assembling from stream...`)
        
        // Return headers immediately (resets gateway timeout)
        // This is the "Immediate Flush Protocol"
        return new Response(
          new ReadableStream({
            async start(controller) {
              const encoder = new TextEncoder()
              const decoder = new TextDecoder()
              let totalBytes = 0
              let chunkCount = 0
              let firstChunkReceived = false
              let heartbeatTimer: ReturnType<typeof setInterval> | null = null
              
              // Buffer to collect all SSE data
              const chunks: string[] = []
              
              // Heartbeat function - sends invisible SSE comments
              const sendHeartbeat = () => {
                if (!firstChunkReceived) {
                  console.log(`[PROXY] Sending heartbeat during think phase...`)
                  controller.enqueue(encoder.encode(HEARTBEAT_BYTE))
                }
              }
              
              // Start heartbeat timer
              heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS)
              
              try {
                while (true) {
                  const { done, value } = await reader.read()
                  
                  if (done) {
                    console.log(`[PROXY] Stream complete - re-assembling JSON`)
                    break
                  }
                  
                  // First real data received - stop heartbeats
                  if (!firstChunkReceived) {
                    firstChunkReceived = true
                    if (heartbeatTimer) clearInterval(heartbeatTimer)
                    console.log(`[PROXY] First chunk received - stopping heartbeat`)
                  }
                  
                  const chunkText = decoder.decode(value, { stream: true })
                  chunks.push(chunkText)
                  totalBytes += value.length
                  chunkCount++
                  
                  // Send heartbeat to client during data transfer too
                  // (keeps connection warm for long responses)
                  if (chunkCount % 10 === 0) {
                    controller.enqueue(encoder.encode(HEARTBEAT_BYTE))
                  }
                }
                
                // ─── RE-ASSEMBLE JSON FROM SSE ─────────────────────────
                const fullSSE = chunks.join('')
                const messages: any[] = []
                
                // Parse SSE chunks
                for (const line of fullSSE.split('\n')) {
                  if (line.startsWith('data: ')) {
                    const data = line.slice(6).trim()
                    if (data === '[DONE]') continue
                    
                    try {
                      const parsed = JSON.parse(data)
                      if (parsed.choices?.[0]?.delta?.content) {
                        messages.push(parsed.choices[0].delta.content)
                      }
                      // Also capture tool calls if present
                      if (parsed.choices?.[0]?.delta?.tool_calls) {
                        // Handle tool calls in reassembly
                      }
                    } catch {}
                  }
                }
                
                // Build final OpenAI-compatible JSON response
                const finalJson = {
                  id: `chatcmpl-${Date.now()}`,
                  object: 'chat.completion',
                  created: Math.floor(Date.now() / 1000),
                  model: requestBody.model || 'unknown',
                  choices: [{
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: messages.join('')
                    },
                    finish_reason: 'stop'
                  }],
                  usage: {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0
                  }
                }
                
                const duration = Date.now() - startTime
                console.log(`[PROXY] ← ${response.status} (${duration}ms, ${chunkCount} chunks, re-assembled ${JSON.stringify(finalJson).length} bytes JSON)`)
                
                // Send final JSON (this is the last "part" of the response)
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalJson)}\n\n`))
                controller.enqueue(encoder.encode('data: [DONE]\n\n'))
                
              } catch (e) {
                console.log(`[PROXY] Stream error during re-assembly: ${e}`)
                if (heartbeatTimer) clearInterval(heartbeatTimer)
              } finally {
                controller.close()
              }
            }
          }),
          {
            status: response.status,
            headers: {
              'Content-Type': 'text/event-stream',  // Still SSE because we streamed heartbeats
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'Access-Control-Allow-Origin': '*',
            }
          }
        )
      }
      
    } catch (error) {
      console.error(`[PROXY] ERROR: ${error}`)
      return c.json({ error: String(error) }, 502)
    }
  }
})

// ─── EXPORT ───────────────────────────────────────────────────────────────────

// For Bun standalone
export default {
  port: 3091,
  hostname: '0.0.0.0',
  fetch: app.fetch,
}

// For Cloudflare Workers / Vercel Edge
export { app }
