import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import OpenAI from "openai";
import type { Config, ServMode } from "../config.js";
import { promptGuard, shadowAgent, type FunctionTool, type ShadowAgentOptions } from "./tools.js";

export interface ReasonRequest {
  /** Stable label used for logs, the cache key and the mock responder, e.g. "plan". */
  purpose: string;
  model: string;
  /** SERV rejects requests without a system prompt. */
  system: string;
  user: string;
  /** Declare serv_prompt_guard on this request. */
  guard?: boolean;
  /** Declare serv_shadow_agent, optionally with a validation hint. */
  shadow?: boolean | ShadowAgentOptions;
  maxTokens?: number;
  /** Skip the response cache, e.g. for health probes that must reach SERV. */
  noCache?: boolean;
}

export interface ReasonResult {
  text: string;
  model: string;
  /** Completion id; matches the request in the SERV console Activity view. */
  requestId: string | undefined;
  finishReason: string | undefined;
  mode: ServMode;
  cached: boolean;
  usage: { inputTokens: number | undefined; outputTokens: number | undefined } | undefined;
  latencyMs: number;
  /** The untouched response body, kept for the audit trail. */
  raw: unknown;
}

export interface ServClient {
  readonly mode: ServMode;
  reason(request: ReasonRequest): Promise<ReasonResult>;
}

export class ServError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly purpose: string,
  ) {
    super(message);
    this.name = "ServError";
  }
}

/** The slice of a chat completion PurseStrings reads. */
export interface ChatCompletionLike {
  id?: string;
  model?: string;
  choices: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

export interface ChatCompletionBody {
  model: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
  tools?: FunctionTool[];
  max_tokens?: number;
}

export type CreateCompletion = (body: ChatCompletionBody) => Promise<ChatCompletionLike>;

export type MockResponder = (request: ReasonRequest) => string;

export const defaultMockResponders: Record<string, MockResponder> = {
  ping: () => "pong",
};

export function buildBody(request: ReasonRequest): ChatCompletionBody {
  if (!request.system.trim()) throw new ServError("SERV requires a system prompt", 400, request.purpose);
  if (!request.user.trim()) throw new ServError("request has no user content", 400, request.purpose);
  const tools: FunctionTool[] = [];
  if (request.guard) tools.push(promptGuard());
  if (request.shadow) tools.push(shadowAgent(request.shadow === true ? {} : request.shadow));
  const body: ChatCompletionBody = {
    model: request.model,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ],
  };
  if (tools.length > 0) body.tools = tools;
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
  return body;
}

export function cacheKey(body: ChatCompletionBody): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

interface CacheEntry {
  savedAt: string;
  purpose: string;
  result: Omit<ReasonResult, "cached" | "latencyMs">;
}

class FileCache {
  constructor(private readonly dir: string) {}

  async get(key: string): Promise<CacheEntry | undefined> {
    try {
      return JSON.parse(await readFile(join(this.dir, `${key}.json`), "utf8")) as CacheEntry;
    } catch {
      return undefined;
    }
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${key}.json`), JSON.stringify(entry, null, 2));
  }
}

export interface ServClientOptions {
  /** Overrides the network call; used by tests. */
  create?: CreateCompletion;
  mockResponders?: Record<string, MockResponder>;
  now?: () => number;
}

export function createServClient(config: Config, options: ServClientOptions = {}): ServClient {
  const now = options.now ?? Date.now;
  const cache = config.serv.cache ? new FileCache(join(config.stateDir, "serv-cache")) : undefined;

  if (config.serv.mode === "mock") {
    const responders = { ...defaultMockResponders, ...options.mockResponders };
    return {
      mode: "mock",
      async reason(request) {
        const body = buildBody(request);
        const responder = responders[request.purpose];
        const text = responder ? responder(request) : `[mock SERV, no responder for "${request.purpose}"]`;
        return {
          text,
          model: body.model,
          requestId: `mock_${cacheKey(body).slice(0, 12)}`,
          finishReason: "stop",
          mode: "mock",
          cached: false,
          usage: undefined,
          latencyMs: 0,
          raw: { mock: true, body },
        };
      },
    };
  }

  const create: CreateCompletion =
    options.create ??
    (() => {
      const client = new OpenAI({ baseURL: config.serv.baseURL, apiKey: config.serv.apiKey });
      return (body) => client.chat.completions.create(body as never) as Promise<ChatCompletionLike>;
    })();

  return {
    mode: "live",
    async reason(request) {
      const body = buildBody(request);
      const key = cacheKey(body);
      const useCache = cache !== undefined && !request.noCache;
      if (useCache) {
        const hit = await cache.get(key);
        if (hit) return { ...hit.result, cached: true, latencyMs: 0 };
      }
      const started = now();
      let response: ChatCompletionLike;
      try {
        response = await create(body);
      } catch (error) {
        const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : undefined;
        const message = error instanceof Error ? error.message : String(error);
        throw new ServError(`SERV ${request.purpose} call failed: ${message}`, status, request.purpose);
      }
      const choice = response.choices[0];
      const result: Omit<ReasonResult, "cached" | "latencyMs"> = {
        text: choice?.message?.content ?? "",
        model: response.model ?? body.model,
        requestId: response.id,
        finishReason: choice?.finish_reason ?? undefined,
        mode: "live",
        usage: response.usage
          ? { inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens }
          : undefined,
        raw: response,
      };
      const latencyMs = now() - started;
      if (useCache) await cache.set(key, { savedAt: new Date().toISOString(), purpose: request.purpose, result });
      return { ...result, cached: false, latencyMs };
    },
  };
}
