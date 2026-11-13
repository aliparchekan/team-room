// Spike against real T3 threads: launch, idempotent launch retry, send,
// idempotent send retry, read, interrupt (stop), and send-after-stop.
// Uses Scratch threads and trivial prompts. Writes data/thread-spike.json.
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { T3Connection, resolveT3McpUrl } from "../server/t3/connection.js";
import { CALLBACK_URL, CREDENTIALS_FILE, DATA_DIR } from "../server/config.js";

const conn = new T3Connection(resolveT3McpUrl(), CREDENTIALS_FILE, CALLBACK_URL);
const st = await conn.connect();
if (st.kind !== "connected") throw new Error(`not connected: ${JSON.stringify(st)}`);
const out: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);

async function waitRun(threadId: string, runId: string, maxMs = 240_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const r: any = await conn.call("t3_thread_read", { threadId, runLimit: 10, limit: 50, maxCharsPerItem: 2000 });
    const run = r.recentRuns.find((x: any) => x.runId === runId);
    if (run && TERMINAL.has(run.status)) return r;
    await sleep(2000);
  }
  throw new Error("timeout");
}

for (const [instanceId, model] of [
  ["claudeAgent", "claude-haiku-5-5"],
  ["codex", "gpt-6-luna"],
] as const) {
  const key = `spike-launch-${instanceId}-${randomUUID()}`;
  const args = { scratch: true, title: `Team Room spike — ${instanceId}`, modelSelection: { instanceId, model }, clientRequestId: key };
  const l1: any = await conn.call("t3_thread_launch", args);
  const l2: any = await conn.call("t3_thread_launch", args);
  console.log(instanceId, "launch", l1.threadId, "retry same id ->", l2.threadId, "link", l1.link);
  const sendKey = `spike-send-${randomUUID()}`;
  const s1: any = await conn.call("t3_thread_send", { threadId: l1.threadId, message: "Reply with exactly the word PONG and nothing else.", mode: "queue", clientRequestId: sendKey });
  const s2: any = await conn.call("t3_thread_send", { threadId: l1.threadId, message: "Reply with exactly the word PONG and nothing else.", mode: "queue", clientRequestId: sendKey });
  console.log(instanceId, "send", JSON.stringify(s1), "\n   retry same id ->", JSON.stringify(s2));
  const r: any = await waitRun(l1.threadId, s1.runId);
  console.log(instanceId, "thread status", r.thread.status, "runCount", r.thread.runCount, "pending", r.thread.pendingRequestCount, "worktree", r.thread.worktreePath);
  for (const it of r.items) console.log("   item", it.position, it.type, it.runId, it.createdBy, it.creationSource, JSON.stringify((it.text ?? "").slice(0, 80)));
  out[instanceId] = { launch: l1, launchRetry: l2, send: s1, sendRetry: s2, read: r };
}

// Interrupt: start a longer turn on Codex, stop it, observe, then send again.
const cx: any = (out.codex as any).launch;
const long: any = await conn.call("t3_thread_send", { threadId: cx.threadId, message: "Count slowly from 1 to 400, one number per line, thinking about each.", mode: "queue", clientRequestId: `spike-long-${randomUUID()}` });
await sleep(4000);
const intr: any = await conn.call("t3_thread_interrupt", { threadId: cx.threadId, stop: true, reason: "Team Room spike" });
console.log("interrupt ->", JSON.stringify(intr));
const seen: string[] = [];
for (let i = 0; i < 20; i++) {
  const r: any = await conn.call("t3_thread_read", { threadId: cx.threadId, runLimit: 5, limit: 1 });
  const run = r.recentRuns.find((x: any) => x.runId === long.runId);
  seen.push(`${run?.status}/${r.thread.status}`);
  if (run && TERMINAL.has(run.status)) break;
  await sleep(1500);
}
console.log("after interrupt statuses:", seen.join(" → "));
const after: any = await conn.call("t3_thread_send", { threadId: cx.threadId, message: "Reply with exactly the word AGAIN.", mode: "queue", clientRequestId: `spike-after-${randomUUID()}` });
console.log("send after stop ->", JSON.stringify(after));
const r2: any = await waitRun(cx.threadId, after.runId, 120_000).catch((e) => ({ error: String(e) }));
console.log("send-after-stop run:", r2.error ?? r2.recentRuns.find((x: any) => x.runId === after.runId)?.status);
out.interrupt = { long, intr, seen, after };
fs.writeFileSync(`${DATA_DIR}/thread-spike.json`, JSON.stringify(out, null, 2));
await conn.close();
