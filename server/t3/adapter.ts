// Live T3 adapter: maps the room controller's normalized operations onto the
// MCP tools of the installed T3 server (verified against T3 Code 0.1.7).
// If T3's tool shapes change, this file is the only one that should.
import { PERMISSION_MODES, type PermissionMode, type ProviderInfo, type T3Status } from "../../shared/types.js";
import { T3Connection, T3ToolError } from "./connection.js";
import type { LaunchInput, LaunchResult, SendResult, T3Adapter, ThreadItem, ThreadSnapshot } from "./types.js";

const MAX_CHARS = 50_000;
/** approval_request statuses that mean it is no longer waiting for the human. */
const APPROVAL_DONE = new Set(["completed", "approved", "declined", "denied", "rejected", "failed", "cancelled", "canceled", "expired", "interrupted", "resolved"]);

export class McpT3Adapter implements T3Adapter {
  readonly mode = "live" as const;
  private cachedProviders: ProviderInfo[] = [];
  private cachedProjects: T3Status["projects"] = [];
  private maxPermission: PermissionMode | null = null;
  environmentId: string | null = null;

  constructor(readonly conn: T3Connection) {}

  status(): T3Status {
    return {
      mcpUrl: this.conn.mcpUrl,
      connection: this.conn.state,
      environmentId: this.environmentId,
      providers: this.cachedProviders,
      projects: this.cachedProjects,
      maxPermission: this.maxPermission,
      webOrigin: new URL(this.conn.mcpUrl).origin,
      mode: "live",
    };
  }

  async connect() {
    const s = await this.conn.connect();
    if (s.kind === "connected") await this.refresh().catch(() => {});
  }

  async refresh() {
    await Promise.all([this.providers(), this.projects()]);
  }

