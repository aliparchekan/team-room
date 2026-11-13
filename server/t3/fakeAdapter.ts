// In-memory T3 stand-in for automated tests and the explicitly-labelled
// fixture mode (TEAM_ROOM_FIXTURE=1). It is never used in live mode.
import type { PermissionMode, ProviderInfo, T3Status } from "../../shared/types.js";
import { T3ToolError } from "./connection.js";
import { TERMINAL_RUN, type LaunchInput, type LaunchResult, type SendResult, type T3Adapter, type ThreadSnapshot } from "./types.js";

const FIXTURE_PROVIDERS: ProviderInfo[] = [
  {
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    displayName: "Claude (fixture)",
    available: true,
    unavailableReason: null,
    models: [{ slug: "fixture-claude", name: "fixture", options: [{ id: "effort", values: ["low", "medium", "high"], default: "medium" }] }],
    defaultModel: "fixture-claude",
  },
  {
    instanceId: "codex",
    driver: "codex",
    displayName: "Codex (fixture)",
    available: true,
    unavailableReason: null,
    models: [{ slug: "fixture-codex", name: "fixture", options: [{ id: "reasoningEffort", values: ["low", "medium", "high"], default: "low" }] }],
    defaultModel: "fixture-codex",
  },
  {
    instanceId: "grok",
    driver: "grok",
    displayName: "Grok (fixture)",
    available: true,
    unavailableReason: null,
    models: [{ slug: "fixture-grok", name: "fixture", options: [] }],
    defaultModel: "fixture-grok",
  },
  {
    instanceId: "cursor",
    driver: "cursor",
    displayName: "Cursor (fixture)",
    available: false,
    unavailableReason: "Provider instance is disabled.",
    models: [],
    defaultModel: null,
  },
];

type FakeRun = { runId: string; status: string; error: string | null; prompt: string };
type FakeThread = {
  threadId: string;
  providerInstanceId: string;
  items: { itemId: string; position: number; role: "user" | "assistant"; runId: string | null; text: string }[];
  runs: FakeRun[];
  pending: boolean;
  worktreePath: string | null;
};

export class FakeT3Adapter implements T3Adapter {
  readonly mode = "fixture" as const;
  threads = new Map<string, FakeThread>();
  launches = new Map<string, string>(); // clientRequestId -> threadId
  sends = new Map<string, SendResult & { threadId: string }>(); // clientRequestId -> result
  sendCalls: { threadId: string; message: string; mode: string; clientRequestId: string }[] = [];
  interrupts: string[] = [];
  /** When set, the next send throws this (simulates lost response / failure). */
  failNextSend: Error | null = null;
  /** Auto-reply generator for fixture mode; tests usually complete runs manually. */
  autoReply: ((thread: FakeThread, prompt: string) => string) | null = null;
  private n = 0;

  maxPermission: PermissionMode = "auto-accept-edits";
  projects: T3Status["projects"] = [];
  launchInputs: LaunchInput[] = [];

  status(): T3Status {
    return {
      mcpUrl: "fixture://",
      connection: { kind: "connected", serverName: "fixture", serverVersion: "fixture" },
      environmentId: "fixture-env",
      providers: FIXTURE_PROVIDERS,
      projects: this.projects,
      maxPermission: this.maxPermission,
      webOrigin: null,
      mode: "fixture",
    };
  }
  async connect() {}
  async providers(): Promise<ProviderInfo[]> {
    return FIXTURE_PROVIDERS;
  }

  private id(p: string) {
    return `${p}-${++this.n}`;
  }

  async launchThread(input: LaunchInput): Promise<LaunchResult> {
    this.launchInputs.push(input);
    const existing = this.launches.get(input.clientRequestId);
    if (existing) {
      const t = this.threads.get(existing)!;
      return { threadId: existing, link: `fixture://thread/${existing}`, runId: t.runs[0]?.runId ?? null, worktreePath: t.worktreePath, branch: null };
    }
    const threadId = this.id("thread");
    const t: FakeThread = {
      threadId,
      providerInstanceId: input.providerInstanceId,
      items: [],
      runs: [],
      pending: false,
      worktreePath: input.workspace.kind === "worktree" ? `/tmp/fixture-worktree-${threadId}` : input.workspace.kind === "existing_worktree" ? input.workspace.worktreePath : null,
    };
    this.threads.set(threadId, t);
    this.launches.set(input.clientRequestId, threadId);
    let runId: string | null = null;
    if (input.message) runId = this.startRun(t, input.message);
    return { threadId, link: `fixture://thread/${threadId}`, runId, worktreePath: t.worktreePath, branch: null };
  }

