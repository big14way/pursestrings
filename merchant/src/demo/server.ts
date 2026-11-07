import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
// The agent, compiled to dist/ by the root build (npm install runs it).
import { loadConfig } from "../../../dist/config.js";
import { runTask, type RunEvent, type RunSummary } from "../../../dist/executor.js";
import { mockExplainResponder } from "../../../dist/explain.js";
import { createMerchantPreflight } from "../../../dist/kpass/merchant-preflight.js";
import { Passport } from "../../../dist/kpass/passport.js";
import { SimKpass } from "../../../dist/kpass/sim.js";
import { Ledger, type LedgerEntry } from "../../../dist/ledger.js";
import { mockPlanResponder } from "../../../dist/planner.js";
import { mockScreenResponder } from "../../../dist/screen.js";
import { createServClient } from "../../../dist/serv/client.js";
import { createSandbox, SANDBOX_MERCHANTS } from "./sandbox.ts";

/**
 * The hosted demo: a visitor runs the agent against the sandbox merchants and watches
 * it shop, refuse and explain, approving the spending limits themselves. Passport is
 * the built-in simulator and SERV runs in mock mode unless DEMO_SERV_MODE=live, so a
 * run costs nothing and moves nothing. Every run goes to one hash-chained ledger.
 */

export const DEFAULT_TASK = "Buy the cheapest 1GB data bundle under $0.50 for +2348012345678 and book a ride from Yaba to Victoria Island";

type Message = { type: "event"; event: RunEvent } | { type: "confirm"; question: string } | { type: "done"; summary: RunSummary } | { type: "error"; message: string };

interface DemoRun {
  id: string;
  task: string;
  createdAt: number;
  status: "running" | "waiting" | "done" | "error";
  messages: Message[];
  listeners: Set<(message: Message) => void>;
  answer?: (approved: boolean) => void;
  question?: string;
  summary?: RunSummary;
}

export interface DemoOptions {
  stateDir?: string;
  /** Seconds a run waits for the visitor to approve or decline before declining. */
  answerTimeoutSeconds?: number;
  maxActiveRuns?: number;
  runsPerIpPer10Min?: number;
  env?: Record<string, string | undefined>;
}

const PUBLIC_DIR = join(import.meta.dirname, "public");

