/**
 * Nvidia API Key Rotation Proxy - TypeScript/Hono
 * 
 * Deployable to: Bun, Cloudflare Workers, Vercel Edge
 * 
 * Features:
 * - OpenAI-compatible API proxy
 * - Automatic key rotation on 429
 * - Streaming support
 * - CORS enabled
 */

import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { cors } from 'hono/cors'

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const BASE_URL = 'https://integrate.api.nvidia.com'

// Add 2-5 API keys here. Keys are rotated circularly when a 429 is received.
const API_KEYS: string[] = [
  'YOUR_KEY_1',
  'YOUR_KEY_2',
  // Add more keys here
]

// Key state (for serverless, this resets on each cold start - use KV for persistence)
let currentKeyIndex = 0
const keyRotationLock = new Set<number>()

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
    stats: { totalRequests, total429s }
  })
})

// Proxy all /v1/* requests to Nvidia
app.all('/v1/*', async (c) => {
  totalRequests++
  const startTime = Date.now()
  
  // Extract path after /v1 (e.g., /v1/chat/completions -> /chat/completions)
  const path = c.req.path.startsWith('/v1') ? c.req.path.slice(3) : c.req.path
  const method = c.req.method
  const url = `${BASE_URL}/v1${path}`
  
  // Track which keys we've tried
  const triedKeys = new Set<number>()
  let currentIdx = currentKeyIndex
  
  // Get request body
  const body = method !== 'GET' ? await c.req.arrayBuffer() : undefined
  
  // Build headers (forward all except host/connection)
  const buildHeaders = (keyIndex: number): Headers => {
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
    
    return headers
  }
  
  console.log(`[PROXY] ${method} ${path} → key=${currentIdx + 1}/${API_KEYS.length}`)
  
  // Retry loop for key rotation
  while (true) {
    triedKeys.add(currentIdx)
    
    try {
      const headers = buildHeaders(currentIdx)
      
      // Make request to Nvidia
      const response = await fetch(url, {
        method,
        headers,
        body,
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
      
      // Check if streaming (SSE)
      const contentType = response.headers.get('content-type') || ''
      const isStreaming = contentType.includes('text/event-stream')
      
      if (isStreaming) {
        console.log(`[PROXY] Streaming response...`)
        
        // Stream the response
        const reader = response.body?.getReader()
        if (!reader) {
          return c.text('No body', 500)
        }
        
        // Set up streaming response
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
                
                const duration = Date.now() - startTime
                console.log(`[PROXY] ← ${response.status} (${duration}ms, ${chunkCount} chunks, ${totalBytes} bytes)`)
              } catch (e) {
                console.log(`[PROXY] Stream error: ${e}`)
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
        // Non-streaming - just forward the response
        const responseBody = await response.arrayBuffer()
        const duration = Date.now() - startTime
        
        console.log(`[PROXY] ← ${response.status} (${duration}ms, ${responseBody.byteLength} bytes)`)
        
        // Forward headers
        const responseHeaders = new Headers()
        response.headers.forEach((value, key) => {
          if (!['transfer-encoding', 'connection', 'keep-alive'].includes(key.toLowerCase())) {
            responseHeaders.set(key, value)
          }
        })
        responseHeaders.set('Access-Control-Allow-Origin', '*')
        
        return new Response(responseBody, {
          status: response.status,
          headers: responseHeaders
        })
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