  private startRun(t: FakeThread, message: string): string {
    const runId = this.id("run");
    t.items.push({ itemId: this.id("item"), position: t.items.length + 1, role: "user", runId, text: message });
    const active = t.runs.some((r) => !TERMINAL_RUN.has(r.status));
    t.runs.push({ runId, status: active ? "queued" : "running", error: null, prompt: message });
    if (this.autoReply) {
      const reply = this.autoReply(t, message);
      setTimeout(() => this.complete(t.threadId, reply, runId), 400);
    }
    return runId;
  }

  async send(input: { threadId: string; message: string; mode: "auto" | "queue"; clientRequestId: string }): Promise<SendResult> {
    this.sendCalls.push(input);
    if (this.failNextSend) {
      const e = this.failNextSend;
      this.failNextSend = null;
      throw e;
    }
    const prior = this.sends.get(input.clientRequestId);
    if (prior) return { runId: prior.runId, delivery: prior.delivery };
    const t = this.threads.get(input.threadId);
    if (!t) throw new T3ToolError("t3_thread_send", "thread_not_found", "no such thread");
    const active = t.runs.find((r) => !TERMINAL_RUN.has(r.status));
    let res: SendResult;
    if (active && input.mode === "auto" && active.status === "running") {
      t.items.push({ itemId: this.id("item"), position: t.items.length + 1, role: "user", runId: active.runId, text: input.message });
      res = { runId: active.runId, delivery: "steered" };
    } else {
      const runId = this.startRun(t, input.message);
      res = { runId, delivery: active ? "queued" : "started" };
    }
    this.sends.set(input.clientRequestId, { ...res, threadId: input.threadId });
    return res;
  }

  /** Test helper: finish the active (or given) run with an assistant reply. */
  complete(threadId: string, text: string, runId?: string, status = "completed") {
    const t = this.threads.get(threadId)!;
    const run = runId ? t.runs.find((r) => r.runId === runId)! : t.runs.find((r) => !TERMINAL_RUN.has(r.status))!;
    if (!run || TERMINAL_RUN.has(run.status)) return;
    if (text) t.items.push({ itemId: this.id("item"), position: t.items.length + 1, role: "assistant", runId: run.runId, text });
    run.status = status;
    const next = t.runs.find((r) => r.status === "queued");
    if (next) next.status = "running";
  }

  async readThread(input: { threadId: string; afterPosition: number | null }): Promise<ThreadSnapshot> {
    const t = this.threads.get(input.threadId);
    if (!t) throw new T3ToolError("t3_thread_read", "thread_not_found", "no such thread");
    const after = input.afterPosition ?? 0;
    const items = t.items.filter((i) => i.position > after);
    const last = t.runs[t.runs.length - 1];
    return {
      threadId: t.threadId,
      status: last && !TERMINAL_RUN.has(last.status) ? "running" : "idle",
      runs: t.runs.map((r) => ({ runId: r.runId, status: r.status, error: r.error, usage: null })),
      items: items.map((i) => ({ ...i, createdAt: null })),
      nextPosition: t.items.length,
      hasPendingRequest: t.pending,
      pendingDetail: t.pending ? "Approval needed (fixture)" : null,
      link: `fixture://thread/${t.threadId}`,
      worktreePath: t.worktreePath,
      branch: null,
    };
  }

  renames: { threadId: string; title: string }[] = [];
  configures: { threadId: string; model: string; options: Record<string, string | boolean> }[] = [];
  async configureThread(input: { threadId: string; providerInstanceId: string; model: string; options: Record<string, string | boolean> }) {
    if (!this.threads.has(input.threadId)) throw new T3ToolError("t3_thread_configure", "thread_not_found", "no such thread");
    this.configures.push({ threadId: input.threadId, model: input.model, options: input.options });
  }
  async renameThread(input: { threadId: string; title: string; clientRequestId: string }) {
    this.renames.push({ threadId: input.threadId, title: input.title });
  }

  async interrupt(input: { threadId: string }) {
    this.interrupts.push(input.threadId);
    const t = this.threads.get(input.threadId)!;
    const run = t.runs.find((r) => r.status === "running");
    if (!run) return { status: "no_active_run" };
    // Like the real thing: a request, not an immediate stop. Tests call finishInterrupt().
    return { status: "requested" };
  }

  finishInterrupt(threadId: string) {
    const t = this.threads.get(threadId)!;
    for (const r of t.runs) if (!TERMINAL_RUN.has(r.status)) r.status = "interrupted";
  }
}
