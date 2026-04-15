# Nvidia API Key Rotation Proxy (TypeScript)

OpenAI-compatible proxy for Nvidia API with automatic key rotation on 429 errors. Built with Hono for multi-platform deployment.

## Features

- ✅ OpenAI-compatible API proxy
- ✅ Automatic key rotation on 429 (circular)
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

## Usage

| Setting | Value |
|---------|-------|
| **Base URL** | `https://your-deployment-url/v1` |
| **API Key** | Any string (e.g., `sk-test`) |
| **Model** | Any Nvidia model |

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

## Key Rotation Logic

1. Request sent with current key (starts at key 1)
2. If 429 received, rotate to next key and retry
3. Continue cycling through all keys
4. If all keys exhausted, return 429

## Platform Comparison

| Platform | Free Tier | Persistence | HTTP/2 | Notes |
|----------|-----------|-------------|--------|-------|
| **Cloudflare Workers** | ✅ 100k req/day | KV (paid) | ✅ | Best free option |
| **Vercel Edge** | ✅ 100GB bandwidth | Edge Config | ✅ | Easy deploy |
| **Bun (VPS)** | ❌ | In-memory | ✅ | Full control |
| **Fly.io** | ✅ 3 VMs | Volume | ✅ | Docker-based |

## Files

- `src/index.ts` - Main proxy server
- `wrangler.toml` - Cloudflare Workers config
- `vercel.json` - Vercel Edge config

## License

MIT
