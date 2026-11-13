// Team Room backend: owns T3 credentials and orchestration; serves the UI.
import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { CALLBACK_URL, CREDENTIALS_FILE, DATA_DIR, DB_FILE, HOST, LEAD_NAME, ORIGIN, PORT, ROOT } from "./config.js";
import { setLeadName } from "../shared/digest.js";
import { Store } from "./store.js";
import { RoomController, TransitionError, actionable, type AgentSpec } from "./controller.js";
import { T3Connection, resolveT3McpUrl } from "./t3/connection.js";
import { McpT3Adapter } from "./t3/adapter.js";
import { FakeT3Adapter } from "./t3/fakeAdapter.js";
import type { T3Adapter } from "./t3/types.js";
import type { AgentKind } from "../shared/types.js";
import { ResearchStore } from "./research/store.js";
import { ResearchEngine } from "./research/engine.js";
import { experimentsCsv, markdownReport } from "./research/report.js";
import { ensureDemoRepo, scriptedResearchReply } from "./research/demo.js";
import { KeepAwake } from "./keepAwake.js";
import { OllamaClient } from "./local/ollama.js";
import { LocalWork } from "./local/work.js";

const FIXTURE = process.env.TEAM_ROOM_FIXTURE === "1";
// Fixture mode uses its own database so fabricated rooms never mix with live ones.
const store = new Store(FIXTURE ? DB_FILE.replace(/\.sqlite$/, ".fixture.sqlite") : DB_FILE);

let adapter: T3Adapter;
let live: McpT3Adapter | null = null;
if (FIXTURE) {
  const fake = new FakeT3Adapter();
  const round = { n: 0 };
  fake.autoReply = (t, prompt) =>
    scriptedResearchReply(prompt, t.worktreePath, round) ??
    `**[FIXTURE — not a real agent]** Canned reply to a ${/Critique/.test(prompt) ? "critique" : /Respond to/.test(prompt) ? "response" : "request"}.\n\n## Agreements\n- none\n## Disagreements\n- none\n## Questions for the lead\n- none`;
  // A fixture copy of the AutoResearch demo, so research runs can be tried without real agents.
  const demoDir = ensureDemoRepo(path.join(DATA_DIR, "fixture", "autoresearch-demo"));
  fake.projects = [{ id: "fixture-autoresearch-demo", title: "AutoResearch demo (fixture)", workspaceRoot: demoDir }];
  adapter = fake;
} else {
  live = new McpT3Adapter(new T3Connection(resolveT3McpUrl(), CREDENTIALS_FILE, CALLBACK_URL));
  adapter = live;
}

const ctl = new RoomController(store, adapter);
const ollama = new OllamaClient();
setLeadName(LEAD_NAME);
const local = new LocalWork(store, ollama, LEAD_NAME ?? "the lead");
ctl.onAgentMessage = (roomId, m) => local.onAgentMessage(roomId, m);
const research = new ResearchEngine(new ResearchStore(store.db), adapter, { dataDir: FIXTURE ? `${DATA_DIR}/fixture` : DATA_DIR });
research.recoverOnStartup();

// ---------------------------------------------------------------- events (SSE)
const clients = new Set<Response>();
const emit = (event: Record<string, unknown>) => {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients) c.write(data);
};
ctl.onChange = (roomId) => emit({ type: "room", roomId });
research.onChange = (runId) => emit({ type: "research", runId });
local.onChange = (roomId) => emit({ type: "room", roomId });
if (live) live.conn.onState = () => emit({ type: "t3" });

const app = express();
app.use(express.json({ limit: "1mb" }));

