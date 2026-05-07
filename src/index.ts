/**
 * Nvidia API Key Rotation Proxy - TypeScript/Hono
 * 
 * Deployable to: Bun, Cloudflare Workers, Vercel Edge
 *
 * Normalization: some models emit thinking as `<think>` tags inside content,
 * others use the proper `reasoning_content` SSE field. This proxy normalizes
 * both patterns into `reasoning_content` so clients get a consistent format.
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

/**
 * Extract <think>...</think> blocks from a string.
 * Returns { content, reasoning } with tags removed from content.
 */
function extractThinkTags(text: string): { content: string; reasoning: string } {
  const reasoningParts: string[] = []
  // Extract all <think>...</think> blocks (non-greedy, may span lines)
  const content = text.replace(/<think>([\s\S]*?)<\/think>/g, (_match, thinkContent) => {
    reasoningParts.push(thinkContent.trim())
    return ''
  }).trim()
  return { content, reasoning: reasoningParts.join('\n') }
}

/**
 * Streaming <think> tag normalizer.
 * Maintains state across chunks since tags can be split across SSE events.
 * Routes content to content deltas and thinking to reasoning_content deltas.
 */
class ThinkTagNormalizer {
  private buffer = ''
  private inThink = false

  /**
   * Feed a content chunk. Returns an array of { field, text } to emit.
   * field is 'content' or 'reasoning_content'.
   */
  feed(chunk: string): Array<{ field: 'content' | 'reasoning_content'; text: string }> {
    const results: Array<{ field: 'content' | 'reasoning_content'; text: string }> = []
    this.buffer += chunk

    while (this.buffer.length > 0) {
      if (!this.inThink) {
        // Look for <think> opening tag
        const thinkStart = this.buffer.indexOf('<think>')
        if (thinkStart === -1) {
          // No think tag — emit all as content (but keep last 7 chars in case of partial tag)
          // "<think>" is 7 chars, so a chunk ending mid-tag is possible
          const safeLen = Math.max(0, this.buffer.length - 7)
          if (safeLen > 0) {
            results.push({ field: 'content', text: this.buffer.slice(0, safeLen) })
            this.buffer = this.buffer.slice(safeLen)
          }
          break
        } else {
          // Emit content before the tag
          if (thinkStart > 0) {
            results.push({ field: 'content', text: this.buffer.slice(0, thinkStart) })
          }
          this.buffer = this.buffer.slice(thinkStart + 7) // skip "<think>"
          this.inThink = true
        }
      } else {
        // Inside <think> — look for </think> closing tag
        const thinkEnd = this.buffer.indexOf('</think>')
        if (thinkEnd === -1) {
          // No close tag yet — emit all as reasoning (keep last 8 chars for partial "</think>")
          const safeLen = Math.max(0, this.buffer.length - 8)
          if (safeLen > 0) {
            results.push({ field: 'reasoning_content', text: this.buffer.slice(0, safeLen) })
            this.buffer = this.buffer.slice(safeLen)
          }
          break
        } else {
          // Emit reasoning content before the close tag
          if (thinkEnd > 0) {
            results.push({ field: 'reasoning_content', text: this.buffer.slice(0, thinkEnd) })
          }
          this.buffer = this.buffer.slice(thinkEnd + 8) // skip "</think>"
          this.inThink = false
        }
      }
    }

    return results
  }

  /** Flush any remaining buffer at stream end */
  flush(): Array<{ field: 'content' | 'reasoning_content'; text: string }> {
    const results: Array<{ field: 'content' | 'reasoning_content'; text: string }> = []
    if (this.buffer.length > 0) {
      results.push({ field: this.inThink ? 'reasoning_content' : 'content', text: this.buffer })
      this.buffer = ''
      this.inThink = false
    }
    return results
  }
}

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

  // Pass reasoning_content through to NVIDIA in outgoing messages (don't strip it).
  // Models benefit from seeing their own chain-of-thought across turns.

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
      
      modifiedBody.temperature = 1.0
      modifiedBody.top_p = 0.95
      
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
        const normalizer = new ThinkTagNormalizer()

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

                  const text = decoder.decode(value, { stream: true })
                  const lines = text.split('\n')
                  const normalizedLines: string[] = []

                  for (const line of lines) {
                    if (line.startsWith('data: ') && !line.includes('[DONE]')) {
                      try {
                        const data = JSON.parse(line.slice(6))
                        const delta = data.choices?.[0]?.delta

                        if (delta) {
                          // Remove non-standard 'reasoning' field (some models emit this)
                          if ('reasoning' in delta) {
                            delete delta.reasoning
                          }

                          // Pass through proper reasoning_content from NVIDIA API as-is
                          // (models like stepfun use this field natively)
                          const nativeReasoning = delta.reasoning_content

                          // Normalize <think> tags from content → reasoning_content
                          if (delta.content && typeof delta.content === 'string' && delta.content.includes('<think>')) {
                            const parts = normalizer.feed(delta.content)
                            // Replace the content chunk with normalized output
                            delta.content = null
                            delta.reasoning_content = null

                            for (const part of parts) {
                              // Build a new SSE event for each part
                              const partData = JSON.parse(JSON.stringify(data))
                              const partDelta = partData.choices[0].delta
                              if (part.field === 'content') {
                                partDelta.content = part.text
                                partDelta.reasoning_content = null
                              } else {
                                partDelta.content = null
                                partDelta.reasoning_content = part.text
                              }
                              normalizedLines.push('data: ' + JSON.stringify(partData))
                            }
                          } else if (nativeReasoning) {
                            // Native reasoning_content — pass through unchanged
                            normalizedLines.push('data: ' + JSON.stringify(data))
                          } else {
                            // Regular content chunk — pass through
                            normalizedLines.push('data: ' + JSON.stringify(data))
                          }
                        } else {
                          normalizedLines.push(line)
                        }
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
                  chunkCount++
                }

                // Flush normalizer at stream end
                const remaining = normalizer.flush()
                if (remaining.length > 0) {
                  for (const part of remaining) {
                    const flushEvent = JSON.stringify({
                      id: `chatcmpl-flush-${Date.now()}`,
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model: requestBody.model || 'unknown',
                      choices: [{ index: 0, delta: { content: null, reasoning_content: null, [part.field]: part.text }, finish_reason: null }]
                    })
                    controller.enqueue(encoder.encode(`data: ${flushEvent}\n`))
                  }
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
          const contentParts: string[] = []
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
                    contentParts.push(delta.content)
                  }
                  if (delta.reasoning_content) {
                    reasoningParts.push(delta.reasoning_content)
                  }
                }
              } catch {
                // Skip malformed lines
              }
            }
          }

          // Assemble raw content and extract any <think> tags
          const rawContent = contentParts.join('')
          const { content: cleanContent, reasoning: thinkReasoning } = extractThinkTags(rawContent)

          // Combine: reasoning from <think> tags + reasoning from reasoning_content field
          const allReasoning = [thinkReasoning, ...reasoningParts].filter(r => r.length > 0).join('\n')

          const finalJson: any = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: requestBody.model || 'unknown',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: cleanContent || rawContent,  // fallback to raw if extraction failed
              },
              finish_reason: 'stop'
            }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
          }

          // Include reasoning_content if we have any
          if (allReasoning.length > 0) {
            finalJson.choices[0].message.reasoning_content = allReasoning
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
