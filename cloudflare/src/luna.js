import { createHash } from "node:crypto";

/**
 * OpenAI-compatible Youdao Luna proxy used by the Cloudflare Worker.
 * `server.mjs` stays the localhost entry and is not imported here.
 * Named exports stay in this module. The Worker entry only default-exports a fetch handler.
 */

const bootstrapKey = "EZAmCfVOH2CrBGMtPrtIPUzyv3bheLdk";
const maxRequestBytes = 1024 * 1024;
const defaultYoudaoOrigin = "https://luna-ai.youdao.com";

/**
 * Placeholder rejected at runtime so a public deploy cannot ship the example secret.
 * @type {string}
 */
export const unconfiguredGatewayToken = "replace-with-a-long-random-string";

/**
 * Model id returned by `/v1/models` and chat completions.
 * The upstream model answers as DeepSeek V3.
 */
const exposedModelId = "DeepSeek-V3";

/**
 * Internal luna-ai function name sent upstream.
 * Clients never see this id; they use {@link exposedModelId}.
 */
const upstreamFunctionName = "deepseek_r1";

/**
 * Request ids that select the single upstream model.
 * `DeepSeek-V4` is accepted only so older clients keep working, and every response reports DeepSeek-V3.
 * @type {ReadonlySet<string>}
 */
const acceptedModelIds = new Set([exposedModelId, "DeepSeek-V4"]);

/**
 * Isolate-lifetime visitor id. Generated on the first request because Workers
 * disallow random values in global scope.
 * @type {string}
 */
let visitorId = "";

/**
 * Build a 32-char hex visitor id, matching the local server's 16 random bytes.
 * @returns {string}
 */
function createVisitorId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Reuse one visitor id for the life of this isolate.
 * @returns {string}
 */
function getVisitorId() {
  if (!visitorId) visitorId = createVisitorId();
  return visitorId;
}

/**
 * Resolve a client model id to the public DeepSeek-V3 id.
 * @param {unknown} requested Model from the OpenAI-style body. Empty selects the default.
 * @returns {string}
 */
export function resolveExposedModel(requested) {
  if (requested == null || requested === "") return exposedModelId;
  if (typeof requested === "string" && acceptedModelIds.has(requested)) return exposedModelId;
  throw new Error(`Unknown model. Available model: ${exposedModelId}`);
}

/**
 * Build the signed parameters required by the luna-ai chat endpoints.
 * @param {Record<string, unknown>} extra
 * @param {string} signingKey
 * @param {string} keyId
 * @param {string} keyfrom
 * @param {string} [client]
 * @returns {Record<string, unknown>}
 */
export function createSignedParams(extra, signingKey, keyId, keyfrom, client = "web") {
  const params = {
    product: "webfanyi", appVersion: "12.0.0", client, mid: 1, vendor: "web", screen: 1, model: 1, imei: 1,
    network: "wifi", keyfrom, keyid: keyId, mysticTime: Date.now(), yduuid: getVisitorId(), abtest: 0, ...extra,
  };
  const names = Object.keys(params).filter((name) => params[name] !== "" && params[name] !== undefined).sort();
  const canonical = names.map((name) => `${name}=${params[name]}`).join("&");
  params.sign = createHash("md5").update(`${canonical}&key=${signingKey}`).digest("hex");
  params.pointParam = `${names.join(",")},key`;
  return params;
}

/**
 * Request fresh ephemeral credentials without persisting them.
 * @param {string} youdaoOrigin
 * @returns {Promise<{ token: string, secretKey: string }>}
 */
async function fetchCredentials(youdaoOrigin) {
  const params = createSignedParams({ keyid: "ai-translate-llm-pre" }, bootstrapKey, "ai-translate-llm-pre", "fanyi.web", "fanyideskweb");
  const response = await fetch(`${youdaoOrigin}/translate_llm/secret?${new URLSearchParams(stringifyParams(params))}`);
  const payload = await response.json();
  if (!response.ok || payload.code !== 0 || !payload.data?.token || !payload.data?.secretKey) {
    throw new Error(`Credential request failed (HTTP ${response.status})`);
  }
  return { token: payload.data.token, secretKey: payload.data.secretKey };
}

/**
 * Create an upstream task id for the current completion request.
 * @param {string} youdaoOrigin
 * @param {string} token
 * @param {string} secretKey
 * @returns {Promise<string>}
 */