// Loopback-only app holding T3 credentials: reject foreign Host headers (DNS
// rebinding) and require a custom header on mutations (blocks cross-site forms).
app.use((req: Request, res: Response, next: NextFunction) => {
  const host = req.headers.host ?? "";
  if (![`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(host)) return res.status(403).send("Forbidden host");
  if (req.method !== "GET" && req.path.startsWith("/api/") && req.headers["x-team-room"] !== "1")
    return res.status(403).json({ error: "Missing X-Team-Room header" });
  next();
});

/** The served interface build: changes whenever dist/ is rebuilt, so open pages know to reload. */
function buildId(): string | null {
  try {
    return String(Math.round(fs.statSync(path.join(ROOT, "dist", "index.html")).mtimeMs));
  } catch {
    return null;
  }
}

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) =>
  fn(req, res).catch((err) => {
    const status = err instanceof TransitionError ? 409 : /not found/i.test(String(err?.message)) ? 404 : 400;
    res.status(status).json({ error: actionable(err) });
  });

app.get("/api/events", (req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

app.get(
  "/api/status",
  wrap(async (_req, res) => {
    res.json({ ...adapter.status(), keepAwake: awake.active, buildId: buildId(), localModel: await ollama.status(), leadName: LEAD_NAME });
  }),
);

app.post(
  "/api/t3/connect",
  wrap(async (_req, res) => {
    await adapter.connect();
    emit({ type: "t3" });
    res.json(adapter.status());
  }),
);

// Start a fresh T3 approval so the user can pick a different access level.
// The current sign-in is dropped only on this explicit request.
app.post(
  "/api/t3/reauthorize",
  wrap(async (_req, res) => {
    if (!live) throw new Error("Not available in fixture mode");
    live.conn.auth.invalidateCredentials("tokens");
    await adapter.connect();
    emit({ type: "t3" });
    res.json(adapter.status());
  }),
);

/**
 * Open a T3 thread in the T3 desktop app (t3code://threads/<environment>/<thread>) instead of the web page.
 * The server opens it because it runs on the same Mac; that avoids the browser's "Open T3 Code?" prompt.
 * Only thread links from T3 are accepted, rebuilt from validated parts.
 */
app.post(
  "/api/t3/open",
  wrap(async (req, res) => {
    if (process.platform !== "darwin") throw new Error("Opening the T3 app directly works on macOS only.");
    const link = String(req.body?.link ?? "");
    const m = /^(?:https:\/\/app\.t3\.codes\/threads\/|t3code:\/\/threads\/)([A-Za-z0-9-]{1,64})\/([A-Za-z0-9%:._-]{1,200})\/?$/.exec(link);
    if (!m) throw new Error("Not a T3 thread link");
    await new Promise<void>((resolve, reject) => execFile("open", [`t3code://threads/${m[1]}/${m[2]}`], (err) => (err ? reject(err) : resolve())));
    res.json({ ok: true });
  }),
);

app.post(
  "/api/t3/refresh",
  wrap(async (_req, res) => {
    if (live) await live.refresh();
    res.json(adapter.status());
  }),
);

app.get("/oauth/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : null;
  if (!code || !live) return res.redirect(`/?auth_error=${encodeURIComponent(String(req.query.error ?? "missing_code"))}`);
  try {
    await live.conn.finishAuth(code);
    await live.refresh().catch(() => {});
    emit({ type: "t3" });
    res.redirect("/");
  } catch (err) {
    res.redirect(`/?auth_error=${encodeURIComponent(actionable(err))}`);
  }
});

app.get(
  "/api/rooms",
  wrap(async (_req, res) => {
    res.json(
      store.rooms().map((r) => {
        const participants = store.participants(r.id);
        // Who is blocked on the human in T3 (an approval or a question): shown instead of the room's own status.
        const waiting = [
          ...participants.filter((p) => p.status === "awaiting_input").map((p) => p.name),
          ...store.tasks(r.id).filter((t) => t.status === "awaiting_input").map((t) => `${store.participantByKind(r.id, t.ownerKind)?.name ?? t.ownerKind} (${t.kind})`),
        ];
        const tasksActive = store.tasks(r.id).some((t) => ["queued", "launching", "working", "awaiting_input"].includes(t.status));
        return { ...r, participants: participants.map((p) => ({ kind: p.kind, name: p.name, status: p.status })), waiting, questions: store.questions(r.id, "status='open'").length, tasksActive };
      }),
    );
  }),
);

