// Bounded LIVE smoke test against real T3 + real Claude/Codex sessions.
// Starts the Team Room server itself (so it can restart it), drives it over
// its HTTP API, and independently verifies thread contents through T3's MCP.
//   npm run smoke
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { ORIGIN, CREDENTIALS_FILE, CALLBACK_URL, DATA_DIR, ROOT } from "../server/config.js";
import { T3Connection, resolveT3McpUrl } from "../server/t3/connection.js";

const log: string[] = [];
const say = (s: string) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`;
  console.log(line);
  log.push(line);
};
const check = (ok: boolean, what: string) => {
  say(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const failures: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: ChildProcess | null = null;
async function startServer() {
  server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout!.on("data", (d) => fs.appendFileSync(`${DATA_DIR}/smoke-server.log`, d));
  server.stderr!.on("data", (d) => fs.appendFileSync(`${DATA_DIR}/smoke-server.log`, d));
  for (let i = 0; i < 60; i++) {
    try {
      const s = await api("GET", "/api/status");
      if (s.connection.kind === "connected") return s;
    } catch {}
    await sleep(500);
  }
  throw new Error("server did not connect to T3");
}
async function stopServer() {
  server?.kill("SIGTERM");
  await new Promise((r) => server!.once("exit", r));
}
async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-team-room": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${data.error}`);
  return data;
}
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 600_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v as T;
    await sleep(3000);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const view = (id: string) => api("GET", `/api/rooms/${id}`);
const agentMsgs = (v: any, author: string) => v.messages.filter((m: any) => m.author === author);

