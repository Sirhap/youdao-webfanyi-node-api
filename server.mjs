import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);
const corsOrigin = process.env.CORS_ORIGIN ?? "*";
const youdaoOrigin = process.env.YOUDAO_ORIGIN ?? "https://luna-ai.youdao.com";
const bootstrapKey = "EZAmCfVOH2CrBGMtPrtIPUzyv3bheLdk";
const visitorId = randomBytes(16).toString("hex");
const maxRequestBytes = 1024 * 1024;

/** Build the signed parameters required by the webfanyi LLM endpoints. */
function createSignedParams(extra, signingKey, keyId, keyfrom, client = "web") {
  const params = {
    product: "webfanyi", appVersion: "12.0.0", client, mid: 1, vendor: "web", screen: 1, model: 1, imei: 1,
    network: "wifi", keyfrom, keyid: keyId, mysticTime: Date.now(), yduuid: visitorId, abtest: 0, ...extra,
  };
  const names = Object.keys(params).filter((name) => params[name] !== "" && params[name] !== undefined).sort();
  const canonical = names.map((name) => `${name}=${params[name]}`).join("&");
  params.sign = createHash("md5").update(`${canonical}&key=${signingKey}`).digest("hex");
  params.pointParam = `${names.join(",")},key`;
  return params;
}

/** Request fresh ephemeral credentials without persisting them to disk. */
async function fetchCredentials() {
  const params = createSignedParams({ keyid: "ai-translate-llm-pre" }, bootstrapKey, "ai-translate-llm-pre", "fanyi.web", "fanyideskweb");
  const response = await fetch(`${youdaoOrigin}/translate_llm/secret?${new URLSearchParams(params)}`);
  const payload = await response.json();
  if (!response.ok || payload.code !== 0 || !payload.data?.token || !payload.data?.secretKey) throw new Error(`Credential request failed (HTTP ${response.status})`);
  return { token: payload.data.token, secretKey: payload.data.secretKey };
}

/** Create an upstream task id for the current completion request. */
async function createTaskId(token, secretKey) {
  const params = createSignedParams({ token }, secretKey, "ai-translate-llm", "fanyi.web");
  const response = await fetch(`${youdaoOrigin}/translate_llm/v3/uuid/generate?${new URLSearchParams(params)}`);
  const payload = await response.json();
  if (!response.ok || payload.code !== 0 || !payload.data?.id) throw new Error(`Task creation failed (HTTP ${response.status})`);
  return payload.data.id;
}

/** Collapse OpenAI-style messages into the webfanyi input field. */
function createInput(messages) {
  return messages.map((message) => `${message.role === "assistant" ? "助手" : "用户"}：${message.content}`).join("\n\n").slice(-12000);
}

/** Create a correctly signed multipart request for the upstream chat endpoint. */
function createChatForm({ messages, token, secretKey, taskId }) {
  const params = createSignedParams({
    token, functionEnglishName: "deepseek_r1", input: encodeURIComponent(createInput(messages)), useTerm: 0,
    free: false, singleBox: false, fromLang: "auto", id: taskId, roundNo: 1, showSuggest: 0, source: "webaitrans",
  }, secretKey, "ai-translate-llm", "webfanyi.webaitrans", "webaitrans");
  const form = new FormData();
  Object.entries(params).forEach(([name, value]) => form.append(name, String(value)));
  return form;
}

/** Parse webfanyi SSE while exposing only answer content to callers. */
async function readYoudaoStream(upstream, onContent) {
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const normalized = line.replace(/\r$/, "");
      if (!normalized) { eventName = "message"; continue; }
      if (normalized.startsWith("event:")) { eventName = normalized.slice(6).trim(); continue; }
      if (!normalized.startsWith("data:") || eventName !== "message") continue;
      try {
        const payload = JSON.parse(normalized.slice(5).trim());
        if (payload.content) onContent(payload.content);
      } catch { /* Ignore incomplete or non-JSON SSE events. */ }
    }
  }
}

/** Obtain an upstream SSE response for valid OpenAI-style messages. */
async function requestCompletion(messages) {
  const { token, secretKey } = await fetchCredentials();
  const taskId = await createTaskId(token, secretKey);
  const upstream = await fetch(`${youdaoOrigin}/translate_llm/v3/chat`, { method: "POST", body: createChatForm({ messages, token, secretKey, taskId }) });
  if (!upstream.ok || !upstream.body) throw new Error(`Upstream chat failed (HTTP ${upstream.status})`);
  return upstream;
}

/** Read and validate a JSON request under the configured size limit. */
async function readJsonRequest(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxRequestBytes) throw new Error("Request body exceeds 1 MB");
    chunks.push(chunk);
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const messages = Array.isArray(payload.messages) ? payload.messages.filter((message) => message && typeof message.content === "string") : [];
  if (!messages.length) throw new Error("messages must contain at least one text message");
  return { messages, stream: payload.stream !== false, model: payload.model ?? "DeepSeek-V4" };
}

/** Set safe CORS and no-cache headers for API responses. */
function setBaseHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", corsOrigin);
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Cache-Control", "no-store");
}

/** Write a JSON response with a stable OpenAI-style error shape. */
function writeJson(response, status, payload) {
  setBaseHeaders(response);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

/** Serve OpenAI-compatible SSE output. */
async function streamCompletion(response, messages, model) {
  const upstream = await requestCompletion(messages);
  const completionId = `chatcmpl-${randomUUID()}`;
  setBaseHeaders(response);
  response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive" });
  await readYoudaoStream(upstream, (content) => {
    response.write(`data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
  });
  response.write(`data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  response.end("data: [DONE]\n\n");
}

/** Serve a non-streaming OpenAI-compatible completion response. */
async function completeOnce(response, messages, model) {
  let content = "";
  await readYoudaoStream(await requestCompletion(messages), (chunk) => { content += chunk; });
  writeJson(response, 200, { id: `chatcmpl-${randomUUID()}`, object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
}

/** Route the local API without exposing upstream credentials. */
const server = createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") { setBaseHeaders(response); response.writeHead(204); response.end(); return; }
    if (request.method === "GET" && request.url === "/health") { writeJson(response, 200, { status: "ok", upstream: "youdao-webfanyi" }); return; }
    if (request.method === "GET" && request.url === "/v1/models") { writeJson(response, 200, { object: "list", data: [{ id: "DeepSeek-V4", object: "model", owned_by: "youdao-webfanyi" }] }); return; }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      const { messages, stream, model } = await readJsonRequest(request);
      if (stream) await streamCompletion(response, messages, model); else await completeOnce(response, messages, model);
      return;
    }
    writeJson(response, 404, { error: { message: "Not found", type: "invalid_request_error" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    const status = /messages|Request body|JSON/.test(message) ? 400 : 502;
    if (!response.headersSent) writeJson(response, status, { error: { message, type: status === 400 ? "invalid_request_error" : "upstream_error" } });
    else response.end();
  }
});

server.listen(port, host, () => console.log(`Youdao API listening at http://${host}:${port}`));