app.post(
  "/api/rooms",
  wrap(async (req, res) => {
    const b = req.body ?? {};
    if (!b.title?.trim() || !b.brief?.trim()) throw new Error("Title and task brief are required");
    const project = b.projectId ? adapter.status().projects.find((p) => p.id === b.projectId) : null;
    const room = await ctl.createRoom({
      title: String(b.title).trim(),
      brief: String(b.brief).trim(),
      projectId: b.projectId || null,
      projectTitle: project?.title ?? null,
      mode: b.mode === "auto" ? "auto" : "manual",
      turnLimit: Number(b.turnLimit) || 6,
      permissionMode: b.permissionMode || undefined,
      peerLimit: b.peerLimit === undefined ? undefined : Number(b.peerLimit),
      agents: (Array.isArray(b.agents) ? b.agents : []).map(agentSpec),
    });
    res.json(room);
  }),
);

app.post(
  "/api/rooms/:id/agents",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    await ctl.addAgent(id, agentSpec(req.body ?? {}));
    res.json(roomView(id));
  }),
);

app.post(
  "/api/rooms/:id/agents/:kind/remove",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    await ctl.removeAgent(id, String(req.params.kind));
    res.json(roomView(id));
  }),
);

app.post(
  "/api/rooms/:id/agents/:kind/options",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    await ctl.setAgentOptions(id, String(req.params.kind), req.body?.options ?? {});
    res.json(roomView(id));
  }),
);

app.post(
  "/api/rooms/:id/questions/answer",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    const answers = Array.isArray(req.body?.answers) ? req.body.answers.map((a: any) => ({ id: String(a.id), text: String(a.text ?? "") })) : [];
    await ctl.answerQuestions(id, answers);
    res.json(roomView(id));
  }),
);

app.post(
  "/api/rooms/:id/questions/:qid/dismiss",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    await ctl.dismissQuestion(id, String(req.params.qid));
    res.json(roomView(id));
  }),
);

app.post(
  "/api/rooms/:id/agents/:kind/model",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    await ctl.setAgentModel(id, String(req.params.kind), String(req.body?.model ?? ""));
    res.json(roomView(id));
  }),
);

app.post(
  "/api/rooms/:id/summarize",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    const b = req.body ?? {};
    await ctl.summarize(id, { from: Number(b.from), to: Number(b.to), agent: b.agent ?? null });
    res.json(roomView(id));
  }),
);

app.post(
  "/api/rooms/:id/transfer",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    const b = req.body ?? {};
    await ctl.transferAgents(id, { mode: b.mode, agents: Array.isArray(b.agents) ? b.agents : [], handoff: b.handoff !== false });
    res.json(roomView(id));
  }),
);

const agentSpec = (a: any): AgentSpec => ({ providerInstanceId: String(a?.providerInstanceId ?? ""), model: String(a?.model ?? ""), options: a?.options ?? {} });

const roomView = (id: string) => ({ ...ctl.view(id), localDigests: local.digests(id) });

app.get(
  "/api/rooms/:id",
  wrap(async (req, res) => {
    res.json(roomView(String(req.params.id)));
  }),
);

app.post(
  "/api/rooms/:id/local-digest",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    await local.requestDigest(id, Number(req.body?.from), Number(req.body?.to));
    res.json(roomView(id));
  }),
);

app.patch(
  "/api/rooms/:id",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    if (typeof req.body.brief === "string") await ctl.updateBrief(id, req.body.brief);
    if (req.body.turnLimit !== undefined) await ctl.setTurnLimit(id, Number(req.body.turnLimit));
    if (req.body.peerLimit !== undefined) await ctl.setPeerLimit(id, Number(req.body.peerLimit));
    if (req.body.permissionMode !== undefined) await ctl.setPermissionMode(id, req.body.permissionMode);
    res.json(roomView(id));
  }),
);

app.post(
  "/api/rooms/:id/messages",
  wrap(async (req, res) => {
    const { body, target, pin, order } = req.body ?? {};
    res.json(
      await ctl.postHumanMessage(String(req.params.id), {
        body: String(body ?? ""),
        target,
        pin: pin || null,
        order: typeof order === "string" && order ? order : "parallel",
      }),
    );
  }),
);

app.post(
  "/api/rooms/:id/ask",
  wrap(async (req, res) => {
    const t = req.body?.target;
    if (typeof t !== "string" || !t) throw new Error("target must be an agent's handle or all");
    await ctl.ask(String(req.params.id), t as AgentKind | "all");
    res.json({ ok: true });
  }),
);

