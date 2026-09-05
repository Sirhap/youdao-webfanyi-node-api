# Youdao Webfanyi Node API

本地 Node.js 服务，将有道网页端 LLM SSE 转为 OpenAI 风格的 `/v1/chat/completions` 接口。

它不依赖浏览器、Cookie、CLI Proxy 或手动 API Key。每次请求动态获取临时凭据并在内存中计算签名；凭据不会返回给客户端或写入磁盘。

## Requirements

- Node.js 20+
- 能访问 `https://luna-ai.youdao.com`

## Run

```bash
npm start
```

默认监听 `http://127.0.0.1:8787`。

```bash
curl http://127.0.0.1:8787/health
```

## Chat completion

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "DeepSeek-V4",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'
```

传入 `"stream": true` 可获得 OpenAI 风格 SSE。

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listener host. Keep this local unless you add your own authentication. |
| `PORT` | `8787` | Listener port. |
| `CORS_ORIGIN` | `*` | Allowed browser origin. |
| `YOUDAO_ORIGIN` | `https://luna-ai.youdao.com` | Override only for controlled testing. |

## Notes

This is a local protocol adapter for the Youdao web client, not an official Youdao API. The upstream endpoint and request protocol may change. Do not expose this service on a public network without adding authentication, rate limiting, and access controls.
