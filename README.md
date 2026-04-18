# Nvidia API Key Rotation Proxy (TypeScript)

OpenAI-compatible proxy for Nvidia API with automatic key rotation on 429 errors. Built with Hono for multi-platform deployment.

## Features

- ✅ OpenAI-compatible API proxy
- ✅ Automatic key rotation on 429 (circular)
- ✅ **Keep-Alive Stream Relay** - prevents gateway timeouts
- ✅ Streaming support (SSE)
- ✅ HTTP/2 ready (on supported platforms)
- ✅ CORS enabled
- ✅ Multi-platform: Bun, Cloudflare Workers, Vercel Edge

## Quick Start

### Run locally with Bun

```bash
bun install
bun run src/index.ts
```

## Deploy

### Cloudflare Workers (Recommended)

1. Install Wrangler CLI:
```bash
npm install -g wrangler
```

2. Login to Cloudflare:
```bash
wrangler login
```

3. Deploy:
```bash
wrangler deploy
```

Your proxy will be live at `https://nvidia-key-proxy.<your-subdomain>.workers.dev`

### Vercel Edge

1. Install Vercel CLI:
```bash
npm install -g vercel
```

2. Deploy:
```bash
vercel
```

### Fly.io / Railway / Render

For Docker-based deployments, create a Dockerfile:

```dockerfile
FROM oven/bun:1
WORKDIR /app
COPY package*.json ./
RUN bun install
COPY . .
EXPOSE 3091
CMD ["bun", "run", "src/index.ts"]
```

## Keep-Alive Stream Relay

**Problem**: Serverless platforms (Vercel, Cloudflare Workers) have strict timeout limits. Long-running AI requests get killed before completion.

**Solution**: The Keep-Alive Stream Relay tricks the gateway into thinking the request is moving, even while the model is "thinking."

### How It Works

| Phase | What Happens |
|-------|--------------|
| **1. Immediate Flush** | Return HTTP 200 and send headers immediately. This resets the "Initial Response" timer in the gateway. |
| **2. Forced Streaming** | Always request streaming from upstream, even if client wants JSON. |
| **3. Synthetic Heartbeat** | Send invisible SSE comments (`: keep-alive`) every 3 seconds while waiting for first chunk. Keeps TCP connection "hot". |
| **4. Buffer Re-assembly** | If client wanted JSON, collect all stream chunks internally and send final JSON at the end. |

### Protocol Details

```
Client Request → Proxy
                    ↓
         [Immediate 200 OK + Headers]
                    ↓
         [Heartbeat every 3s: ": keep-alive"]
                    ↓
         [First AI chunk arrives]
                    ↓
         [Stop heartbeat, stream data]
                    ↓
         [Stream complete]
                    ↓
         If JSON client → Re-assemble and send final JSON
         If Stream client → Already sent, just close
```

### Why This Works

| Gateway Limitation | Keep-Alive Solution |
|--------------------|---------------------|
| "Initial response must arrive within 10s" | Headers sent immediately |
| "Connection idle for 5s = timeout" | Heartbeat every 3s |
| "Total request time max 60s" | Can extend with ongoing data |

### Invisible Heartbeat

The heartbeat uses SSE comments which are ignored by clients:

```
: keep-alive

: keep-alive

data: {"id":"real-data"...}
```

Clients parsing SSE will skip the `:` lines as comments, so the heartbeat is invisible.

## Usage

| Setting | Value |
|---------|-------|
| **Base URL** | `https://nvidia-key-rotation-proxy-ts.vercel.app/v1` |
| **API Key** | Any string (e.g., `sk-test`) |
| **Model** | Any Nvidia model |

### ⚠️ Important: Use Streaming for Long Responses

**Vercel Edge has a 25-second execution limit.** For long responses (coding sessions, essays, etc.), use `stream: true`:

```json
{
  "model": "z-ai/glm4.7",
  "messages": [...],
  "stream": true  // ← Required for long responses
}
```

Non-streaming responses work fine for short queries but may be cut off for long outputs due to Vercel's timeout.

### Non-streaming

```bash
curl -X POST https://your-url/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer any-key" \
  -d '{"model": "stepfun-ai/step-3.5-flash", "messages": [{"role": "user", "content": "Hello"}]}'
```

### Streaming

```bash
curl -X POST https://your-url/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer any-key" \
  -d '{"model": "stepfun-ai/step-3.5-flash", "messages": [{"role": "user", "content": "Hello"}], "stream": true}'
```

## Configuration

Edit `src/index.ts` to add your API keys:

```typescript
const API_KEYS: string[] = [
  'nvapi-FirstKeyHere',
  'nvapi-SecondKeyHere',
  // Add more keys...
]
```

Adjust heartbeat timing:

```typescript
const HEARTBEAT_INTERVAL_MS = 3000  // 3 seconds (default)
```

## Key Rotation Logic

1. Request sent with current key (starts at key 1)
2. If 429 received, rotate to next key and retry
3. Continue cycling through all keys
4. If all keys exhausted, return 429

## Platform Comparison

| Platform | Free Tier | Persistence | HTTP/2 | Max Timeout | Notes |
|----------|-----------|-------------|--------|-------------|-------|
| **Cloudflare Workers** | ✅ 100k req/day | KV (paid) | ✅ | 30s CPU | Best free option |
| **Vercel Edge** | ✅ 100GB bandwidth | Edge Config | ✅ | 60s | Easy deploy |
| **Bun (VPS)** | ❌ | In-memory | ✅ | Unlimited | Full control |
| **Fly.io** | ✅ 3 VMs | Volume | ✅ | Unlimited | Docker-based |

## Files

- `src/index.ts` - Main proxy server with keep-alive relay
- `wrangler.toml` - Cloudflare Workers config
- `vercel.json` - Vercel Edge config

## License

MIT