const action = (name: string, fn: (id: string) => Promise<unknown>) =>
  app.post(
    `/api/rooms/:id/${name}`,
    wrap(async (req, res) => {
      await fn(String(req.params.id));
      res.json(roomView(String(req.params.id)));
    }),
  );
action("auto/start", (id) => ctl.startAuto(id));
action("continue", (id) => ctl.continueDiscussion(id));
action("pause", (id) => ctl.pause(id));
action("stop", (id) => ctl.stop(id));
action("resume", (id) => ctl.resume(id));

app.post(
  "/api/rooms/:id/decisions",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    const kind = req.body?.kind === "constraint" ? "constraint" : "decision";
    const body = String(req.body?.body ?? "").trim();
    if (!body) throw new Error("Decision text is empty");
    store.addDecision(id, kind, body);
    store.addMessage({ roomId: id, author: "human", kind: "decision", recipients: ["all"], body: `**Pinned ${kind}:** ${body}`, deliveryState: "recorded" });
    ctl.onChange(id);
    res.json(roomView(id));
  }),
);

app.post(
  "/api/decisions/:id/active",
  wrap(async (req, res) => {
    store.setDecisionActive(String(req.params.id), !!req.body?.active);
    const roomId = req.body?.roomId;
    if (roomId) ctl.onChange(roomId);
    res.json({ ok: true });
  }),
);

app.post(
  "/api/rooms/:id/approve",
  wrap(async (req, res) => {
    await ctl.approvePlan(String(req.params.id), { body: String(req.body?.body ?? ""), sourceMessageId: req.body?.sourceMessageId ?? null });
    res.json(roomView(String(req.params.id)));
  }),
);

app.post(
  "/api/rooms/:id/tasks",
  wrap(async (req, res) => {
    const b = req.body ?? {};
    if (typeof b.implementer !== "string" || !b.implementer) throw new Error("Choose an implementer");
    const strategy = ["turns", "parallel"].includes(b.strategy) ? b.strategy : "solo";
    if (!b.title?.trim()) throw new Error("Task title is required");
    if (strategy === "solo" && !b.spec?.trim()) throw new Error("Task scope is required");
    await ctl.startImplementation(String(req.params.id), {
      implementer: b.implementer,
      title: String(b.title).trim(),
      spec: String(b.spec ?? "").trim(),
      baseRef: b.baseRef?.trim() || null,
      strategy,
      reviewer: typeof b.reviewer === "string" && b.reviewer ? b.reviewer : null,
      parts: Object.fromEntries(Object.entries(b.parts ?? {}).map(([k, v]) => [k, String(v ?? "")])),
      first: typeof b.first === "string" && b.first ? b.first : undefined,
    });
    res.json(roomView(String(req.params.id)));
  }),
);

app.post(
  "/api/rooms/:id/review/accept",
  wrap(async (req, res) => {
    await ctl.acceptReview(String(req.params.id), String(req.body?.note ?? ""));
    res.json(roomView(String(req.params.id)));
  }),
);
app.post(
  "/api/rooms/:id/review/changes",
  wrap(async (req, res) => {
    await ctl.requestChanges(String(req.params.id), String(req.body?.note ?? ""), req.body?.taskId ? String(req.body.taskId) : null);
    res.json(roomView(String(req.params.id)));
  }),
);

// ------------------------------------------------------------- static UI
const dist = path.join(ROOT, "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/|oauth\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

// ------------------------------------------------------------- AutoResearch
app.get(
  "/api/research",
  wrap(async (_req, res) => {
    res.json(
      research.store.runs().map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        updatedAt: r.updatedAt,
        projectTitle: r.projectTitle,
        waiting: research.store.experiments(r.id, "awaiting_input=1").map((e) => `E${e.seq}`),
      })),
    );
  }),
);

app.post(
  "/api/research",
  wrap(async (req, res) => {
    const run = await research.createRun(req.body ?? {});
    emit({ type: "research", runId: run.id });
    res.json(run);
  }),
);

app.get(
  "/api/research/:id",
  wrap(async (req, res) => {
    res.json(research.view(String(req.params.id)));
  }),
);