export function createDemoApp(options: DemoOptions = {}) {
  const env = options.env ?? process.env;
  const stateDir = options.stateDir ?? join(tmpdir(), "pursestrings-demo");
  mkdirSync(stateDir, { recursive: true });
  const config = loadConfig({
    env: { PURSESTRINGS_STATE_DIR: stateDir, KPASS_MODE: "sim", SERV_MODE: env.DEMO_SERV_MODE === "live" ? "live" : "mock", SERV_API_KEY: env.DEMO_SERV_MODE === "live" ? env.SERV_API_KEY : undefined, SERV_CACHE: "0" },
    cwd: stateDir,
    resolveBin: () => undefined,
  });
  const serv = createServClient(config, { mockResponders: { plan: mockPlanResponder, explain: mockExplainResponder, screen: mockScreenResponder } });
  const ledger = new Ledger(join(stateDir, "ledger.jsonl"));
  const sandbox = createSandbox();
  const runs = new Map<string, DemoRun>();
  const recent = new Map<string, number[]>();
  const timeoutMs = (options.answerTimeoutSeconds ?? 180) * 1000;
  const maxActive = options.maxActiveRuns ?? 6;
  const perIp = options.runsPerIpPer10Min ?? 10;
  const readJson = (file: string): unknown => {
    try {
      return JSON.parse(readFileSync(join(import.meta.dirname, file), "utf8"));
    } catch {
      return null;
    }
  };
  // A real run of this demo with SERV live, so visitors can see SERV's own output.
  const recorded = readJson("recorded-run.json");
  const recordedStream = readJson("recorded-stream.json");

  const push = (run: DemoRun, message: Message) => {
    run.messages.push(message);
    for (const listener of run.listeners) listener(message);
  };

  const start = (task: string, redTeam: boolean): DemoRun => {
    const id = `run_demo_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
    const run: DemoRun = { id, task, createdAt: Date.now(), status: "running", messages: [], listeners: new Set() };
    runs.set(id, run);
    for (const [key, old] of runs) if (runs.size > 200 && old.status !== "running" && old.status !== "waiting") runs.delete(key);
    const passport = new Passport(new SimKpass({ preflight: createMerchantPreflight(sandbox.fetchFn) }));
    const confirm = (question: string) =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => settle(false), timeoutMs);
        const settle = (approved: boolean) => {
          clearTimeout(timer);
          run.answer = undefined;
          run.question = undefined;
          run.status = "running";
          resolve(approved);
        };
        run.answer = settle;
        run.question = question;
        run.status = "waiting";
        push(run, { type: "confirm", question });
      });
    runTask(
      { config, serv, passport, ledger, fetchFn: sandbox.fetchFn },
      { task, budgetUsd: "1.00", merchants: SANDBOX_MERCHANTS.map((m) => m.origin), confirm, onEvent: (event) => push(run, { type: "event", event }), runId: id, redTeam },
    ).then(
      (summary) => {
        run.summary = summary;
        run.status = "done";
        push(run, { type: "done", summary });
      },
      (error: unknown) => {
        run.status = "error";
        push(run, { type: "error", message: error instanceof Error ? error.message : String(error) });
      },
    );
    return run;
  };

  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true, serv: config.serv.mode, passport: "sim", merchants: SANDBOX_MERCHANTS.length }));

  app.get("/api/merchants", (c) => c.json({ merchants: SANDBOX_MERCHANTS, serv: config.serv.mode }));

  app.post("/api/runs", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { task?: unknown; redTeam?: unknown };
    const task = typeof body.task === "string" && body.task.trim() ? body.task.trim().slice(0, 240) : DEFAULT_TASK;
    const ip = (c.req.header("x-forwarded-for") ?? "local").split(",")[0]!.trim();
    const now = Date.now();
    const times = (recent.get(ip) ?? []).filter((t) => now - t < 600_000);
    if (times.length >= perIp) return c.json({ error: "Too many runs from here in the last 10 minutes. Try again shortly." }, 429);
    const active = [...runs.values()].filter((r) => r.status === "running" || r.status === "waiting").length;
    if (active >= maxActive) return c.json({ error: "The demo is busy. Try again in a minute." }, 503);
    times.push(now);
    recent.set(ip, times);
    const run = start(task, body.redTeam !== false);
    return c.json({ id: run.id, task: run.task }, 201);
  });

  app.get("/api/runs/:id", (c) => {
    const run = runs.get(c.req.param("id"));
    if (!run) return c.json({ error: "no such run" }, 404);
    return c.json({ id: run.id, task: run.task, status: run.status, question: run.question, messages: run.messages, summary: run.summary });
  });

  app.get("/api/runs/:id/events", (c) => {
    const run = runs.get(c.req.param("id"));
    if (!run) return c.json({ error: "no such run" }, 404);
    return streamSSE(c, async (stream) => {
      let resolveEnd: () => void = () => {};
      const ended = new Promise<void>((resolve) => (resolveEnd = resolve));
      const send = async (message: Message) => {
        await stream.writeSSE({ data: JSON.stringify(message) });
        if (message.type === "done" || message.type === "error") resolveEnd();
      };
      for (const message of run.messages) await send(message);
      if (run.status === "done" || run.status === "error") return;
      const listener = (message: Message) => void send(message);
      run.listeners.add(listener);
      stream.onAbort(() => resolveEnd());
      await ended;
      run.listeners.delete(listener);
    });
  });

  app.post("/api/runs/:id/answer", async (c) => {
    const run = runs.get(c.req.param("id"));
    if (!run) return c.json({ error: "no such run" }, 404);
    if (!run.answer) return c.json({ error: "this run is not waiting for an answer" }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { approve?: unknown };
    run.answer(body.approve === true);
    return c.json({ ok: true });
  });

  app.get("/api/runs/:id/ledger", async (c) => {
    const entries: LedgerEntry[] = await ledger.read(c.req.param("id"));
    return c.json({ entries, chain: await ledger.verify() });
  });

  app.get("/api/ledger/verify", async (c) => c.json(await ledger.verify()));

  app.get("/api/recorded", (c) => (recorded ? c.json(recorded) : c.json({ error: "no recorded run" }, 404)));
  app.get("/api/recorded-stream", (c) => (recordedStream ? c.json(recordedStream) : c.json({ error: "no recorded run" }, 404)));

  app.use("/*", serveStatic({ root: relative(process.cwd(), PUBLIC_DIR) || "." }));
  app.get("/", serveStatic({ path: join(relative(process.cwd(), PUBLIC_DIR) || ".", "index.html") }));
  return { app, ledger, runs };
}