async function createTaskId(youdaoOrigin, token, secretKey) {
  const params = createSignedParams({ token }, secretKey, "ai-translate-llm", "fanyi.web");
  const response = await fetch(`${youdaoOrigin}/translate_llm/v3/uuid/generate?${new URLSearchParams(stringifyParams(params))}`);
  const payload = await response.json();
  if (!response.ok || payload.code !== 0 || !payload.data?.id) throw new Error(`Task creation failed (HTTP ${response.status})`);
  return payload.data.id;
}

/**
 * Copy signed params into strings for URLSearchParams.
 * Signing itself still uses the original values.
 * @param {Record<string, unknown>} params
 * @returns {Record<string, string>}
 */
function stringifyParams(params) {
  return Object.fromEntries(Object.entries(params).map(([name, value]) => [name, String(value)]));
}

/**
 * Collapse OpenAI-style messages into the upstream input field.
 * @param {Array<{ role?: string, content: string }>} messages
 * @returns {string}
 */
export function createInput(messages) {
  return messages.map((message) => `${message.role === "assistant" ? "助手" : "用户"}：${message.content}`).join("\n\n").slice(-12000);
}

/**
 * Create a correctly signed multipart request for the upstream chat endpoint.
 * @param {{ messages: Array<{ role?: string, content: string }>, token: string, secretKey: string, taskId: string }} input
 * @returns {FormData}
 */
export function createChatForm({ messages, token, secretKey, taskId }) {
  const params = createSignedParams({
    token, functionEnglishName: upstreamFunctionName, input: encodeURIComponent(createInput(messages)), useTerm: 0,
    free: false, singleBox: false, fromLang: "auto", id: taskId, roundNo: 1, showSuggest: 0, source: "webaitrans",
  }, secretKey, "ai-translate-llm", "webfanyi.webaitrans", "webaitrans");
  const form = new FormData();
  Object.entries(params).forEach(([name, value]) => form.append(name, String(value)));
  return form;
}

/**
 * Parse upstream SSE while exposing only answer content to callers.
 * @param {Response} upstream
 * @param {(content: string) => void} onContent
 * @returns {Promise<void>}
 */
export async function readYoudaoStream(upstream, onContent) {
  if (!upstream.body) throw new Error("Upstream chat failed (HTTP 502)");
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
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
  } finally {
    reader.releaseLock();
  }
}

/**
 * Obtain an upstream SSE response for valid OpenAI-style messages.
 * @param {string} youdaoOrigin
 * @param {Array<{ role?: string, content: string }>} messages
 * @returns {Promise<Response>}
 */
async function requestCompletion(youdaoOrigin, messages) {
  const { token, secretKey } = await fetchCredentials(youdaoOrigin);
  const taskId = await createTaskId(youdaoOrigin, token, secretKey);
  const upstream = await fetch(`${youdaoOrigin}/translate_llm/v3/chat`, {
    method: "POST",
    body: createChatForm({ messages, token, secretKey, taskId }),
  });
  if (!upstream.ok || !upstream.body) throw new Error(`Upstream chat failed (HTTP ${upstream.status})`);
  return upstream;
}

/**
 * Read and validate a JSON request under the configured size limit.
 * @param {Request} request
 * @returns {Promise<{ messages: Array<{ role?: string, content: string }>, stream: boolean, model: string }>}
 */
async function readJsonRequest(request) {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxRequestBytes) throw new Error("Request body exceeds 1 MB");
  const raw = await request.arrayBuffer();
  if (raw.byteLength > maxRequestBytes) throw new Error("Request body exceeds 1 MB");
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON";
    throw new Error(message.includes("JSON") ? message : `Invalid JSON: ${message}`);
  }
  const messages = Array.isArray(payload.messages)
    ? payload.messages.filter((message) => message && typeof message.content === "string")
    : [];
  if (!messages.length) throw new Error("messages must contain at least one text message");
  return { messages, stream: payload.stream !== false, model: resolveExposedModel(payload.model) };
}

/**
 * Compare two strings without leaking the match index through early return.
 * @param {string} provided
 * @param {string} expected
 * @returns {boolean}
 */