for (const action of ["start", "pause", "resume", "stop"] as const)
  app.post(
    `/api/research/:id/${action}`,
    wrap(async (req, res) => {
      const id = String(req.params.id);
      await research[action](id);
      res.json(research.view(id));
    }),
  );

app.patch(
  "/api/research/:id/limits",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    await research.updateLimits(id, req.body ?? {});
    res.json(research.view(id));
  }),
);

app.post(
  "/api/research/:id/suggest",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    const b = req.body ?? {};
    await research.suggest(id, { hypothesis: String(b.hypothesis ?? ""), parentSeq: b.parentSeq == null || b.parentSeq === "" ? null : Number(b.parentSeq), approach: b.approach });
    res.json(research.view(id));
  }),
);

app.post(
  "/api/research/:id/experiments/:eid/:op",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    const eid = String(req.params.eid);
    const b = req.body ?? {};
    if (req.params.op === "pin") await research.setPinned(id, eid, !!b.pinned);
    else if (req.params.op === "reject") await research.rejectDirection(id, eid);
    else if (req.params.op === "decide") await research.humanDecide(id, eid, b.decision, String(b.note ?? ""));
    else throw new Error("Unknown operation");
    res.json(research.view(id));
  }),
);

app.get(
  "/api/research/:id/report.md",
  wrap(async (req, res) => {
    const v = research.view(String(req.params.id));
    res.setHeader("content-type", "text/markdown; charset=utf-8");
    if (req.query.download) res.setHeader("content-disposition", `attachment; filename="autoresearch-${v.run.id.slice(0, 8)}.md"`);
    res.send(markdownReport(v));
  }),
);

app.get(
  "/api/research/:id/experiments.csv",
  wrap(async (req, res) => {
    const v = research.view(String(req.params.id));
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="autoresearch-${v.run.id.slice(0, 8)}-experiments.csv"`);
    res.send(experimentsCsv(v));
  }),
);

// ------------------------------------------------------------- poll loop
// T3's outside-client interface has no event subscription, so poll in-flight
// work with bounded frequency, backing off while T3 is unreachable.
const BASE_MS = 2000;
const MAX_MS = 30_000;
let delay = BASE_MS;
let recovered = false;
let nextReconnect = 0;
const awake = new KeepAwake();
async function loop() {
  try {
    const st = adapter.status().connection;
    // T3 restarted or was not up yet: reconnect by itself (sign-in problems still need the human).
    if ((st.kind === "error" || st.kind === "disconnected") && Date.now() >= nextReconnect) {
      nextReconnect = Date.now() + 15_000;
      await adapter.connect().catch(() => {});
      emit({ type: "t3" });
    }
    if (adapter.status().connection.kind === "connected") {
      // Recovery needs T3, so it runs on the first connected tick (startup or after sign-in).
      if (!recovered) {
        await ctl.recoverOnStartup();
        recovered = true;
      }
      await ctl.tick();
      await research.tick();
      await local.tick().catch((err) => console.error("[local]", actionable(err)));
      delay = BASE_MS;
    } else {
      delay = Math.min(MAX_MS, delay * 2);
    }
  } catch (err) {
    console.error("[poll]", actionable(err));
    delay = Math.min(MAX_MS, delay * 2);
  }
  try {
    const was = awake.active;
    awake.set(ctl.isBusy() || research.isBusy());
    if (was !== awake.active) emit({ type: "t3" }); // the header shows it
  } catch {
    /* never let sleep handling stop the loop */
  }
  setTimeout(loop, Math.min(delay, adapter.status().connection.kind === "connected" ? delay : 15_000));
}

app.listen(PORT, HOST, async () => {
  console.log(`Team Room ${FIXTURE ? "(FIXTURE MODE — no real agents)" : "(live)"} on ${ORIGIN}`);
  await adapter.connect().catch((err) => console.error("[t3]", actionable(err)));
  const st = adapter.status().connection;
  console.log(`[t3] ${st.kind}${st.kind === "connected" ? ` ${st.serverName} ${st.serverVersion}` : st.kind === "error" ? `: ${st.detail}` : ""}`);
  setTimeout(loop, 200);
});
