import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import worker from "./index.js";
import {
  createChatForm,
  createInput,
  createSignedParams,
  handleRequest,
  readYoudaoStream,
  resolveExposedModel,
  unconfiguredGatewayToken,
} from "./luna.js";

const gatewayToken = "test-gateway-token";
const env = {
  GATEWAY_TOKEN: gatewayToken,
  YOUDAO_ORIGIN: "https://luna-ai.youdao.com",
  CORS_ORIGIN: "*",
};

/**
 * @param {string} path
 * @param {RequestInit & { token?: string | null }} [init]
 * @returns {Request}
 */
function apiRequest(path, init = {}) {
  const headers = new Headers(init.headers);
  if (init.token !== null) headers.set("Authorization", `Bearer ${init.token ?? gatewayToken}`);
  return new Request(`https://worker.test${path}`, { ...init, headers });
}

/**
 * @param {unknown} payload
 * @param {number} [status]
 * @returns {Response}
 */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Install a fetch mock that replays the three luna-ai calls.
 * @param {string} sseBody
 * @returns {{ urls: string[], chatBody: FormData | null, restore: () => void }}
 */
function mockUpstream(sseBody) {
  const urls = [];
  /** @type {FormData | null} */
  let chatBody = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    urls.push(href);
    if (href.includes("/translate_llm/secret")) {
      return jsonResponse({ code: 0, data: { token: "upstream-token", secretKey: "upstream-secret" } });
    }
    if (href.includes("/translate_llm/v3/uuid/generate")) {
      return jsonResponse({ code: 0, data: { id: "task-1" } });
    }
    if (href.includes("/translate_llm/v3/chat")) {
      chatBody = init.body instanceof FormData ? init.body : null;
      return new Response(sseBody, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error(`Unexpected upstream URL ${href}`);
  };
  return {
    urls,
    get chatBody() { return chatBody; },
    restore() { globalThis.fetch = originalFetch; },
  };
}

test("model ids collapse to DeepSeek-V3", () => {
  assert.equal(resolveExposedModel(undefined), "DeepSeek-V3");
  assert.equal(resolveExposedModel(""), "DeepSeek-V3");
  assert.equal(resolveExposedModel("DeepSeek-V3"), "DeepSeek-V3");
  assert.equal(resolveExposedModel("DeepSeek-V4"), "DeepSeek-V3");
  assert.throws(() => resolveExposedModel("gpt-4o"), /Unknown model/);
});

test("input keeps the assistant label and only the last 12000 characters", () => {
  const tail = "TAIL";
  const content = `H${"a".repeat(13000)}${tail}`;
  const input = createInput([
    { role: "user", content: "hi" },
    { role: "assistant", content },
  ]);
  assert.equal(input.length, 12000);
  assert.equal(input.endsWith(tail), true);
  assert.match(createInput([{ role: "assistant", content: "pong" }]), /^助手：/);
  assert.match(createInput([{ role: "system", content: "ping" }]), /^用户：/);
});

test("signature is the md5 of the sorted canonical parameter string", () => {
  const originalNow = Date.now;
  Date.now = () => 1700000000000;
  try {
    const params = createSignedParams({ token: "tok" }, "secret-key", "ai-translate-llm", "fanyi.web");
    const names = Object.keys(params)
      .filter((name) => name !== "sign" && name !== "pointParam" && params[name] !== "" && params[name] !== undefined)
      .sort();
    const canonical = names.map((name) => `${name}=${params[name]}`).join("&");
    const expected = createHash("md5").update(`${canonical}&key=secret-key`).digest("hex");
    assert.equal(params.sign, expected);
    assert.equal(params.pointParam, `${names.join(",")},key`);
    assert.equal(params.client, "web");
    assert.equal(params.keyfrom, "fanyi.web");
  } finally {
    Date.now = originalNow;
  }
});

test("chat form targets deepseek_r1 and encodes the collapsed input", () => {
  const form = createChatForm({
    messages: [{ role: "user", content: "你好" }],
    token: "upstream-token",
    secretKey: "upstream-secret",
    taskId: "task-1",
  });
  assert.equal(form.get("functionEnglishName"), "deepseek_r1");
  assert.equal(form.get("input"), encodeURIComponent("用户：你好"));
  assert.equal(form.get("id"), "task-1");
  assert.equal(form.get("keyid"), "ai-translate-llm");
  assert.equal(form.get("keyfrom"), "webfanyi.webaitrans");
  assert.equal(form.get("client"), "webaitrans");
  assert.equal(form.get("source"), "webaitrans");
  assert.equal(form.get("free"), "false");
  assert.ok(form.get("sign"));
  assert.ok(form.get("pointParam"));
});

test("SSE reader emits message content and skips other events", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("event: mes"));
      controller.enqueue(encoder.encode("sage\ndata: {\"content\":\"你\"}\n\nevent: end\ndata: {\"content\":\"skip\"}\n\n"));
      controller.enqueue(encoder.encode("event: message\ndata: {\"content\":\"好\"}\n\n"));
      controller.close();
    },
  });
  const chunks = [];
  await readYoudaoStream(new Response(stream), (content) => chunks.push(content));
  assert.deepEqual(chunks, ["你", "好"]);
});

