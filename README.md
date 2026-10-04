# Youdao Luna OpenAI Proxy

本地 OpenAI 兼容的聊天补全代理。它把有道网页端 LLM（[luna-ai](https://luna-ai.youdao.com)，模型回答为 DeepSeek V3）转成 `/v1/chat/completions`，供本机上的 OpenAI 客户端直接调用。

这不是有道官方 API，也不是翻译服务。不需要 API Key 或 Cookie。每次请求向 `https://luna-ai.youdao.com` 拉取临时凭据，只在内存里计算签名；凭据不会写到磁盘，也不会返回给客户端。

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

## Models

`GET /v1/models` 只列出一个模型：`DeepSeek-V3`。

```bash
curl http://127.0.0.1:8787/v1/models
```

```json
{
  "object": "list",
  "data": [
    { "id": "DeepSeek-V3", "object": "model", "owned_by": "youdao-luna" }
  ]
}
```

## Chat completions

`POST /v1/chat/completions` 使用 OpenAI 风格的请求体。省略 `stream` 或传入 `true` 时返回 SSE；传入 `false` 时一次返回完整 JSON。

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "DeepSeek-V3",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'
```

流式响应是 OpenAI 风格的 `chat.completion.chunk`，以 `data: [DONE]` 结束。把上面的 `"stream": false` 改成 `true`，或直接删掉该字段即可。

客户端应使用模型 id `DeepSeek-V3`。未知模型会返回 400。

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址。保持本机，除非你自己加上鉴权。 |
| `PORT` | `8787` | 监听端口。 |
| `CORS_ORIGIN` | `*` | 允许的浏览器来源。 |
| `YOUDAO_ORIGIN` | `https://luna-ai.youdao.com` | 仅在受控测试时覆盖上游地址。 |

## Notes

上游地址和请求协议可能随时变化，本仓库不保证长期兼容。不要把这个服务暴露到公网：默认没有鉴权。若必须对外提供，请自行加上认证、限流和访问控制。

当前能做什么、不能依赖什么，见 [docs/能力边界.md](docs/能力边界.md)。2026-10-04（Asia/Shanghai）的限额与压力测试见 [docs/压测报告.md](docs/压测报告.md)，原始日志见 [docs/evidence/youdao-luna-proxy-limit-test-2026-10-04.txt](docs/evidence/youdao-luna-proxy-limit-test-2026-10-04.txt)。那次实测可以作为单人日常代理，也撑住了测到的中等并发；不要信任大约 8k 字符以上的上下文。