  async projects() {
    const out: T3Status["projects"] = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page: any = await this.conn.call("t3_project_list", { cursor, limit: 100 });
      for (const p of page.projects ?? []) out.push({ id: p.id, title: p.title, workspaceRoot: p.workspaceRoot });
      cursor = page.nextCursor ?? null;
    }
    this.cachedProjects = out;
    return out;
  }

  async providers(): Promise<ProviderInfo[]> {
    const caps: any = await this.conn.call("orchestrator_capabilities", {});
    // Outside a thread, `runtimeMode` is the ceiling of the access level approved for Team Room.
    this.maxPermission = PERMISSION_MODES.includes(caps.runtimeMode) ? caps.runtimeMode : null;
    this.cachedProviders = (caps.providers ?? []).map((p: any) => {
      const constraints: string[] = p.constraints ?? [];
      return {
        instanceId: p.providerInstanceId,
        driver: p.driverKind,
        displayName: p.displayName ?? p.providerInstanceId,
        // canRunChildTask is about delegation; for ordinary threads the provider
        // is usable unless T3 lists a constraint (missing auth, disabled, …).
        available: constraints.length === 0,
        unavailableReason: constraints.length ? constraints.join("; ") : null,
        models: (p.models ?? []).map((m: any) => ({
          slug: m.id,
          name: m.label ?? m.id,
          options: (m.options ?? [])
            .filter((o: any) => typeof o?.id === "string" && Array.isArray(o.values))
            .map((o: any) => ({ id: o.id, values: o.values, default: o.default ?? null })),
        })),
        defaultModel: p.models?.[0]?.id ?? null,
      } satisfies ProviderInfo;
    });
    return this.cachedProviders;
  }

  async launchThread(input: LaunchInput): Promise<LaunchResult> {
    const args: Record<string, unknown> = {
      title: input.title.slice(0, 500),
      modelSelection: {
        instanceId: input.providerInstanceId,
        model: input.model,
        ...(input.options && Object.keys(input.options).length ? { options: input.options } : {}),
      },
      clientRequestId: input.clientRequestId,
    };
    if (input.workspace.kind === "scratch") args.scratch = true;
    else {
      if (!input.projectId) throw new T3ToolError("t3_thread_launch", "invalid_request", "A project is required for this workspace.");
      args.projectId = input.projectId;
      if (input.workspace.kind === "worktree")
        args.workspaceStrategy = { type: "worktree", baseRef: input.workspace.baseRef, ...(input.workspace.branch ? { branch: input.workspace.branch } : {}) };
      else if (input.workspace.kind === "existing_worktree")
        args.workspaceStrategy = { type: "existing_worktree", worktreePath: input.workspace.worktreePath };
      else args.workspaceStrategy = { type: "root" };
    }
    if (input.message) args.message = input.message;
    if (input.runtimeMode) args.runtimeMode = input.runtimeMode;
    const r: any = await this.conn.call("t3_thread_launch", args, 180_000);
    // Launch does not return the workspace; read it from the thread.
    let worktreePath: string | null = null;
    let branch: string | null = null;
    try {
      const detail: any = await this.conn.call("t3_thread_read", { threadId: r.threadId, limit: 1, runLimit: 1, maxCharsPerItem: 1 });
      worktreePath = detail.thread?.worktreePath ?? null;
      branch = detail.thread?.branch ?? null;
    } catch {
      /* not essential */
    }
    return { threadId: r.threadId, link: r.link ?? null, runId: r.runId ?? null, worktreePath, branch };
  }

  async send(input: { threadId: string; message: string; mode: "auto" | "queue"; clientRequestId: string }): Promise<SendResult> {
    const r: any = await this.conn.call("t3_thread_send", {
      threadId: input.threadId,
      message: input.message,
      mode: input.mode,
      clientRequestId: input.clientRequestId,
    });
    return { runId: r.runId ?? null, delivery: r.delivery };
  }

  async readThread(input: { threadId: string; afterPosition: number | null }): Promise<ThreadSnapshot> {
    const items: ThreadItem[] = [];
    let after = input.afterPosition ?? undefined;
    let detail: any = null;
    let runs: any[] = [];
    let nextPosition: number | null = null;
    for (let page = 0; page < 20; page++) {
      const r: any = await this.conn.call("t3_thread_read", {
        threadId: input.threadId,
        view: "messages",
        limit: 100,
        runLimit: 50,
        maxCharsPerItem: MAX_CHARS,
        ...(after !== undefined ? { afterPosition: after } : {}),
      });
      detail = r.thread;
      runs = r.recentRuns ?? runs;
      for (const it of r.items ?? []) items.push(await this.toItem(input.threadId, it));
      nextPosition = r.nextPosition ?? nextPosition;
      if (!r.hasMore || r.nextPosition == null) break;
      after = r.nextPosition;
    }
    const runsOut = [...runs]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((x) => ({ runId: x.runId, status: x.status, error: null, usage: null }));
    // Questions are counted in pendingRequestCount; permission approvals are not. They appear only as
    // approval_request items in the activity timeline, so look there while a run is active.
    const approval = detail?.status === "running" || runsOut.some((r) => r.status === "running") ? await this.openApproval(input.threadId, detail?.itemCount ?? null) : null;
    const pending = approval !== null || (detail?.pendingRequestCount ?? 0) > 0 || runsOut.some((r) => r.status === "waiting");
    return {
      threadId: input.threadId,
      status: detail?.status ?? "idle",
      runs: runsOut,
      items,
      nextPosition,
      hasPendingRequest: pending,
      pendingDetail: approval
        ? `Waiting for your approval in T3: ${approval}`
        : pending
          ? "Waiting for an approval or answer in T3 — open the thread to respond."
          : null,
      link: detail?.link ?? null,
      worktreePath: detail?.worktreePath ?? null,
      branch: detail?.branch ?? null,
    };
  }

  /** The command or action of an approval request that is still open, from the newest activity items; null if none. */
  private async openApproval(threadId: string, itemCount: number | null): Promise<string | null> {
    try {
      const r: any = await this.conn.call("t3_thread_read", {
        threadId,
        view: "activity",
        ...(itemCount != null ? { afterPosition: Math.max(0, itemCount - 12) } : {}),
        limit: 12,
        runLimit: 1,
        maxCharsPerItem: 240,
      });
      const open = (r.items ?? []).filter((it: any) => it.type === "approval_request" && !APPROVAL_DONE.has(String(it.status)));
      const last = open[open.length - 1];
      if (!last) return null;
      const text = String(last.title || last.text || "an action").replace(/\s+/g, " ").trim();
      return text.length > 160 ? `${text.slice(0, 159)}…` : text;
    } catch {
      return null; // best effort: the run status still shows the agent as working
    }
  }

  /** Map a timeline item; fetch the rest of truncated text so the room keeps the full original. */
  private async toItem(threadId: string, it: any): Promise<ThreadItem> {
    let text: string = it.text ?? "";
    let offset: number | null = it.textTruncated ? (it.nextTextOffset ?? null) : null;
    for (let i = 0; offset !== null && i < 40; i++) {
      const more: any = await this.conn.call("t3_thread_read", { threadId, itemId: it.itemId, textOffset: offset, maxCharsPerItem: MAX_CHARS });
      const part = (more.items ?? []).find((x: any) => x.itemId === it.itemId);
      if (!part) break;
      text += part.text ?? "";
      offset = part.textTruncated ? (part.nextTextOffset ?? null) : null;
    }
    const type = String(it.type ?? "");
    const role: ThreadItem["role"] =
      /assistant|agent_message/i.test(type) ? "assistant" : /plan/i.test(type) ? "plan" : /user/i.test(type) ? "user" : "other";
    return {
      itemId: it.itemId,
      position: it.position,
      role: role === "plan" ? "assistant" : role,
      runId: it.runId ?? null,
      text,
      createdAt: it.updatedAt ?? null,
    };
  }

  async configureThread(input: { threadId: string; providerInstanceId: string; model: string; options: Record<string, string | boolean> }) {
    await this.conn.call("t3_thread_configure", {
      threadId: input.threadId,
      modelSelection: { instanceId: input.providerInstanceId, model: input.model, options: input.options },
    });
  }

  async renameThread(input: { threadId: string; title: string; clientRequestId: string }) {
    await this.conn.call("t3_thread_update", { threadId: input.threadId, action: "rename", title: input.title.slice(0, 200), clientRequestId: input.clientRequestId });
  }

  async interrupt(input: { threadId: string; runId?: string | null }) {
    // stop:true behaves like T3's Stop button: interrupts the running turn and
    // holds queued messages. The result is a request, not proof it stopped.
    const r: any = await this.conn.call("t3_thread_interrupt", { threadId: input.threadId, stop: true, reason: "Stopped from Team Room" });
    return { status: r.status as string };
  }
}
