# Youdao Luna OpenAI Proxy

本地 OpenAI 风格的聊天代理。它只提供三个接口：`GET /health`、`GET /v1/models`、`POST /v1/chat/completions`。上游是有道网页 LLM（[luna-ai](https://luna-ai.youdao.com)，函数名 `deepseek_r1`，回答为 DeepSeek V3）。这不是有道官方 API，也不是翻译服务。

不需要 API Key 或 Cookie。每次请求向 `https://luna-ai.youdao.com` 拉取临时凭据，只在内存里计算签名；凭据不会写到磁盘，也不会返回给客户端。

本机仍用下面的 `npm start`。公网 API 见 [Cloudflare 一键部署](#cloudflare-一键部署)。

## 能力边界

可以接到 Codex 等客户端，当作纯聊天模型使用。工具调用、画图、子 agent、上下文压缩这些高级能力，需要客户端自己或其他正规 API 提供。本代理不实现它们。

明确不支持：

- `tools` / `function_call`（工具调用）
- 画图、图像生成，以及多模态输入输出
- 子 agent / 多 agent 编排 API
- 服务端上下文压缩。超长对话只硬截最后 12000 个字符，前缀直接丢掉
- `max_tokens`、`usage`，以及按 model id 路由到不同的真实上游模型
- Codex 等客户端的高级能力（新绘画、子 agent、压缩上下文等）。这里只能当纯聊天后端

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

上游地址和请求协议可能随时变化，本仓库不保证长期兼容。本地 `npm start` 默认没有鉴权，只监听 `127.0.0.1`。公网入口是下面的 Cloudflare Worker，并且必须配置 `GATEWAY_TOKEN`。

当前能做什么、不能依赖什么，见 [docs/能力边界.md](docs/能力边界.md)。2026-10-04（Asia/Shanghai）的限额与压力测试见 [docs/压测报告.md](docs/压测报告.md)，原始日志见 [docs/evidence/youdao-luna-proxy-limit-test-2026-10-04.txt](docs/evidence/youdao-luna-proxy-limit-test-2026-10-04.txt)。那次实测可以作为单人日常代理，也撑住了测到的中等并发；不要信任大约 8k 字符以上的上下文。

## Cloudflare 一键部署

`cloudflare/` 是独立的 Workers 项目，提供同一套 HTTP API：`GET /health`、`GET /v1/models`、`POST /v1/chat/completions`。对外模型 id 是 `DeepSeek-V3`（请求里的 `DeepSeek-V4` 也会按 `DeepSeek-V3` 返回）。上游仍是有道网页 LLM，函数名 `deepseek_r1`。本地 `server.mjs` 和 `npm start` 保持不变。

不支持 `tools` / `function_call`、图像和多模态。12000 字截断、没有 `usage`、不读取 `max_tokens`，这些与本地代理相同，见 [docs/能力边界.md](docs/能力边界.md)。

Workers 出口不一定能访问 `https://luna-ai.youdao.com`。连不上时接口返回 502，继续用本地 `npm start`。

公网必须设置密钥 `GATEWAY_TOKEN`。没有这个密钥，或者仍使用仓库里的占位符 `replace-with-a-long-random-string` 时，`/health`、`/v1/models`、`/v1/chat/completions` 返回 503，避免变成没有鉴权的开放代理。客户端这样带口令：

```text
Authorization: Bearer <GATEWAY_TOKEN>
```

用 `openssl rand -hex 32` 生成口令。把它放进 Cloudflare 的 Secret，或本地的 `cloudflare/.dev.vars`。不要写进 `wrangler.toml`，也不要提交到 git。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Sirhap/youdao-webfanyi-node-api/tree/main/cloudflare)

点击按钮后，Cloudflare 把 `cloudflare/` 当作独立 Worker 仓库克隆到你的 GitHub，并要求填写 `GATEWAY_TOKEN`。源仓库需要保持公开，其他人才能使用这个按钮。部署页的 Build command 留空，Deploy command 使用 `npx wrangler deploy`。Worker 名称填 `youdao-luna-openai-proxy`，与 `cloudflare/wrangler.toml` 的 `name` 一致。

也可以在 Cloudflare 控制台把当前这个 GitHub 仓库接上 Workers Builds：

1. 打开 [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages)，选择 Create → Import a repository。已有 Worker 时，进入该 Worker 的 Settings → Builds → Connect。
2. 授权 GitHub 后选择 `Sirhap/youdao-webfanyi-node-api`，生产分支填 `main`。
3. Root directory 填 `cloudflare`。Build command 留空。Deploy command 填 `npx wrangler deploy`。
4. Worker 名称必须是 `youdao-luna-openai-proxy`。名称和 `wrangler.toml` 里的 `name` 不一致时，构建会失败。
5. 在 Variables and Secrets 里把 `GATEWAY_TOKEN` 存成 Secret。仓库外也可以执行 `npx wrangler secret put GATEWAY_TOKEN`。
6. 保存后，推送到 `main` 会触发部署。

`YOUDAO_ORIGIN` 和 `CORS_ORIGIN` 已写在 `cloudflare/wrangler.toml`，一般不用改。

```bash
curl https://youdao-luna-openai-proxy.<account>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "DeepSeek-V3",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'
```

省略 `stream` 或传入 `true` 时，响应为 `text/event-stream`，以 `data: [DONE]` 结束。

在本机调试 Worker 时，进入 `cloudflare/`，复制 `.dev.vars.example` 为 `.dev.vars`，把口令换成自己的，再执行 `npx wrangler dev`。这不会改动 `server.mjs`。