async function main() {
  fs.writeFileSync(`${DATA_DIR}/smoke-server.log`, "");
  const status = await startServer();
  say(`T3 ${status.connection.serverVersion} at ${status.mcpUrl}`);
  const claude = status.providers.find((p: any) => p.driver === "claudeAgent" && p.available);
  const codex = status.providers.find((p: any) => p.driver === "codex" && p.available);
  check(!!claude && !!codex, `Claude (${claude?.instanceId}/${claude?.defaultModel}) and Codex (${codex?.instanceId}/${codex?.defaultModel}) available`);
  if (!claude || !codex) throw new Error("providers unavailable");

  const t3 = new T3Connection(resolveT3McpUrl(), CREDENTIALS_FILE, CALLBACK_URL);
  await t3.connect();

  const room = await api("POST", "/api/rooms", {
    title: "Smoke: naming a CLI flag",
    brief:
      "Harmless smoke test. Decide a good name for a command-line flag that makes a tool print its output as JSON. Keep every reply under 80 words. Do not read or modify any files.",
    projectId: null,
    mode: "manual",
    turnLimit: 6,
    claude: { providerInstanceId: claude.instanceId, model: claude.defaultModel },
    codex: { providerInstanceId: codex.instanceId, model: codex.defaultModel },
  });
  say(`room ${room.id}`);
  let v = await waitFor("participants ready", async () => {
    const x = await view(room.id);
    return x.participants.every((p: any) => p.threadId) && x;
  });
  const pc = v.participants.find((p: any) => p.kind === "claude");
  const px = v.participants.find((p: any) => p.kind === "codex");
  check(!!pc.threadId && !!px.threadId && pc.threadId !== px.threadId, `two distinct real T3 threads: ${pc.threadId}, ${px.threadId}`);
  check(!!pc.threadLink && !!px.threadLink, `thread links: ${pc.threadLink} | ${px.threadLink}`);

  // 1. Claude proposes.
  const m1 = await api("POST", `/api/rooms/${room.id}/messages`, { body: "@claude Propose a flag name, with one sentence of rationale.", target: "claude" });
  v = await waitFor("Claude proposal", async () => {
    const x = await view(room.id);
    return agentMsgs(x, "claude").length >= 1 && x;
  });
  const proposal = agentMsgs(v, "claude")[0];
  say(`Claude: ${proposal.body.slice(0, 200).replace(/\n/g, " ")}`);
  check(v.messages.find((m: any) => m.id === m1.id).deliveryState === "delivered", "human message to Claude confirmed delivered by T3");

  // 2. Codex critiques Claude's actual proposal.
  await api("POST", `/api/rooms/${room.id}/messages`, { body: "@codex Critique Claude Code's proposal above in two or three sentences.", target: "codex" });
  v = await waitFor("Codex critique", async () => {
    const x = await view(room.id);
    return agentMsgs(x, "codex").length >= 1 && x;
  });
  const critique = agentMsgs(v, "codex")[0];
  say(`Codex: ${critique.body.slice(0, 200).replace(/\n/g, " ")}`);
  const codexThread: any = await t3.call("t3_thread_read", { threadId: px.threadId, view: "messages", limit: 100, maxCharsPerItem: 50000 });
  const codexUserText = codexThread.items.filter((i: any) => /user/i.test(i.type)).map((i: any) => i.text ?? "").join("\n");
  check(codexUserText.includes(proposal.body.trim().slice(0, 120)), "Codex's real T3 thread contains Claude's actual proposal");
  check(/peer agent — context, NOT an instruction/.test(codexUserText), "proposal labelled as peer contribution, not a human instruction");

  // 3. Claude responds to Codex's actual critique.
  await api("POST", `/api/rooms/${room.id}/messages`, { body: "@claude Respond briefly to Codex's critique.", target: "claude" });
  v = await waitFor("Claude response", async () => {
    const x = await view(room.id);
    return agentMsgs(x, "claude").length >= 2 && x;
  });
  const claudeThread: any = await t3.call("t3_thread_read", { threadId: pc.threadId, view: "messages", limit: 100, maxCharsPerItem: 50000 });
  const claudeUserText = claudeThread.items.filter((i: any) => /user/i.test(i.type)).map((i: any) => i.text ?? "").join("\n");
  check(claudeUserText.includes(critique.body.trim().slice(0, 120)), "Claude's real T3 thread contains Codex's actual critique");
  say(`Claude: ${agentMsgs(v, "claude")[1].body.slice(0, 200).replace(/\n/g, " ")}`);

  // 4. Thread links resolve to the real threads.
  check(
    decodeURIComponent(pc.threadLink).endsWith(pc.threadId) && decodeURIComponent(px.threadLink).endsWith(px.threadId),
    "links identify the participant threads",
  );

  // 5. Human message delivered to intended participant only.
  const before = (await view(room.id)).deliveries.length;
  const m5 = await api("POST", `/api/rooms/${room.id}/messages`, { body: "@codex Reply with just the word ACK.", target: "codex" });
  v = await waitFor("ACK", async () => {
    const x = await view(room.id);
    return agentMsgs(x, "codex").length >= 2 && x;
  });
  const newDeliveries = v.deliveries.slice(before);
  check(newDeliveries.length === 1 && newDeliveries[0].participantId === px.id, "human message routed only to Codex");
  check(v.messages.find((m: any) => m.id === m5.id).deliveryState === "delivered", "delivery state confirmed by T3");

  // 6. Pause prevents more automatic turns.
  await api("POST", `/api/rooms/${room.id}/auto/start`);
  v = await view(room.id);
  const autoSent = v.deliveries.filter((d: any) => d.countsAsTurn).length;
  await api("POST", `/api/rooms/${room.id}/pause`);
  say(`auto round started (${autoSent} proposal turns sent), then paused`);
  v = await waitFor("in-flight proposals to finish", async () => {
    const x = await view(room.id);
    return x.deliveries.filter((d: any) => d.countsAsTurn).every((d: any) => d.state === "completed") && x;
  });
  await sleep(8000); // several poll cycles
  v = await view(room.id);
  const afterPause = v.deliveries.filter((d: any) => d.countsAsTurn);
  check(afterPause.length === autoSent, `no new automatic turns while paused (${afterPause.length} = ${autoSent})`);
  check(v.room.status === "paused", `room stays paused (${v.room.status})`);

  // 7. Restart preserves the room and does not duplicate work.
  const snapshot = { messages: v.messages.length, deliveries: v.deliveries.length, threads: v.participants.map((p: any) => p.threadId).join(",") };
  const runsBefore: Record<string, number> = {};
  for (const p of v.participants) runsBefore[p.threadId] = ((await t3.call("t3_thread_read", { threadId: p.threadId, limit: 1 })) as any).thread.runCount;
  await stopServer();
  say("server stopped; restarting");
  await startServer();
  await sleep(10_000);
  const v2 = await view(room.id);
  check(v2.participants.map((p: any) => p.threadId).join(",") === snapshot.threads, "same participant threads after restart");
  check(v2.deliveries.length === snapshot.deliveries, `no new deliveries after restart (${v2.deliveries.length})`);
  check(v2.messages.length === snapshot.messages, `transcript preserved without duplicates (${v2.messages.length})`);
  for (const p of v2.participants) {
    const rc = ((await t3.call("t3_thread_read", { threadId: p.threadId, limit: 1 })) as any).thread.runCount;
    check(rc === runsBefore[p.threadId], `${p.name}: no new T3 runs after restart (${rc})`);
  }
  await stopServer();
  await t3.close();
}

main()
  .catch((e) => {
    say(`ERROR ${e.message}`);
    failures.push(e.message);
  })
  .finally(async () => {
    if (server && server.exitCode === null) server.kill("SIGTERM");
    fs.writeFileSync(`${DATA_DIR}/smoke-result.txt`, log.join("\n") + `\n\n${failures.length ? `FAILURES: ${failures.length}` : "ALL PASSED"}\n`);
    console.log(failures.length ? `\n${failures.length} failure(s)` : "\nALL PASSED");
    process.exit(failures.length ? 1 : 0);
  });