test("missing or placeholder GATEWAY_TOKEN refuses every API route", async () => {
  for (const token of [undefined, "", unconfiguredGatewayToken]) {
    const response = await handleRequest(apiRequest("/health"), { GATEWAY_TOKEN: token });
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.equal(payload.error.type, "server_error");
  }
});

test("Bearer token is required on health, models, and chat", async () => {
  const health = await handleRequest(apiRequest("/health", { token: null }), env);
  assert.equal(health.status, 401);
  const wrong = await handleRequest(apiRequest("/v1/models", { token: "nope" }), env);
  assert.equal(wrong.status, 401);
  const options = await handleRequest(apiRequest("/v1/chat/completions", { method: "OPTIONS", token: null }), env);
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("Access-Control-Allow-Headers"), "Content-Type, Authorization");
});

test("health and models match the local proxy", async () => {
  const health = await handleRequest(apiRequest("/health"), env);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", upstream: "youdao-luna" });
  const models = await worker.fetch(apiRequest("/v1/models"), env);
  assert.deepEqual(await models.json(), {
    object: "list",
    data: [{ id: "DeepSeek-V3", object: "model", owned_by: "youdao-luna" }],
  });
});

test("non-stream chat aggregates upstream SSE into one completion", async () => {
  const upstream = mockUpstream("event: message\ndata: {\"content\":\"你\"}\n\nevent: message\ndata: {\"content\":\"好\"}\n\n");
  try {
    const response = await handleRequest(apiRequest("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "DeepSeek-V4",
        messages: [{ role: "user", content: "你好" }],
        tools: [{ type: "function", function: { name: "noop" } }],
        stream: false,
      }),
    }), env);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type") ?? "", /^application\/json/);
    const payload = await response.json();
    assert.equal(payload.object, "chat.completion");
    assert.equal(payload.model, "DeepSeek-V3");
    assert.equal(payload.choices[0].message.content, "你好");
    assert.equal(payload.choices[0].finish_reason, "stop");
    assert.equal("usage" in payload, false);
    assert.equal("tool_calls" in payload.choices[0].message, false);
    assert.equal(upstream.urls.length, 3);
    assert.match(upstream.urls[0], /\/translate_llm\/secret\?/);
    assert.match(upstream.urls[1], /\/translate_llm\/v3\/uuid\/generate\?/);
    assert.match(upstream.urls[2], /\/translate_llm\/v3\/chat$/);
    const secret = new URL(upstream.urls[0]);
    assert.equal(secret.searchParams.get("keyid"), "ai-translate-llm-pre");
    assert.equal(secret.searchParams.get("client"), "fanyideskweb");
    assert.ok(secret.searchParams.get("sign"));
    assert.equal(upstream.chatBody?.get("functionEnglishName"), "deepseek_r1");
  } finally {
    upstream.restore();
  }
});

test("omitted stream defaults to OpenAI SSE and ends with DONE", async () => {
  const upstream = mockUpstream("data: {\"content\":\"OK\"}\n\n");
  try {
    const response = await handleRequest(apiRequest("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "DeepSeek-V3", messages: [{ role: "user", content: "hi" }] }),
    }), env);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type") ?? "", /^text\/event-stream/);
    const text = await response.text();
    assert.match(text, /"object":"chat.completion.chunk"/);
    assert.match(text, /"content":"OK"/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    upstream.restore();
  }
});

test("bad client input is 400 and upstream failure is 502", async () => {
  const unknown = await handleRequest(apiRequest("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
  }), env);
  assert.equal(unknown.status, 400);
  const imageOnly = await handleRequest(apiRequest("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", content: [{ type: "image_url", image_url: "x" }] }] }),
  }), env);
  assert.equal(imageOnly.status, 400);
  const huge = await handleRequest(apiRequest("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(maxRequestBytes()) }] }),
  }), env);
  assert.equal(huge.status, 400);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ code: 1 }, 500);
  try {
    const failed = await handleRequest(apiRequest("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], stream: false }),
    }), env);
    assert.equal(failed.status, 502);
    const payload = await failed.json();
    assert.equal(payload.error.type, "upstream_error");
    const streamed = await handleRequest(apiRequest("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], stream: true }),
    }), env);
    assert.equal(streamed.status, 502);
    assert.match(streamed.headers.get("Content-Type") ?? "", /^application\/json/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/**
 * Body larger than the proxy limit, still valid enough to parse if it were accepted.
 * @returns {number}
 */
function maxRequestBytes() {
  return 1024 * 1024 + 32;
}
