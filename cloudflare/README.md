# Youdao Luna OpenAI Proxy (Cloudflare Workers)

OpenAI 兼容的 HTTP API，部署在 Cloudflare Workers 上。它提供 `GET /health`、`GET /v1/models`、`POST /v1/chat/completions`。对外模型 id 是 `DeepSeek-V3`。上游是有道网页 LLM `https://luna-ai.youdao.com`，函数名 `deepseek_r1`。

这是 API 代理。仓库里的本地 Node 入口仍是上一级的 `server.mjs`（`npm start`），本目录不修改它。

能力边界与本地代理相同：不支持 `tools` / `function_call`、图像和多模态，对话只保留最后 12000 个字符，没有 `usage`。说明见源仓库 [docs/能力边界.md](https://github.com/Sirhap/youdao-webfanyi-node-api/blob/main/docs/%E8%83%BD%E5%8A%9B%E8%BE%B9%E7%95%8C.md)。

Workers 所在网络不一定能访问有道。上游失败时接口返回 502，此时继续用本地 Node。

## 鉴权

公网必须配置密钥 `GATEWAY_TOKEN`。未配置或仍是 `replace-with-a-long-random-string` 时，接口返回 503。

```text
Authorization: Bearer <GATEWAY_TOKEN>
```

在 Cloudflare 控制台的 Worker → Settings → Variables and Secrets 中把 `GATEWAY_TOKEN` 存成 Secret。命令行可以用 `npx wrangler secret put GATEWAY_TOKEN`。不要把口令写进 `wrangler.toml`。

一键部署页面会读取 `.dev.vars.example`，把占位符换成 `openssl rand -hex 32` 的结果。

## 部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Sirhap/youdao-webfanyi-node-api/tree/main/cloudflare)

Build command 留空。Deploy command 使用 `npx wrangler deploy`。Worker 名称使用 `youdao-luna-openai-proxy`，与 `wrangler.toml` 里的 `name` 一致。

从包含本目录的源仓库连接 Git 时，Root directory 填 `cloudflare`。步骤写在源仓库 README 的「Cloudflare 一键部署」。

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

本地调试：

```bash
cp .dev.vars.example .dev.vars
npx wrangler dev
```
