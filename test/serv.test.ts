import { describe, expect, it, vi } from "vitest";
import { buildBody, createServClient, ServError, type ChatCompletionBody, type ReasonRequest } from "../src/serv/client.js";
import { promptGuard, shadowAgent } from "../src/serv/tools.js";
import { testConfig } from "./helpers.js";

const request: ReasonRequest = { purpose: "plan", model: "claude-sonnet-5-serv-kronos", system: "You plan purchases.", user: "Buy a data bundle under 5 USD." };

describe("SERV tools", () => {
  it("declares the prompt guard by name only", () => {
    expect(promptGuard()).toEqual({ type: "function", function: { name: "serv_prompt_guard" } });
  });

  it("passes shadow agent options as schema defaults", () => {
    const tool = shadowAgent({ hint: "Name the cap.", maxIterations: 2 });
    expect(tool.function.name).toBe("serv_shadow_agent");
    expect(tool.function.parameters).toEqual({
      type: "object",
      properties: { hint: { type: "string", default: "Name the cap." }, max_iterations: { type: "integer", default: 2 } },
    });
  });

  it("rejects out-of-range shadow agent iterations", () => {
    expect(() => shadowAgent({ maxIterations: 0 })).toThrow();
    expect(() => shadowAgent({ maxIterations: 11 })).toThrow();
    expect(() => shadowAgent({ hint: " " })).toThrow();
  });
});

describe("buildBody", () => {
  it("always sends a system message and only the tools asked for", () => {
    expect(buildBody(request)).toEqual({
      model: request.model,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
    });
    const guarded = buildBody({ ...request, guard: true, shadow: { hint: "Give a budget." }, maxTokens: 300 });
    expect(guarded.tools?.map((t) => t.function.name)).toEqual(["serv_prompt_guard", "serv_shadow_agent"]);
    expect(guarded.max_tokens).toBe(300);
  });

  it("fails locally without a system prompt, as SERV would with a 400", () => {
    expect(() => buildBody({ ...request, system: "  " })).toThrow(ServError);
  });
});

function completion(content: string) {
  return { id: "chatcmpl_1", model: "claude-sonnet-5", choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3 } };
}

describe("live client", () => {
  it("maps the completion and caches it on disk", async () => {
    const create = vi.fn(async (_body: ChatCompletionBody) => completion("plan text"));
    const client = createServClient(testConfig({ SERV_API_KEY: "k" }), { create });
    const first = await client.reason(request);
    expect(first).toMatchObject({ text: "plan text", requestId: "chatcmpl_1", finishReason: "stop", mode: "live", cached: false, usage: { inputTokens: 10, outputTokens: 3 } });
    const second = await client.reason(request);
    expect(second.cached).toBe(true);
    expect(second.text).toBe("plan text");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("bypasses the cache when asked", async () => {
    const create = vi.fn(async () => completion("pong"));
    const client = createServClient(testConfig({ SERV_API_KEY: "k" }), { create });
    await client.reason({ ...request, noCache: true });
    await client.reason({ ...request, noCache: true });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("wraps API errors with their HTTP status", async () => {
    const create = vi.fn(async () => {
      throw Object.assign(new Error("Missing or invalid API key"), { status: 401 });
    });
    const client = createServClient(testConfig({ SERV_API_KEY: "bad" }), { create });
    await expect(client.reason(request)).rejects.toMatchObject({ name: "ServError", status: 401, purpose: "plan" });
  });
});

describe("mock client", () => {
  it("answers registered purposes without network access", async () => {
    const client = createServClient(testConfig(), { mockResponders: { plan: () => "mock plan" } });
    expect(client.mode).toBe("mock");
    await expect(client.reason(request)).resolves.toMatchObject({ text: "mock plan", mode: "mock" });
    await expect(client.reason({ ...request, purpose: "ping" })).resolves.toMatchObject({ text: "pong" });
  });

  it("still enforces the system prompt rule", async () => {
    const client = createServClient(testConfig());
    await expect(client.reason({ ...request, system: "" })).rejects.toThrow(ServError);
  });
});