function tokensMatch(provided, expected) {
  const encoder = new TextEncoder();
  const left = encoder.encode(provided);
  const right = encoder.encode(expected);
  const length = Math.max(left.byteLength, right.byteLength);
  let diff = left.byteLength === right.byteLength ? 0 : 1;
  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

/**
 * Require a configured Bearer token before any public API route.
 * @param {Request} request
 * @param {string | undefined} gatewayToken
 * @param {string} corsOrigin
 * @returns {Response | null}
 */
function authorize(request, gatewayToken, corsOrigin) {
  if (!gatewayToken || gatewayToken === unconfiguredGatewayToken) {
    return writeJson(503, {
      error: { message: "GATEWAY_TOKEN is not configured", type: "server_error" },
    }, corsOrigin);
  }
  const header = request.headers.get("Authorization") ?? "";
  const prefix = "Bearer ";
  const provided = header.startsWith(prefix) ? header.slice(prefix.length) : "";
  if (!provided || !tokensMatch(provided, gatewayToken)) {
    return writeJson(401, {
      error: { message: "Invalid or missing Bearer token", type: "invalid_request_error" },
    }, corsOrigin);
  }
  return null;
}

/**
 * @param {Headers} headers
 * @param {string} corsOrigin
 */
function applyBaseHeaders(headers, corsOrigin) {
  headers.set("Access-Control-Allow-Origin", corsOrigin);
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Cache-Control", "no-store");
}

/**
 * Write a JSON response with a stable OpenAI-style error shape.
 * @param {number} status
 * @param {unknown} payload
 * @param {string} corsOrigin
 * @returns {Response}
 */
function writeJson(status, payload, corsOrigin) {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  applyBaseHeaders(headers, corsOrigin);
  return new Response(JSON.stringify(payload), { status, headers });
}

/**
 * @param {string} corsOrigin
 * @returns {Response}
 */
function emptyCors(corsOrigin) {
  const headers = new Headers();
  applyBaseHeaders(headers, corsOrigin);
  return new Response(null, { status: 204, headers });
}

/**
 * Serve OpenAI-compatible SSE output.
 * @param {string} youdaoOrigin
 * @param {Array<{ role?: string, content: string }>} messages
 * @param {string} model
 * @param {string} corsOrigin
 * @returns {Promise<Response>}
 */
async function streamCompletion(youdaoOrigin, messages, model, corsOrigin) {
  const upstream = await requestCompletion(youdaoOrigin, messages);
  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      const send = (payload) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };
      try {
        await readYoudaoStream(upstream, (content) => {
          send({
            id: completionId,
            object: "chat.completion.chunk",
            model,
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          });
        });
        send({
          id: completionId,
          object: "chat.completion.chunk",
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  const headers = new Headers({ "Content-Type": "text/event-stream; charset=utf-8" });
  applyBaseHeaders(headers, corsOrigin);
  return new Response(body, { status: 200, headers });
}

/**
 * Serve a non-streaming OpenAI-compatible completion response.
 * @param {string} youdaoOrigin
 * @param {Array<{ role?: string, content: string }>} messages
 * @param {string} model
 * @param {string} corsOrigin
 * @returns {Promise<Response>}
 */
async function completeOnce(youdaoOrigin, messages, model, corsOrigin) {
  let content = "";
  await readYoudaoStream(await requestCompletion(youdaoOrigin, messages), (chunk) => { content += chunk; });
  return writeJson(200, {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  }, corsOrigin);
}

/**
 * Route the Worker API without exposing upstream credentials.
 * @param {Request} request
 * @param {{ GATEWAY_TOKEN?: string, YOUDAO_ORIGIN?: string, CORS_ORIGIN?: string }} [env]
 * @returns {Promise<Response>}
 */
export async function handleRequest(request, env = {}) {
  const corsOrigin = env.CORS_ORIGIN || "*";
  const youdaoOrigin = (env.YOUDAO_ORIGIN || defaultYoudaoOrigin).replace(/\/$/, "");
  try {
    if (request.method === "OPTIONS") return emptyCors(corsOrigin);
    const authFailure = authorize(request, env.GATEWAY_TOKEN, corsOrigin);
    if (authFailure) return authFailure;
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return writeJson(200, { status: "ok", upstream: "youdao-luna" }, corsOrigin);
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return writeJson(200, {
        object: "list",
        data: [{ id: exposedModelId, object: "model", owned_by: "youdao-luna" }],
      }, corsOrigin);
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      const { messages, stream, model } = await readJsonRequest(request);
      if (stream) return await streamCompletion(youdaoOrigin, messages, model, corsOrigin);
      return await completeOnce(youdaoOrigin, messages, model, corsOrigin);
    }
    return writeJson(404, { error: { message: "Not found", type: "invalid_request_error" } }, corsOrigin);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    const status = /messages|Request body|JSON|Unknown model/.test(message) ? 400 : 502;
    return writeJson(status, {
      error: { message, type: status === 400 ? "invalid_request_error" : "upstream_error" },
    }, corsOrigin);
  }
}
