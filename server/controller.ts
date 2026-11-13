// Room controller: an explicit, deterministic state machine over durable state.
// Every transition is persisted before side effects; side effects (T3 calls)
// are keyed by stable client request ids so they can be replayed safely.
import { randomUUID } from "node:crypto";
import type {
  AgentKind,
  Decision,
  DecisionSummary,
  Delivery,
  MessageDeliveryState,
  MessageKind,
  Participant,
  Question,
  PermissionMode,
  ReplyOrder,
  Recipient,
  Room,
  RoomMessage,
  RoomStatus,
  RoomView,
  Task,
  TaskStrategy,
  TurnPurpose,
} from "../shared/types.js";
import { MAX_AGENTS, MIN_AGENTS, PERMISSION_LABELS, PERMISSION_MODES, TASK_STRATEGIES, assignHandles } from "../shared/types.js";
import { Store } from "./store.js";
import { T3ToolError } from "./t3/connection.js";
import { TERMINAL_RUN, type T3Adapter, type ThreadSnapshot } from "./t3/types.js";
import {
  buildEnvelope,
  contextVersion,
  extractSections,
  listNames,
  namesOf,
  parseMentions,
  pendingFor,
  visibleTo,
  buildTransferPrompt,
  buildSummaryEnvelope,
} from "./envelope.js";
import { implementationPrompt, reviewPrompt } from "./taskPrompts.js";

/** The bounded automatic sequence: each step runs for every agent in parallel. */
export const AUTO_STEPS: TurnPurpose[] = ["proposal", "critique", "response"];

/** Allowed room status transitions. Anything else is a bug and throws. */
const TRANSITIONS: Record<RoomStatus, RoomStatus[]> = {
  setting_up: ["idle", "needs_attention", "setting_up", "paused"],
  idle: ["running", "paused", "executing", "idle", "needs_attention", "reconciling", "stopping"],
  running: ["running", "paused", "stopping", "awaiting_decision", "idle", "needs_attention", "reconciling", "executing"],
  paused: ["paused", "running", "reconciling", "stopping", "idle", "executing", "needs_attention", "awaiting_decision"],
  stopping: ["stopping", "paused", "needs_attention", "reconciling"],
  reconciling: ["running", "paused", "idle", "awaiting_decision", "needs_attention", "executing", "review_ready", "reconciling", "stopping"],
  awaiting_decision: ["running", "paused", "executing", "idle", "awaiting_decision", "needs_attention", "reconciling", "stopping"],
  executing: ["executing", "review_ready", "needs_attention", "stopping", "paused", "reconciling", "idle"],
  review_ready: ["executing", "idle", "review_ready", "running", "paused", "needs_attention", "reconciling", "stopping"],
  needs_attention: ["reconciling", "paused", "idle", "needs_attention", "stopping", "running", "executing"],
};

export class TransitionError extends Error {}

const PAUSED_BY_YOU = "Paused by you. Running turns finish; no new turns start.";
const STOPPED = "Stopped. T3 reports no agent is running.";

/** Default for a room's peerLimit: agent-to-agent @mention hand-offs allowed in a row before the room waits for the human. */
export const DEFAULT_PEER_LIMIT = 3;

export type StartImplementationInput = {
  /** Solo: the implementer. Joint: who goes first when taking turns. */
  implementer: AgentKind;
  /** Solo: who reviews (default: the next agent in the room). */
  reviewer?: AgentKind | null;
  title: string;
  /** Solo scope. */
  spec: string;
  baseRef?: string | null;
  strategy?: TaskStrategy;
  /** Joint: each taking part agent's part (agents with an empty part sit this job out). */
  parts?: Partial<Record<AgentKind, string>>;
  first?: AgentKind;
};

const STRATEGY_LABEL: Record<TaskStrategy, string> = {
  solo: "one implements, another reviews",
  turns: "taking turns in one worktree",
  parallel: "in parallel, separate worktrees",
};

/** An agent for a new room or one joining a room: which T3 provider and model. */
export type AgentSpec = { providerInstanceId: string; model: string; options?: Record<string, string | boolean> };
const ACTIVE_TASK: Task["status"][] = ["queued", "launching", "working", "awaiting_input"];
export const MAX_PEER_LIMIT = 20;

function checkPeerLimit(limit: number) {
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_PEER_LIMIT) throw new Error(`Hand-off limit must be 0–${MAX_PEER_LIMIT}`);
}

/** Run statuses that mean a provider turn is actually executing (not merely queued). */
const ACTIVE_RUN = new Set(["preparing", "starting", "running", "waiting"]);

export type CreateRoomInput = {
  title: string;
  brief: string;
  projectId: string | null;
  projectTitle: string | null;
  mode: Room["mode"];
  turnLimit?: number;
  /** T3 runtime mode for every thread the room starts. Defaults to Supervised. */
  permissionMode?: PermissionMode;
  /** Agent-to-agent hand-offs in a row before the room waits for the human (0 = off). */
  peerLimit?: number;
  /** 2–6 agents, in the order they speak and appear. */
  agents: AgentSpec[];
};

export class RoomController {
  /** A new agent message was recorded (the server finds the questions it asks the human). */
  onAgentMessage: (roomId: string, m: RoomMessage) => void = () => {};
  private locks = new Map<string, Promise<unknown>>();
  onChange: (roomId: string) => void = () => {};

  constructor(
    readonly store: Store,
    readonly t3: T3Adapter,
  ) {}

  /** Serialize all work per room so API actions and the poller never interleave. */
  private withRoom<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(roomId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      roomId,
      next.catch(() => {}),
    );
    return next.finally(() => this.onChange(roomId));
  }

  private room(id: string): Room {
    const r = this.store.room(id);
    if (!r) throw new Error(`Room ${id} not found`);
    return r;
  }

  /** Handles of the room's current agents, in order. */
  private kinds(roomId: string): AgentKind[] {
    return this.store.participants(roomId).map((p) => p.kind);
  }
  /** Display name of an agent of the room (also one that left). */
  private nameOf(roomId: string, kind: AgentKind): string {
    return this.store.participantByKind(roomId, kind)?.name ?? kind;
  }
  private names(roomId: string) {
    return namesOf(this.store.participants(roomId, true));
  }
  /** The agent after `kind` in the room's order (wrapping), skipping `skip`: who reviews by default. */
  private nextAgent(roomId: string, kind: AgentKind, skip: AgentKind[] = []): AgentKind {
    const ks = this.kinds(roomId);
    const i = ks.indexOf(kind);
    for (let n = 1; n <= ks.length; n++) {
      const k = ks[(i + n + ks.length) % ks.length];
      if (k !== kind && !skip.includes(k)) return k;
    }
    return ks.find((k) => k !== kind) ?? kind;
  }

  private setStatus(room: Room, status: RoomStatus, detail: string | null = null) {
    if (!TRANSITIONS[room.status].includes(status))
      throw new TransitionError(`Room cannot go from ${room.status} to ${status}`);
    this.store.updateRoom(room.id, { status, statusDetail: detail });
    room.status = status;
    room.statusDetail = detail;
  }

  private system(roomId: string, body: string, meta?: Record<string, unknown>) {
    return this.store.addMessage({ roomId, author: "system", kind: "system", recipients: ["human"], body, meta });
  }

  // ------------------------------------------------------------------ views
  view(roomId: string): RoomView {
    const room = this.room(roomId);
    const messages = this.store.messages(roomId);
    return {
      room,
      participants: this.store.participants(roomId),
      formerParticipants: this.store.participants(roomId, true).filter((p) => p.leftAt),
      messages,
      deliveries: this.store.deliveries(roomId).map((d) => ({ ...d, envelope: d.envelope })),
      decisions: this.store.decisions(roomId),
      tasks: this.store.tasks(roomId),
      summary: this.summary(room, messages),
      // Open questions, plus the last few handled ones so a just-answered question doesn't vanish without trace.
      questions: [...this.store.questions(roomId, "status='open'"), ...this.store.questions(roomId, "status IN ('answered','dismissed')").slice(-5)],
    };
  }

  private summary(room: Room, messages: RoomMessage[]): DecisionSummary | null {
    const agents = this.kinds(room.id);
    const agentMsgs = messages.filter((m) => m.author !== "human" && m.author !== "system");
    if (!agentMsgs.length) return null;
    const proposals = agentMsgs
      .filter((m) => m.kind === "proposal")
      .map((m) => ({ author: m.author as AgentKind, messageId: m.id, excerpt: plainText(m.body).slice(0, 280) }));
    const sections = agents.map((k) => {
      const last = [...agentMsgs].reverse().find((m) => m.author === k && (m.kind === "response" || m.kind === "reply"));
      return { author: k, ...(last ? extractSections(last.body) : { agreements: [], disagreements: [], questions: [] }) };
    }).filter((s) => s.agreements.length || s.disagreements.length || s.questions.length);
    return { proposals, sections, limitReached: room.turnsUsed >= room.turnLimit };
  }

  // ------------------------------------------------------------- create room
  async createRoom(input: CreateRoomInput): Promise<Room> {
    const permissionMode = input.permissionMode ?? "approval-required";
    const cap = this.t3.status().maxPermission;
    const peerLimit = input.peerLimit ?? DEFAULT_PEER_LIMIT;
    checkPeerLimit(peerLimit);
    if (!PERMISSION_MODES.includes(permissionMode)) throw new Error(`Unknown permission mode: ${permissionMode}`);
    if (cap && PERMISSION_MODES.indexOf(permissionMode) > PERMISSION_MODES.indexOf(cap))
      throw new Error(
        `T3 lets Team Room start threads up to ${PERMISSION_LABELS[cap]}. To use ${PERMISSION_LABELS[permissionMode]}, choose "Change access in T3" and approve a higher level.`,
      );
    if (!Array.isArray(input.agents) || input.agents.length < MIN_AGENTS || input.agents.length > MAX_AGENTS)
      throw new Error(`A room has ${MIN_AGENTS}–${MAX_AGENTS} agents.`);
    const identities = assignHandles(input.agents.map((a) => this.providerFor(a)));
    const options = input.agents.map((a) => this.validOptions(a.providerInstanceId, a.model, a.options ?? {}));
    const room = this.store.createRoom({
      title: input.title,
      brief: input.brief,
      projectId: input.projectId,
      projectTitle: input.projectTitle,
      mode: input.mode,
      turnLimit: input.turnLimit ?? 6,
      permissionMode,
      peerLimit,
      live: this.t3.mode === "live",
    });
    this.store.updateRoom(room.id, { status: "setting_up" });
    input.agents.forEach((a, i) =>
      this.store.addParticipant(room.id, { kind: identities[i].handle, name: identities[i].name, providerInstanceId: a.providerInstanceId, model: a.model, options: options[i] }),
    );
    this.system(room.id, `Room created. Setting up threads in T3 for ${listNames(identities.map((x) => x.name))}…`);
    await this.withRoom(room.id, () => this.setupParticipants(room.id));
    return this.room(room.id);
  }

  /** Launch (idempotently) an idle T3 thread for every participant that lacks one. */
  private async setupParticipants(roomId: string) {
    const room = this.room(roomId);
    let failed = false;
    for (const p of this.store.participants(roomId)) {
      if (p.threadId) continue;
      try {
        const res = await this.t3.launchThread({
          projectId: room.projectId,
          title: `${room.title} — ${p.name}`,
          providerInstanceId: p.providerInstanceId,
          model: p.model,
          clientRequestId: p.launchRequestId,
          workspace: room.projectId ? { kind: "root" } : { kind: "scratch" },
          runtimeMode: room.permissionMode,
          options: p.options,
        });
        this.store.updateParticipant(p.id, { threadId: res.threadId, threadLink: res.link, threadMode: room.permissionMode, status: "ready", statusDetail: null });
      } catch (err) {
        failed = true;
        this.store.updateParticipant(p.id, { status: "failed", statusDetail: actionable(err) });
      }
    }
    const fresh = this.room(roomId);
    if (fresh.status === "setting_up") {
      if (failed) this.setStatus(fresh, "needs_attention", "Could not create every participant thread in T3. Fix the cause, then Resume.");
      else {
        this.setStatus(fresh, "idle");
        this.system(roomId, "Every agent's thread is ready in T3.");
      }
    }
  }

  /** The T3 provider an agent runs on; it must be enabled in T3 and offer the model. */
  private providerFor(a: AgentSpec) {
    const provider = this.t3.status().providers.find((p) => p.instanceId === a.providerInstanceId);
    if (!provider) throw new Error(`T3 has no provider "${a.providerInstanceId}".`);
    if (!provider.available) throw new Error(`${provider.displayName} is not available in T3: ${provider.unavailableReason ?? "enable it in T3's settings"}.`);
    if (!a.model) throw new Error(`Choose a model for ${provider.displayName}.`);
    if (provider.models.length && !provider.models.some((m) => m.slug === a.model)) throw new Error(`${provider.displayName} has no model "${a.model}".`);
    return { driver: provider.driver, displayName: provider.displayName };
  }

  /**
   * Add an agent to a room that is under way. Its new thread starts with the room's record (brief, pinned decisions,
   * tasks, and the transcript within T3's size limit), so it can catch up and introduce itself.
   */
  addAgent(roomId: string, spec: AgentSpec) {
    return this.withRoom(roomId, async () => {
      const room = this.room(roomId);
      if (room.status === "setting_up") throw new TransitionError("Wait until the agents' threads are set up.");
      const current = this.store.participants(roomId);
      if (current.length >= MAX_AGENTS) throw new Error(`A room has at most ${MAX_AGENTS} agents.`);
      const [id] = assignHandles([this.providerFor(spec)], this.store.participants(roomId, true).map((p) => p.kind));
      const options = this.validOptions(spec.providerInstanceId, spec.model, spec.options ?? {});
      const p = this.store.addParticipant(roomId, { kind: id.handle, name: id.name, providerInstanceId: spec.providerInstanceId, model: spec.model, options });
      this.system(roomId, `Adding ${p.name} (@${p.kind}) to the room. Its new T3 thread starts with the room's record.`);
      await this.launchJoiner(roomId, p);
    });
  }

  private async launchJoiner(roomId: string, p: Participant) {
    const room = this.room(roomId);
    const all = this.store.messages(roomId);
    const decisions = this.store.decisions(roomId);
    const prompt = buildTransferPrompt({
      room,
      me: p,
      team: this.store.participants(roomId),
      names: this.names(roomId),
      reason: "join",
      from: room.permissionMode,
      to: room.permissionMode,
      previousLink: null,
      messages: all.filter((m) => m.kind !== "system"),
      decisions,
      tasks: this.store.tasks(roomId),
      handoff: null,
    });
    try {
      const res = await this.t3.launchThread({
        projectId: room.projectId,
        title: `${room.title} — ${p.name}`,
        providerInstanceId: p.providerInstanceId,
        model: p.model,
        message: prompt,
        clientRequestId: p.launchRequestId,
        workspace: room.projectId ? { kind: "root" } : { kind: "scratch" },
        runtimeMode: room.permissionMode,
        options: p.options,
      });
      const throughSeq = all.length ? all[all.length - 1].seq : 0;
      const cv = contextVersion(room, decisions);
      const d = this.store.addDelivery({ roomId, participantId: p.id, purpose: "join", messageSeqs: [], throughSeq, contextVersion: cv, envelope: prompt, sendMode: "queue", autoStep: null, countsAsTurn: false, taskId: null });
      this.store.updateDelivery(d.id, { state: "accepted", t3Delivery: "started", runId: res.runId });
      this.store.updateParticipant(p.id, {
        threadId: res.threadId,
        threadLink: res.link,
        threadMode: room.permissionMode,
        deliveredThroughSeq: throughSeq,
        contextVersion: cv,
        status: "working",
        statusDetail: "Catching up on the room",
        activeRunId: res.runId,
      });
    } catch (err) {
      this.store.updateParticipant(p.id, { status: "failed", statusDetail: actionable(err) });
      this.system(roomId, `Could not start ${p.name}'s thread: ${actionable(err)}. Remove it, or fix the cause and choose Resume.`);
    }
  }

  /**
   * Remove an agent from the room. Its messages stay in the record and its T3 thread stays in T3; it gets no more
   * turns, hand-offs or reviews.
   */
  removeAgent(roomId: string, kind: AgentKind) {
    return this.withRoom(roomId, async () => {
      const p = this.store.participantByKind(roomId, kind);
      if (!p || p.leftAt) throw new Error("No such agent in this room");
      if (this.store.participants(roomId).length <= 1) throw new Error("A room needs at least one agent.");
      if (this.store.tasks(roomId).some((t) => t.ownerKind === kind && ACTIVE_TASK.includes(t.status)))
        throw new TransitionError(`${p.name} has a task running. Wait for it to finish, or stop the room, first.`);
      for (const d of this.store.deliveries(roomId, "participant_id=? AND state IN ('pending','held')", p.id)) this.store.updateDelivery(d.id, { state: "cancelled" });
      if (p.threadId && this.store.deliveries(roomId, "participant_id=? AND state='accepted'", p.id).length)
        await this.t3.interrupt({ threadId: p.threadId }).catch(() => {});
      for (const d of this.store.deliveries(roomId, "participant_id=? AND state IN ('sending','accepted','uncertain')", p.id))
        this.store.updateDelivery(d.id, { state: "cancelled", error: "The agent was removed from the room." });
      for (const q of this.store.questions(roomId, "status='open' AND author=?", kind)) this.store.updateQuestion(q.id, { status: "dismissed" });
      this.store.updateParticipant(p.id, { leftAt: new Date().toISOString(), status: "stopped", statusDetail: "Removed from the room", transfer: null });
      if (p.threadId) await this.markThreadEnded(p.threadId, `${this.room(roomId).title} — ${p.name} (left the room)`);
      this.system(roomId, `${p.name} left the room. Its messages stay here; its T3 thread stays in T3.`);
      const room = this.room(roomId);
      if (room.status === "running" && !this.hasOpenDeliveries(roomId)) await this.pollRoom(roomId);
    });
  }

  // --------------------------------------------------------- human messages
  postHumanMessage(
    roomId: string,
    input: { body: string; target?: AgentKind | "all" | "room"; pin?: "decision" | "constraint" | null; order?: ReplyOrder; answers?: boolean },
  ) {
    return this.withRoom(roomId, async () => {
      const room = this.room(roomId);
      const body = input.body.trim();
      if (!body) throw new Error("Message is empty");
      const agents = this.kinds(roomId);
      const mentions = parseMentions(body, agents);
      let targets: AgentKind[];
      if (mentions.includes("all")) targets = [...agents];
      else if (mentions.length) targets = agents.filter((k) => mentions.includes(k));
      else if (input.target === "all") targets = [...agents];
      else if (input.target && agents.includes(input.target)) targets = [input.target];
      else targets = [];
      const toAll = targets.length === agents.length;
      // One agent first only makes sense when it is among several addressed.
      const order: ReplyOrder = targets.length > 1 && input.order && targets.includes(input.order) ? input.order : "parallel";

      const recipients: Recipient[] = toAll || targets.length === 0 ? ["all"] : [...targets];
      const kind: MessageKind = input.pin ? "decision" : targets.length ? "instruction" : "note";
      const msg = this.store.addMessage({
        roomId,
        author: "human",
        kind,
        recipients,
        body,
        deliveryState: targets.length ? "pending" : "recorded",
        meta: { targets, ...(targets.length > 1 ? { order } : {}), ...(input.answers ? { answers: true } : {}) },
      });
      // Writing in the room moves the conversation on: questions asked before it count as handled. Answers sent
      // from the questions panel are the exception, so the questions skipped there stay open.
      if (!input.answers) for (const q of this.store.questions(roomId, "status='open' AND seq<?", msg.seq)) this.store.updateQuestion(q.id, { status: "expired" });
      if (input.pin) this.store.addDecision(roomId, input.pin, body, msg.id);

      // Human input takes priority: stop automatic advancement before anything else.
      if (room.mode === "auto" && (room.status === "running" || room.status === "awaiting_decision")) {
        if (room.status === "running") {
          this.setStatus(room, "paused", "Automatic discussion paused for your message. Continue discussion when ready.");
          this.holdControllerDeliveries(roomId);
        }
      }
      // The agent going first is scheduled first: followers wait for turns created no later than theirs, so its
      // turn must exist before theirs (see dispatchPending).
      const scheduleOrder = order === "parallel" ? targets : [order, ...targets.filter((k) => k !== order)];
      for (const k of scheduleOrder) {
        const p = this.store.participantByKind(roomId, k)!;
        if (order !== "parallel" && k !== order) {
          // Answers after the chosen agent, with its answer in hand (see dispatchPending).
          this.scheduleTurn(room, p, "follow", { countsAsTurn: false, sendMode: "queue", human: true });
          continue;
        }
        const busy = this.store.deliveries(roomId, "participant_id=? AND state IN ('sending','accepted')", p.id).length > 0;
        this.scheduleTurn(room, p, busy ? "human_followup" : "reply", { countsAsTurn: false, sendMode: "auto", human: true });
      }
      if (targets.length && room.status === "idle") this.setStatus(room, "running");
      if (targets.length && room.status === "awaiting_decision") this.setStatus(room, "running");
      if (targets.length && room.status === "review_ready") this.setStatus(room, "running");
      await this.dispatchPending(roomId, { humanOnly: room.status === "paused" || room.status === "executing" });
      return this.store.message(msg.id)!;
    });
  }

  /** Ask one agent, or everyone, to respond to what they have not yet seen. */
  ask(roomId: string, target: AgentKind | "all") {
    return this.withRoom(roomId, async () => {
      const room = this.room(roomId);
      const agents = this.kinds(roomId);
      if (target !== "all" && !agents.includes(target)) throw new Error("No such agent in this room");
      const targets = target === "all" ? agents : [target];
      for (const k of targets) {
        const p = this.store.participantByKind(roomId, k)!;
        this.scheduleTurn(room, p, "reply", { countsAsTurn: false, sendMode: "queue", human: true });
      }
      if (["idle", "awaiting_decision", "review_ready"].includes(room.status)) this.setStatus(room, "running");
      await this.dispatchPending(roomId, { humanOnly: room.status === "paused" });
    });
  }

  // ------------------------------------------------------------ automatic
  startAuto(roomId: string) {
    return this.withRoom(roomId, async () => {
      const room = this.room(roomId);
      if (room.phase !== "discussion") throw new TransitionError("Discussion is closed; the room is executing.");
      if (room.status === "setting_up") throw new TransitionError("Participants are still being set up.");
      this.store.updateRoom(roomId, { mode: "auto" });
      room.mode = "auto";
      if (room.status === "paused") this.releaseHeld(roomId);
      if (room.status !== "running") this.setStatus(room, "running");
      await this.advanceAuto(roomId);
      await this.dispatchPending(roomId);
    });
  }

  /** Continue: resume the automatic sequence, or run one more exchange round once it is done. */
  continueDiscussion(roomId: string) {
    return this.withRoom(roomId, async () => {
      const room = this.room(roomId);
      if (room.phase !== "discussion") throw new TransitionError("Discussion is closed; the room is executing.");
      if (room.status === "paused") this.releaseHeld(roomId);
      if (room.status !== "running") this.setStatus(room, "running");
      if (room.mode === "manual") {
        this.store.updateRoom(roomId, { mode: "auto" });
        room.mode = "auto";
      }
      if (room.autoStep >= AUTO_STEPS.length && !this.hasOpenControllerTurns(roomId)) {
        // One extra round: each agent replies to the other's latest contributions.
        const agents = this.kinds(roomId);
        if (room.turnsUsed + agents.length > room.turnLimit) {
          this.setStatus(room, "awaiting_decision", `Turn limit (${room.turnLimit}) reached. Raise the limit to continue.`);
          return;
        }
        for (const k of agents) this.scheduleTurn(room, this.store.participantByKind(roomId, k)!, "reply", { autoStep: room.autoStep, countsAsTurn: true, sendMode: "queue" });
        this.store.updateRoom(roomId, { autoStep: room.autoStep + 1 });
      } else {
        await this.advanceAuto(roomId);
      }
      await this.dispatchPending(roomId);
    });
  }

  setTurnLimit(roomId: string, limit: number) {
    return this.withRoom(roomId, async () => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Turn limit must be 1–50");
      this.store.updateRoom(roomId, { turnLimit: limit });
    });
  }

  /**
   * Permission mode for threads the room starts from now on (implementation and review tasks). T3 keeps an existing
   * thread's mode ("Permission modes stay"), so the agents' discussion threads are unchanged.
   */
  setPermissionMode(roomId: string, mode: PermissionMode) {
    return this.withRoom(roomId, async () => {
      const room = this.room(roomId);
      if (!PERMISSION_MODES.includes(mode)) throw new Error(`Unknown permission mode: ${mode}`);
      const cap = this.t3.status().maxPermission;
      if (cap && PERMISSION_MODES.indexOf(mode) > PERMISSION_MODES.indexOf(cap))
        throw new Error(`T3 lets Team Room start threads up to ${PERMISSION_LABELS[cap]}. Raise Team Room's access first (Access · change).`);
      if (mode === room.permissionMode) return;
      this.store.updateRoom(roomId, { permissionMode: mode });
      this.system(
        roomId,
        `Agent permissions for new threads: ${PERMISSION_LABELS[mode]} (was ${PERMISSION_LABELS[room.permissionMode]}). Implementation and review tasks start with it. The agents' discussion threads keep ${PERMISSION_LABELS[room.permissionMode]}: T3 does not change an existing thread's mode.`,
      );
    });
  }

  /**
   * Move agents to new T3 threads that run with `mode`. T3 never changes an existing thread's mode, so the agent
   * continues in a fresh thread that receives the room's record (brief, pinned decisions, tasks, transcript) and,
   * when `handoff` is set, a handoff note the agent first writes in its old thread with what only it knows.
   */
  transferAgents(roomId: string, input: { mode: PermissionMode; agents: AgentKind[]; handoff: boolean }) {
    return this.withRoom(roomId, async () => {
      const room = this.room(roomId);
      const mode = input.mode;
      if (!PERMISSION_MODES.includes(mode)) throw new Error(`Unknown permission mode: ${mode}`);
      const cap = this.t3.status().maxPermission;
      if (cap && PERMISSION_MODES.indexOf(mode) > PERMISSION_MODES.indexOf(cap))
        throw new Error(`T3 lets Team Room start threads up to ${PERMISSION_LABELS[cap]}. Raise Team Room's access first (Access · change).`);
      const current = this.kinds(roomId);
      const agents = [...new Set(input.agents)].filter((k) => current.includes(k));
      if (!agents.length) throw new Error("Choose at least one agent to move.");
      if (room.status === "setting_up") throw new TransitionError("Wait until the agents' threads are set up.");
      const from = room.permissionMode;
      if (mode !== from) this.store.updateRoom(roomId, { permissionMode: mode });
      const requestedAt = new Date().toISOString();
      for (const k of agents) {
        const p = this.store.participantByKind(roomId, k)!;
        if (p.transfer) throw new TransitionError(`${p.name} is already moving to a new thread.`);
        // Turns not yet sent would land in the old thread; their messages travel in the new thread's transcript instead.
        for (const d of this.store.deliveries(roomId, "participant_id=? AND state IN ('pending','held')", p.id)) this.store.updateDelivery(d.id, { state: "cancelled" });
        if (p.threadId && ["working", "queued", "awaiting_input"].includes(p.status)) {
          await this.t3.interrupt({ threadId: p.threadId }).catch(() => {});
          this.system(roomId, `Stopped ${p.name}'s current turn so it can hand off.`);
        }
        const handoff = input.handoff && p.threadId ? this.scheduleTurn(room, p, "handoff", { countsAsTurn: false, sendMode: "queue", human: true }) : null;
        this.store.updateParticipant(p.id, {
          transfer: { mode, from: p.threadMode ?? from, handoffDeliveryId: handoff?.id ?? null, requestedAt },
          statusDetail: handoff ? "Writing a handoff note before moving to a new thread" : "Moving to a new thread",
        });
      }
      this.system(
        roomId,
        `Moving ${listNames(agents.map((k) => this.nameOf(roomId, k)))} to new T3 thread${agents.length > 1 ? "s" : ""} with ${PERMISSION_LABELS[mode]}` +
          (input.handoff ? ". Each first writes a handoff note in its current thread." : "."),
      );
      await this.dispatchPending(roomId, { humanOnly: true });
      await this.advanceTransfers(roomId);
    });
  }

  /** Launch the successor thread for every agent whose handoff note is in (or that moves without one). */
  private async advanceTransfers(roomId: string) {
    for (const p of this.store.participants(roomId)) {
      if (!p.transfer) continue;
      let note: string | null = null;
      if (p.transfer.handoffDeliveryId) {
        const d = this.store.delivery(p.transfer.handoffDeliveryId);
        if (d && ["pending", "held", "sending", "accepted", "uncertain"].includes(d.state)) continue; // still writing
        note = this.store.messages(roomId).find((m) => m.deliveryId === d?.id)?.body ?? null;
        if (!note) this.system(roomId, `${p.name} did not write a handoff note (${d?.runStatus ?? d?.state ?? "no turn"}); moving it with the room's record only.`);
      }
      await this.launchSuccessor(roomId, p, note);
    }
  }

  private async launchSuccessor(roomId: string, p: Participant, note: string | null) {
    const room = this.room(roomId);
    const t = p.transfer!;
    const all = this.store.messages(roomId);
    const decisions = this.store.decisions(roomId);
    const prompt = buildTransferPrompt({
      room,
      me: p,
      team: this.store.participants(roomId),
      names: this.names(roomId),
      from: t.from,
      to: t.mode,
      previousLink: p.threadLink,
      messages: all.filter((m) => m.kind !== "system"),
      decisions,
      tasks: this.store.tasks(roomId),
      handoff: note,
    });
    try {
      const res = await this.t3.launchThread({
        projectId: room.projectId,
        title: `${room.title} — ${p.name}`,
        providerInstanceId: p.providerInstanceId,
        model: p.model,
        message: prompt,
        clientRequestId: `${p.launchRequestId}-transfer-${p.previousThreads.length + 1}`,
        workspace: room.projectId ? { kind: "root" } : { kind: "scratch" },
        runtimeMode: t.mode,
        options: p.options,
      });
      const throughSeq = all.length ? all[all.length - 1].seq : 0;
      const cv = contextVersion(room, decisions);
      // Record the first turn as a delivery so its reply is posted as this agent's contribution.
      const d = this.store.addDelivery({ roomId, participantId: p.id, purpose: "transfer", messageSeqs: [], throughSeq, contextVersion: cv, envelope: prompt, sendMode: "queue", autoStep: null, countsAsTurn: false, taskId: null });
      this.store.updateDelivery(d.id, { state: "accepted", t3Delivery: "started", runId: res.runId });
      this.store.updateParticipant(p.id, {
        previousThreads: p.threadId ? [...p.previousThreads, { threadId: p.threadId, link: p.threadLink, mode: t.from, endedAt: new Date().toISOString() }] : p.previousThreads,
        threadId: res.threadId,
        threadLink: res.link,
        threadMode: t.mode,
        readPosition: null,
        deliveredThroughSeq: throughSeq,
        contextVersion: cv,
        status: "working",
        statusDetail: null,
        activeRunId: res.runId,
        transfer: null,
      });
      // Both threads would otherwise carry the same title in T3's sidebar; mark the old one as ended.
      if (p.threadId) await this.markThreadEnded(p.threadId, `${room.title} — ${p.name} (earlier thread, ended)`);
      this.system(
        roomId,
        `${p.name} now runs in a new T3 thread with ${PERMISSION_LABELS[t.mode]}, carrying the room's record${note ? " and its handoff note" : ""}. Its previous thread stays in T3, renamed "(earlier thread, ended)".`,
      );
    } catch (err) {
      const transient = !(err instanceof T3ToolError) || ["transport_error", "auth_expired", "not_connected"].includes(err.code);
      if (transient) {
        // Retried on the next tick with the same clientRequestId, which T3 de-duplicates.
        this.store.updateParticipant(p.id, { statusDetail: `Moving to a new thread: ${actionable(err)}; retrying.` });
        return;
      }
      this.store.updateParticipant(p.id, { transfer: null, status: "failed", statusDetail: `Could not start the new thread: ${actionable(err)}` });
      this.system(roomId, `Could not move ${p.name} to a new thread: ${actionable(err)}. It stays in its current thread.`);
    }
  }

  /**
   * Ask an agent (by default the one that spoke last in the range) to summarize messages #from–#to for the human.
   * The reply is posted to the human only: not relayed to the other agent, not a discussion turn, no hand-offs.
   */
  summarize(roomId: string, input: { from: number; to: number; agent?: AgentKind | null }) {
    return this.withRoom(roomId, async () => {
      const room = this.room(roomId);
      const from = Math.floor(Number(input.from));
      const to = Math.floor(Number(input.to));
      if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new Error("Choose a range of messages to summarize.");
      const range = this.store.messages(roomId).filter((m) => m.seq >= from && m.seq <= to && m.kind !== "system");
      const agents = this.kinds(roomId);
      const agentMsgs = range.filter((m) => m.author !== "human" && m.author !== "system");
      if (!agentMsgs.length) throw new Error("There is no agent discussion in that range to summarize.");
      // The agent asked for, else the last one in the range that is still in the room.
      const kind = input.agent && agents.includes(input.agent) ? input.agent : ([...agentMsgs].reverse().find((m) => agents.includes(m.author))?.author ?? agents[0]);
      const p = this.store.participantByKind(roomId, kind)!;
      if (!p.threadId || p.transfer) throw new TransitionError(`${p.name} is not available right now.`);
      const open = this.store.deliveries(roomId, "purpose='summary' AND state IN ('pending','held','sending','accepted')");
      if (open.some((d) => Math.min(...d.messageSeqs) === from && Math.max(...d.messageSeqs) === to)) throw new TransitionError("That summary is already being written.");
      const envelope = buildSummaryEnvelope({ room, me: p, names: this.names(roomId), messages: range, from, to });
      // The envelope is built here (not at send time) and does not move the agent's relay position:
      // anything it has not been sent yet still arrives with its next real turn.
      const d = this.store.addDelivery({
        roomId,
        participantId: p.id,
        purpose: "summary",
        messageSeqs: range.map((m) => m.seq),
        throughSeq: p.deliveredThroughSeq,
        contextVersion: p.contextVersion,
        envelope,
        sendMode: "queue",
        autoStep: null,
        countsAsTurn: false,
        taskId: null,
      });
      this.system(roomId, `Asked ${p.name} to summarize #${from}–#${to}.`);
      if (!this.store.deliveries(roomId, "participant_id=? AND state IN ('sending','accepted') AND id<>?", p.id, d.id).length) await this.sendDelivery(this.store.delivery(d.id)!, false);
    });
  }

  /**
   * Answer open questions in one message (one turn per agent, not per question). Each question is quoted with its
   * answer; it goes to the agent(s) who asked. Blank answers are skipped.
   */
  async answerQuestions(roomId: string, answers: { id: string; text: string }[]) {
    const open = new Map(this.store.questions(roomId, "status='open'").map((q) => [q.id, q]));
    const given = answers.map((a) => ({ q: open.get(a.id), text: a.text.trim() })).filter((a): a is { q: Question; text: string } => !!a.q && !!a.text);
    if (!given.length) throw new Error("Write an answer to at least one open question.");
    const authors = [...new Set(given.map((a) => a.q.author))];
    const block = (k: AgentKind) =>
      given
        .filter((a) => a.q.author === k)
        .map((a) => `> ${this.nameOf(roomId, k)} asked (#${a.q.seq}): ${a.q.text}\n\n${a.text}`)
        .join("\n\n");
    const body =
      authors.length === 1
        ? `**Answers to your question${given.length > 1 ? "s" : ""}**\n\n${block(authors[0])}`
        : `**Answers to your questions**\n\n${authors.map((k) => `**For ${this.nameOf(roomId, k)}**\n\n${block(k)}`).join("\n\n")}`;
    // To the agents who asked (all of them at once if they are everyone); an agent that has left gets nothing.
    const present = this.kinds(roomId);
    const to = authors.filter((k) => present.includes(k));
    const msg = await this.postHumanMessage(roomId, {
      body: to.length > 1 && to.length < present.length ? `${to.map((k) => `@${k}`).join(" ")}\n\n${body}` : body,
      target: to.length === 1 ? to[0] : to.length ? "all" : "room",
      answers: true,
    });
    for (const a of given) this.store.updateQuestion(a.q.id, { status: "answered", answerSeq: msg.seq });
    this.onChange(roomId);
    return msg;
  }

  dismissQuestion(roomId: string, id: string) {
    return this.withRoom(roomId, async () => {
      const q = this.store.questions(roomId, "id=?", id)[0];
      if (!q) throw new Error("Question not found");
      this.store.updateQuestion(id, { status: q.status === "dismissed" ? "open" : "dismissed" });
    });
  }

  /** Keep only settings T3 lists for this model, with values it accepts. */
  private validOptions(providerInstanceId: string, model: string, options: Record<string, string | boolean>) {
    const known = this.t3.status().providers.find((p) => p.instanceId === providerInstanceId)?.models.find((m) => m.slug === model)?.options ?? [];
    const out: Record<string, string | boolean> = {};
    for (const [id, v] of Object.entries(options)) {
      const o = known.find((x) => x.id === id);
      if (!o) throw new Error(`${model} has no "${id}" setting in T3.`);
      if (!o.values.includes(v)) throw new Error(`${id} must be one of ${o.values.join(", ")}`);
      out[id] = v;
    }
    return out;
  }

  /**
   * Change an agent's model settings, e.g. its thinking level. Unlike permissions, T3 lets these change on a running
   * thread (t3_thread_configure); they apply from the agent's next turn, and to tasks it starts later.
   */
  setAgentOptions(roomId: string, kind: AgentKind, options: Record<string, string | boolean>) {
    return this.withRoom(roomId, async () => {
      const p = this.store.participantByKind(roomId, kind);
      if (!p) throw new Error("No such agent in this room");
      const next = { ...p.options, ...this.validOptions(p.providerInstanceId, p.model, options) };
      if (JSON.stringify(next) === JSON.stringify(p.options)) return;
      if (p.threadId) await this.t3.configureThread({ threadId: p.threadId, providerInstanceId: p.providerInstanceId, model: p.model, options: next });
      this.store.updateParticipant(p.id, { options: next });
      const changed = Object.entries(next).filter(([k, v]) => p.options[k] !== v).map(([k, v]) => `${k === "effort" || k === "reasoningEffort" ? "thinking" : k} ${v}`);
      this.system(roomId, `${p.name}: ${changed.join(", ")}. Applies from its next turn.`);
    });
  }

  /**
   * Switch an agent to another model of its provider. T3 changes it on the running thread (t3_thread_configure),
   * from the agent's next turn. Settings the new model doesn't offer (e.g. a thinking level) fall back to its defaults.
   */
  setAgentModel(roomId: string, kind: AgentKind, model: string) {
    return this.withRoom(roomId, async () => {
      const p = this.store.participantByKind(roomId, kind);
      if (!p) throw new Error("No such agent in this room");
      if (model === p.model) return;
      const provider = this.t3.status().providers.find((x) => x.instanceId === p.providerInstanceId);
      const target = provider?.models.find((m) => m.slug === model);
      if (!target) throw new Error(`${provider?.displayName ?? p.providerInstanceId} has no model "${model}".`);
      const options: Record<string, string | boolean> = {};
      for (const [id, v] of Object.entries(p.options)) if (target.options?.some((o) => o.id === id && o.values.includes(v))) options[id] = v;
      if (p.threadId) await this.t3.configureThread({ threadId: p.threadId, providerInstanceId: p.providerInstanceId, model, options });
      this.store.updateParticipant(p.id, { model, options });
      const dropped = Object.keys(p.options).filter((k) => !(k in options));
      this.system(roomId, `${p.name} now uses ${target.name}${dropped.length ? ` (its ${dropped.map((k) => (k === "effort" || k === "reasoningEffort" ? "thinking level" : k)).join(", ")} reset to the model's default)` : ""}. Applies from its next turn.`);
    });
  }

  /** Best effort: a failed rename only leaves the old title. */
  private async markThreadEnded(threadId: string, title: string) {
    await this.t3.renameThread({ threadId, title, clientRequestId: `tr-rename-${threadId}` }).catch((err) => console.error("[rename]", actionable(err)));
  }

  setPeerLimit(roomId: string, limit: number) {
    return this.withRoom(roomId, async () => {
      checkPeerLimit(limit);
      this.store.updateRoom(roomId, { peerLimit: limit });
    });
  }

  updateBrief(roomId: string, brief: string) {
    return this.withRoom(roomId, async () => {
      const room = this.room(roomId);
      this.store.updateRoom(roomId, { brief, briefVersion: room.briefVersion + 1 });
      this.system(roomId, "The task brief was updated. Agents receive the new brief with their next turn.");
    });
  }

  /** If the current auto step is finished, schedule the next one (within the turn budget). */
  private async advanceAuto(roomId: string) {
    const room = this.room(roomId);
    if (room.mode !== "auto" || room.status !== "running" || room.phase !== "discussion") return;
    if (this.hasOpenControllerTurns(roomId)) return;
    if (room.autoStep >= AUTO_STEPS.length) {
      if (!this.hasOpenDeliveries(roomId)) this.finishRound(room);
      return;
    }
    const purpose = AUTO_STEPS[room.autoStep];
    const agents = this.kinds(roomId);
    if (room.turnsUsed + agents.length > room.turnLimit) {
      this.finishRound(room, true);
      return;
    }
    for (const k of agents) {
      this.scheduleTurn(room, this.store.participantByKind(roomId, k)!, purpose, { autoStep: room.autoStep, countsAsTurn: true, sendMode: "queue" });
    }
    this.store.updateRoom(roomId, { autoStep: room.autoStep + 1 });
  }

  private finishRound(room: Room, limitReached = false) {
    this.setStatus(
      room,
      "awaiting_decision",
      limitReached
        ? `Turn limit (${room.turnLimit}) reached. Review the proposals and decide.`
        : "Discussion round complete. Review proposals, agreements, disagreements and questions, then decide.",
    );
    this.system(room.id, limitReached ? "Automatic discussion stopped at the turn limit." : "Automatic discussion round complete — your decision.");
  }

  private hasOpenControllerTurns(roomId: string) {
    return this.store.deliveries(roomId, "counts_as_turn=1 AND state IN ('pending','held','sending','accepted','uncertain')").length > 0;
  }
  private hasOpenDeliveries(roomId: string) {
    return this.store.deliveries(roomId, "state IN ('pending','held','sending','accepted','uncertain')").length > 0;
  }

  // ------------------------------------------------------- pause/stop/resume
  pause(roomId: string) {
    return this.withRoom(roomId, async () => {
      const room = this.room(roomId);
      if (room.status === "paused") return;
      this.setStatus(room, "paused", PAUSED_BY_YOU);
      this.holdControllerDeliveries(roomId);
      this.system(roomId, "Discussion paused. Agents already working will finish their current turn; nothing new is scheduled.");
    });
  }

  stop(roomId: string) {
    return this.withRoom(roomId, async () => {
      const room = this.room(roomId);
      // Cancel everything not yet sent.
      for (const d of this.store.deliveries(roomId, "state IN ('pending','held')")) this.store.updateDelivery(d.id, { state: "cancelled" });
      this.setStatus(room, "stopping", "Stop requested. Waiting for T3 to report each run has ended.");
      const results: string[] = [];
      const threads: { threadId: string; name: string; participantId?: string; taskId?: string }[] = [];
      for (const p of this.store.participants(roomId)) if (p.threadId) threads.push({ threadId: p.threadId, name: p.name, participantId: p.id });
      for (const t of this.store.tasks(roomId))
        if (t.threadId && ["working", "launching", "awaiting_input"].includes(t.status))
          threads.push({ threadId: t.threadId, name: `${this.nameOf(roomId, t.ownerKind)} (${t.kind})`, taskId: t.id });
      for (const th of threads) {
        const active = th.participantId
          ? this.store.deliveries(roomId, "participant_id=? AND state='accepted'", th.participantId).length > 0
          : true;
        if (!active) continue;
        try {
          const r = await this.t3.interrupt({ threadId: th.threadId });
          results.push(`${th.name}: interrupt ${r.status}`);
          if (th.participantId) this.store.updateParticipant(th.participantId, { status: "stopping", statusDetail: "Interrupt requested" });
        } catch (err) {
          results.push(`${th.name}: ${actionable(err)}`);
        }
      }
      // T3's Stop holds queued turns; those deliveries will not run, so close them.
      for (const d of this.store.deliveries(roomId, "state='accepted' AND t3_delivery='queued'"))
        this.store.updateDelivery(d.id, { state: "cancelled", error: "Held by T3 when the room was stopped; not run." });
      this.system(roomId, `Stop requested. ${results.length ? results.join("; ") : "No agent was running."} Status updates when T3 confirms runs ended.`);
      await this.pollRoom(roomId);
    });
  }

  resume(roomId: string) {
    return this.withRoom(roomId, async () => {
      const room = this.room(roomId);
      this.setStatus(room, "reconciling", "Re-reading T3 state before continuing…");
      await this.setupParticipants(roomId);
      // Uncertain deliveries: replay with the same clientRequestId. T3 derives
      // command/message ids from it, so a delivery it already accepted is
      // returned as-is rather than duplicated.
      for (const d of this.store.deliveries(roomId, "state='uncertain'")) await this.sendDelivery(d, true);
      await this.pollRoom(roomId);
      const r = this.room(roomId);
      if (r.status !== "reconciling") return;
      if (this.store.deliveries(roomId, "state='uncertain'").length) {
        this.setStatus(r, "needs_attention", "Some deliveries are still uncertain. Check the participant threads in T3.");
        return;
      }
      this.releaseHeld(roomId);
      if (r.phase === "execution") {
        const tasks = this.store.tasks(roomId);
        if (tasks.some((t) => ["working", "launching", "awaiting_input", "queued"].includes(t.status))) this.setStatus(r, "executing");
        else if (tasks.some((t) => t.kind === "review" && t.status === "completed")) this.setStatus(r, "review_ready");
        else this.setStatus(r, "idle");
        return;
      }
      if (r.mode === "auto" && (r.autoStep < AUTO_STEPS.length || this.hasOpenDeliveries(roomId))) {
        this.setStatus(r, "running");
        await this.advanceAuto(roomId);
      } else if (this.hasOpenDeliveries(roomId)) this.setStatus(r, "running");
      else if (r.mode === "auto" && r.autoStep > 0) this.setStatus(r, "awaiting_decision", "Discussion round complete.");
      else this.setStatus(r, "idle");
      await this.dispatchPending(roomId);
    });
  }

  private holdControllerDeliveries(roomId: string) {
    for (const d of this.store.deliveries(roomId, "state='pending' AND counts_as_turn=1")) this.store.updateDelivery(d.id, { state: "held" });
  }
  private releaseHeld(roomId: string) {
    for (const d of this.store.deliveries(roomId, "state='held'")) this.store.updateDelivery(d.id, { state: "pending" });
  }

  // ------------------------------------------------------------- deliveries
  private scheduleTurn(
    room: Room,
    p: Participant,
    purpose: TurnPurpose,
    opts: { autoStep?: number; countsAsTurn: boolean; sendMode: "auto" | "queue"; human?: boolean },
  ): Delivery {
    const d = this.store.addDelivery({
      roomId: room.id,
      participantId: p.id,
      purpose,
      messageSeqs: [],
      throughSeq: 0,
      contextVersion: null,
      envelope: "",
      sendMode: opts.sendMode,
      autoStep: opts.autoStep ?? null,
      countsAsTurn: opts.countsAsTurn,
      taskId: null,
    });
    if (room.status === "paused" && !opts.human) this.store.updateDelivery(d.id, { state: "held" });
    return this.store.delivery(d.id)!;
  }

  /**
   * Build the envelope at send time (so it contains exactly the messages the
   * participant has not received yet) and send it. One in-flight controller
   * turn per participant; human messages may steer or queue behind it.
   */
  private async dispatchPending(roomId: string, opts: { humanOnly?: boolean } = {}) {
    for (const d of this.store.deliveries(roomId, "state='pending'")) {
      if (opts.humanOnly && d.countsAsTurn) continue;
      const p = this.store.participant(d.participantId)!;
      if (!p.threadId) continue; // waits for setup
      const busy = this.store.deliveries(roomId, "participant_id=? AND state IN ('sending','accepted') AND id<>?", p.id, d.id);
      if (busy.length && d.sendMode === "queue") continue;
      if (d.purpose === "follow") {
        // Wait until the agent going first has answered: no other agent's turn from before this one, other than
        // the followers', is still open.
        const leadOpen = this.store.deliveries(
          roomId,
          "participant_id<>? AND purpose<>'follow' AND state IN ('pending','held','sending','accepted','uncertain') AND created_at<=?",
          p.id,
          d.createdAt,
        );
        if (leadOpen.length) continue;
      }
      if (d.purpose === "critique" || d.purpose === "response") {
        // These need every other agent's previous contribution (proposal, critique) in the room first.
        const prev = d.purpose === "critique" ? "proposal" : "critique";
        const otherOpen = this.store.deliveries(roomId, "participant_id<>? AND purpose=? AND state IN ('pending','held','sending','accepted')", p.id, prev);
        if (otherOpen.length) continue;
      }
      if (d.purpose !== "summary") this.prepareEnvelope(d, p); // a summary's envelope is fixed when requested
      await this.sendDelivery(this.store.delivery(d.id)!, false);
    }
  }

  private prepareEnvelope(d: Delivery, p: Participant) {
    const room = this.room(d.roomId);
    const messages = this.store.messages(d.roomId);
    let throughSeq = messages.length ? messages[messages.length - 1].seq : 0;
    const isPeer = (m: RoomMessage) => m.author !== "human" && m.author !== "system" && m.author !== p.kind;
    if (d.purpose === "proposal") {
      // Proposals are blind: stop before the first unseen contribution of another agent, which is
      // then relayed with the critique turn instead.
      const firstPeer = messages.find((m) => m.seq > p.deliveredThroughSeq && isPeer(m) && visibleTo(p.kind, m));
      if (firstPeer) throughSeq = firstPeer.seq - 1;
    }
    const decisions = this.store.decisions(d.roomId);
    const cv = contextVersion(room, decisions);
    const pending = pendingFor(p, messages, throughSeq);
    const turnNumber = this.store.deliveries(d.roomId, "participant_id=? AND state IN ('accepted','completed')", p.id).length + 1;
    const focusKind = d.purpose === "critique" ? "proposal" : d.purpose === "response" ? "critique" : null;
    // The latest proposal (or critique) of each other agent.
    const focus = focusKind
      ? this.kinds(d.roomId)
          .filter((k) => k !== p.kind)
          .map((k) => [...messages].reverse().find((m) => m.author === k && m.kind === focusKind))
          .filter((m): m is RoomMessage => !!m)
          .sort((a, b) => a.seq - b.seq)
      : [];
    // Who this turn answers: the agent that went first (follow), or that spoke to this one (peer_update, peer_question).
    const handles = this.kinds(d.roomId);
    const from =
      d.purpose === "follow"
        ? (([...pending].reverse().find((m) => m.author === "human" && m.meta?.order && m.meta.order !== "parallel")?.meta.order as AgentKind | undefined) ??
          [...pending].reverse().find(isPeer)?.author ??
          null)
        : d.purpose === "peer_question"
          ? ([...pending].reverse().find((m) => isPeer(m) && parseMentions(m.body, handles).includes(p.kind))?.author ?? null)
          : d.purpose === "peer_update"
            ? ([...pending].reverse().find(isPeer)?.author ?? null)
            : null;
    const inFlight =
      d.purpose === "human_followup"
        ? (this.store.deliveries(d.roomId, "participant_id=? AND state='accepted' AND id<>?", p.id, d.id).at(-1)?.purpose ?? null)
        : null;
    const envelope = buildEnvelope({
      room,
      me: p,
      team: this.store.participants(d.roomId),
      names: this.names(d.roomId),
      from,
      purpose: d.purpose,
      messages: pending,
      decisions,
      includeContext: p.contextVersion !== cv,
      turnNumber,
      focus,
      inFlight,
    });
    this.store.db
      .prepare("UPDATE deliveries SET envelope=?, message_seqs=?, through_seq=?, context_version=? WHERE id=?")
      .run(envelope, JSON.stringify(pending.map((m) => m.seq)), throughSeq, cv, d.id);
  }

  private async sendDelivery(d: Delivery, replay: boolean) {
    const p = this.store.participant(d.participantId)!;
    if (!p.threadId) return;
    this.store.updateDelivery(d.id, { state: "sending", error: null });
    this.markMessages(d, "sending");
    try {
      const res = await this.t3.send({ threadId: p.threadId, message: d.envelope, mode: d.sendMode, clientRequestId: d.id });
      this.store.tx(() => {
        this.store.updateDelivery(d.id, { state: "accepted", t3Delivery: res.delivery, runId: res.runId });
        const fresh = this.store.participant(p.id)!;
        this.store.updateParticipant(p.id, {
          deliveredThroughSeq: Math.max(fresh.deliveredThroughSeq, d.throughSeq),
          contextVersion: d.contextVersion,
          status: res.delivery === "queued" ? (fresh.status === "working" ? "working" : "queued") : "working",
          statusDetail: res.delivery === "queued" ? "Message queued behind the active turn" : res.delivery === "steered" ? "Message steered into the active turn" : null,
          activeRunId: res.runId ?? fresh.activeRunId,
        });
        // Turns are counted on acceptance, so a replayed uncertain send counts once.
        if (d.countsAsTurn) this.store.updateRoom(d.roomId, { turnsUsed: this.room(d.roomId).turnsUsed + 1 });
      });
      this.markMessages(d, res.delivery === "queued" ? "queued" : "delivered");
    } catch (err) {
      const definite = err instanceof T3ToolError && !["transport_error", "auth_expired", "not_connected"].includes(err.code);
      // Rejected before T3 accepted anything (no connection, or 401): safe to send later.
      const notSent = err instanceof T3ToolError && (err.code === "not_connected" || err.code === "auth_expired");
      if (notSent) {
        this.store.updateDelivery(d.id, { state: "pending", error: actionable(err) });
        this.markMessages(d, "pending");
      } else if (definite) {
        this.store.updateDelivery(d.id, { state: "failed", error: actionable(err) });
        this.store.updateParticipant(p.id, { status: "failed", statusDetail: actionable(err) });
        this.markMessages(d, "failed");
        this.system(d.roomId, `Could not deliver to ${p.name}: ${actionable(err)}`);
      } else {
        // We cannot tell whether T3 accepted it. Do not retry blindly.
        this.store.updateDelivery(d.id, { state: "uncertain", error: actionable(err) });
        this.markMessages(d, "uncertain");
        const room = this.room(d.roomId);
        if (room.status !== "needs_attention" && TRANSITIONS[room.status].includes("needs_attention"))
          this.setStatus(room, "needs_attention", `Delivery to ${p.name} is uncertain (${actionable(err)}). Resume to reconcile.`);
      }
    }
  }

  /** Reflect a delivery's state on the human messages it carries. */
  private markMessages(d: Delivery, state: MessageDeliveryState) {
    if (d.purpose === "summary") return; // re-reading messages to summarize them is not delivering them
    const p = this.store.participant(d.participantId)!;
    const msgs = this.store.messages(d.roomId).filter((m) => d.messageSeqs.includes(m.seq) && m.author === "human");
    for (const m of msgs) {
      const per = { ...(m.meta.perTarget ?? {}) } as Record<string, string>;
      if ((m.meta.targets ?? []).includes(p.kind) || m.kind === "note" || m.kind === "decision") {
        per[p.kind] = state;
        const targets: string[] = m.meta.targets?.length ? m.meta.targets : [];
        const overall = combine(targets.length ? targets.map((t) => per[t] ?? "pending") : Object.values(per));
        this.store.updateMessage(m.id, { meta: { ...m.meta, perTarget: per }, deliveryState: m.kind === "note" ? "recorded" : overall });
      }
    }
  }

  // ------------------------------------------------------------ polling
  /** True while any agent of any room has work in flight (turns, tasks, moves). */
  isBusy(): boolean {
    return this.store.rooms().some(
      (room) =>
        ["running", "executing", "stopping", "setting_up", "reconciling"].includes(room.status) ||
        this.store.deliveries(room.id, "state IN ('pending','sending','accepted')").length > 0 ||
        this.store.tasks(room.id).some((t) => ["launching", "working", "awaiting_input"].includes(t.status)) ||
        this.store.participants(room.id).some((p) => p.transfer),
    );
  }

  /** Poll every room with work in flight. Called by the server loop. */
  async tick() {
    for (const room of this.store.rooms()) {
      const active =
        this.store.deliveries(room.id, "state IN ('sending','accepted','pending')").length > 0 ||
        this.store.tasks(room.id).some((t) => ["launching", "working", "awaiting_input"].includes(t.status)) ||
        room.status === "stopping" ||
        room.status === "setting_up" ||
        this.store.participants(room.id).some((p) => p.transfer);
      if (!active) continue;
      await this.withRoom(room.id, async () => {
        if (this.room(room.id).status === "setting_up") await this.setupParticipants(room.id);
        await this.pollRoom(room.id);
        await this.advanceTransfers(room.id);
        await this.dispatchPending(room.id, { humanOnly: this.room(room.id).status === "paused" });
      });
    }
  }

  private async pollRoom(roomId: string) {
    for (const p of this.store.participants(roomId)) {
      if (!p.threadId) continue;
      const open = this.store.deliveries(roomId, "participant_id=? AND state IN ('accepted')", p.id);
      if (!open.length && p.status !== "stopping" && p.status !== "awaiting_input") continue;
      let snap: ThreadSnapshot;
      try {
        snap = await this.t3.readThread({ threadId: p.threadId, afterPosition: p.readPosition });
      } catch (err) {
        this.store.updateParticipant(p.id, { statusDetail: `Cannot read thread: ${actionable(err)}` });
        continue;
      }
      this.ingestParticipant(roomId, p, snap, open);
    }
    await this.pollTasks(roomId);
    const room = this.room(roomId);
    if (room.status === "stopping") {
      const stillRunning = this.store.participants(roomId).some((p) => p.status === "stopping" || p.status === "working");
      const tasksRunning = this.store.tasks(roomId).some((t) => ["working", "launching"].includes(t.status));
      if (!stillRunning && !tasksRunning) {
        this.setStatus(room, "paused", STOPPED);
        this.system(roomId, "All agents stopped (confirmed by T3).");
      }
    }
    if (room.status === "running") {
      await this.advanceAuto(roomId);
      const r = this.room(roomId);
      if (r.status === "running" && r.mode === "manual" && !this.hasOpenDeliveries(roomId)) this.setStatus(r, "idle");
      if (r.status === "running" && r.mode === "auto" && r.autoStep >= AUTO_STEPS.length && !this.hasOpenDeliveries(roomId)) this.finishRound(r);
    }
    if (room.status === "paused" && !this.hasOpenDeliveries(roomId) && room.statusDetail?.startsWith("Paused")) {
      /* stays paused until the human continues */
    }
  }

  /** Record finished runs as room messages, exactly once per run. */
  private ingestParticipant(roomId: string, p: Participant, snap: ThreadSnapshot, open: Delivery[]) {
    const runStatus = new Map(snap.runs.map((r) => [r.runId, r]));
    const byRun = new Map<string, typeof snap.items>();
    for (const it of snap.items) {
      if (it.role !== "assistant" || !it.runId) continue;
      if (!byRun.has(it.runId)) byRun.set(it.runId, []);
      byRun.get(it.runId)!.push(it);
    }
    let minUnfinishedPos: number | null = null;
    const reactions: { delivery: Delivery; body: string }[] = [];
    for (const [runId, items] of byRun) {
      const run = runStatus.get(runId);
      if (!run || !TERMINAL_RUN.has(run.status)) {
        const pos = Math.min(...items.map((i) => i.position));
        minUnfinishedPos = minUnfinishedPos === null ? pos : Math.min(minUnfinishedPos, pos);
        continue;
      }
      const delivery = open.find((d) => d.runId === runId) ?? this.store.deliveries(roomId, "participant_id=? AND run_id=?", p.id, runId)[0];
      const kind: MessageKind = delivery ? purposeToKind(delivery.purpose) : "reply";
      const body = items.map((i) => i.text).join("\n\n").trim();
      const isNew = !this.store.db.prepare("SELECT 1 FROM messages WHERE thread_id=? AND t3_item_id=?").get(p.threadId, `run:${runId}`);
      if (body && isNew && delivery && !delivery.countsAsTurn && run.status === "completed" && !["handoff", "transfer", "join", "summary"].includes(delivery.purpose))
        reactions.push({ delivery, body });
      if (body) {
        const added = this.store.addMessage({
          roomId,
          author: p.kind,
          kind,
          recipients: delivery && delivery.purpose !== "summary" ? ["all"] : ["human"],
          body,
          threadId: p.threadId,
          runId,
          t3ItemId: `run:${runId}`,
          deliveryId: delivery?.id ?? null,
          meta: delivery
            ? {
                purpose: delivery.purpose,
                runStatus: run.status,
                ...(delivery.purpose === "summary" && delivery.messageSeqs.length ? { range: [Math.min(...delivery.messageSeqs), Math.max(...delivery.messageSeqs)] } : {}),
              }
            : { untracked: true, note: "Produced in T3 outside a room turn; not relayed." },
        });
        if (isNew && !["summary", "handoff", "transfer"].includes(kind)) this.onAgentMessage(roomId, added);
      }
    }
    // Close deliveries whose run is terminal.
    for (const d of open) {
      const runId = d.runId ?? null;
      const run = runId ? runStatus.get(runId) : snap.runs[snap.runs.length - 1];
      if (!run || !TERMINAL_RUN.has(run.status)) continue;
      if (!runId && d.t3Delivery === "queued") continue; // its run has not been created yet
      this.store.updateDelivery(d.id, { state: "completed", runStatus: run.status, runId: run.runId });
      if (run.status === "failed")
        this.system(roomId, `${p.name}'s turn failed in T3${run.error ? `: ${run.error}` : "."} Open the thread for details.`);
      if (run.status === "cancelled" || run.status === "interrupted") this.system(roomId, `${p.name}'s turn ended: ${run.status}.`);
    }
    for (const r of reactions) this.reactToPeerReply(roomId, p, r.delivery, r.body);
    const lastRun = snap.runs[snap.runs.length - 1];
    const activeRun = snap.runs.find((r) => ACTIVE_RUN.has(r.status));
    const stillOpen = this.store.deliveries(roomId, "participant_id=? AND state='accepted'", p.id).length > 0;
    const status: Participant["status"] = snap.hasPendingRequest
      ? "awaiting_input"
      : activeRun
        ? p.status === "stopping"
          ? "stopping"
          : "working"
        : stillOpen
          ? "queued"
          : p.status === "stopping"
            ? "stopped"
            : lastRun?.status === "failed"
              ? "failed"
              : lastRun && (lastRun.status === "interrupted" || lastRun.status === "cancelled")
                ? "stopped"
                : "ready";
    const nextPos = minUnfinishedPos !== null ? minUnfinishedPos - 1 : (snap.nextPosition ?? p.readPosition);
    this.store.updateParticipant(p.id, {
      status,
      statusDetail: snap.hasPendingRequest ? (snap.pendingDetail ?? "Waiting for approval or an answer in T3 — open the thread.") : status === "failed" ? (lastRun?.error ?? "Run failed") : null,
      readPosition: nextPos,
      activeRunId: activeRun?.runId ?? null,
      usage: lastRun?.usage ?? p.usage,
    });
  }

  /**
   * After an agent's reply outside the automatic sequence:
   * - other agents still working on the same message to everyone get this answer passed into their turn;
   * - agents the reply @mentions get the question handed over (bounded by the room's peerLimit).
   */
  private reactToPeerReply(roomId: string, author: Participant, delivery: Delivery, body: string) {
    // The agents' room threads keep talking after a plan is approved (planning the work, splitting it up),
    // so hand-offs apply in both phases. Only the automatic round, which never gets here, is phase-bound.
    const mentioned = parseMentions(body, this.kinds(roomId));
    for (const peer of this.store.participants(roomId)) {
      if (peer.kind === author.kind) continue;
      // An agent's "@all" asks everyone, like naming each of them.
      this.reactAsPeer(roomId, author, peer, delivery, mentioned.includes(peer.kind) || mentioned.includes("all"));
    }
  }

  private reactAsPeer(roomId: string, author: Participant, peer: Participant, delivery: Delivery, addressed: boolean) {
    const room = this.room(roomId);
    const messages = this.store.messages(roomId);
    const parallelSeqs = new Set(
      delivery.messageSeqs.filter((seq) => {
        const m = messages.find((x) => x.seq === seq);
        return m?.author === "human" && (m.meta as any)?.order === "parallel";
      }),
    );
    const peerWorkingOnSame = this.store
      .deliveries(roomId, "participant_id=? AND state='accepted'", peer.id)
      .some((d) => d.messageSeqs.some((s) => parallelSeqs.has(s)));
    if (peerWorkingOnSame) {
      this.scheduleTurn(room, peer, "peer_update", { countsAsTurn: false, sendMode: "auto", human: true });
      return;
    }
    if (!addressed) return;
    // A turn already on its way to the peer carries this reply; don't add a second one.
    if (this.store.deliveries(roomId, "participant_id=? AND state IN ('pending','held') AND purpose IN ('follow','peer_update','peer_question','reply')", peer.id).length)
      return;
    // Hand-offs since the human last spoke: answered ones (by message order) plus any still open.
    const lastHumanSeq = [...messages].reverse().find((m) => m.author === "human")?.seq ?? 0;
    const chain =
      messages.filter((m) => m.seq > lastHumanSeq && (m.meta as any)?.purpose === "peer_question").length +
      this.store.deliveries(roomId, "purpose='peer_question' AND state IN ('pending','held','sending','accepted','uncertain')").length;
    if (chain >= room.peerLimit) {
      this.system(
        roomId,
        room.peerLimit === 0
          ? `${author.name} addressed ${peer.name}, but hand-offs between agents are off in this room. Ask ${peer.name} yourself, or raise the hand-off limit.`
          : `${author.name} addressed ${peer.name}, but the agents have already handed questions to each other ${room.peerLimit} ${room.peerLimit === 1 ? "time" : "times"} since your last message. Ask ${peer.name} yourself to continue, or raise the hand-off limit.`,
      );
      return;
    }
    if (!["idle", "running", "paused", "awaiting_decision"].includes(room.status)) return;
    // A hand-off belongs to the conversation the human is driving, so a paused automatic
    // round does not hold it. Only the human's own Pause or Stop does.
    const halted = room.status === "paused" && (room.statusDetail === PAUSED_BY_YOU || room.statusDetail === STOPPED);
    this.scheduleTurn(room, peer, "peer_question", { countsAsTurn: false, sendMode: "queue", human: !halted });
    this.system(
      roomId,
      halted
        ? `${author.name} asked ${peer.name} directly. The room is paused, so it will be passed on when you resume or continue.`
        : `${author.name} asked ${peer.name} directly; passing it on.`,
    );
    if (room.status === "idle" || room.status === "awaiting_decision") this.setStatus(room, "running");
  }

  // ------------------------------------------------------------ execution
  approvePlan(roomId: string, input: { body: string; sourceMessageId?: string | null }) {
    return this.withRoom(roomId, async () => {
      const room = this.room(roomId);
      const body = input.body.trim();
      if (!body) throw new Error("Plan text is empty");
      const revising = room.phase === "execution";
      if (revising && this.store.tasks(roomId).some((t) => ACTIVE_TASK.includes(t.status)))
        throw new TransitionError("A task is still running. Wait for it to finish, or stop it, before replacing the plan.");
      for (const d of this.store.deliveries(roomId, "state IN ('pending','held')")) this.store.updateDelivery(d.id, { state: "cancelled" });
      // A revised plan replaces the previous one: only the newest approved plan travels with tasks.
      for (const d of this.store.decisions(roomId, true)) if (d.kind === "approved_plan") this.store.setDecisionActive(d.id, false);
      this.store.addDecision(roomId, "approved_plan", body, input.sourceMessageId ?? null);
      this.store.addMessage({
        roomId,
        author: "human",
        kind: "decision",
        recipients: ["all"],
        body: `**${revising ? "Revised plan approved (replaces the previous plan)" : "Approved plan"}**\n\n${body}`,
        deliveryState: "recorded",
      });
      this.store.updateRoom(roomId, { phase: "execution" });
      room.phase = "execution";
      if (room.status === "running") this.setStatus(room, "paused", "Plan approved. Discussion closed; assign implementation when ready.");
      else if (room.status !== "paused" && room.status !== "idle") this.setStatus(room, "idle", "Plan approved. Assign implementation when ready.");
      else this.store.updateRoom(roomId, { statusDetail: "Plan approved. Assign implementation when ready." });
    });
  }

  startImplementation(roomId: string, input: StartImplementationInput) {
    return this.withRoom(roomId, async () => {
      const room = this.room(roomId);
      if (room.phase !== "execution") throw new TransitionError("Approve a plan before starting implementation.");
      const active = this.store.tasks(roomId).filter((t) => ACTIVE_TASK.includes(t.status));
      if (active.length) throw new TransitionError("A task is already in progress. One writer at a time.");
      const strategy = input.strategy ?? "solo";
      if (!TASK_STRATEGIES.includes(strategy)) throw new Error(`Unknown strategy: ${strategy}`);
      const title = input.title.trim();
      if (!title) throw new Error("Task title is required");
      const newWorkspace = room.projectId && input.baseRef ? `worktree:${input.baseRef}` : room.projectId ? "root" : "scratch";
      const jobId = randomUUID();

      // Who builds what, in order: solo is one agent; joint is every agent given a part, the first one leading.
      const agents = this.kinds(roomId);
      const specFor = (k: AgentKind) => (strategy === "solo" ? input.spec : (input.parts?.[k] ?? "")).trim();
      let order: AgentKind[];
      if (strategy === "solo") {
        if (!agents.includes(input.implementer)) throw new Error("Choose an implementer");
        order = [input.implementer];
        if (!specFor(input.implementer)) throw new Error("Scope is required");
      } else {
        const taking = agents.filter((k) => specFor(k));
        if (taking.length < 2) throw new Error("Joint implementation needs a part for at least two agents.");
        const first = input.first && taking.includes(input.first) ? input.first : taking.includes(input.implementer) ? input.implementer : taking[0];
        order = [first, ...taking.filter((k) => k !== first)];
      }
      const first = order[0];
      if (strategy === "solo" && input.reviewer && (input.reviewer === first || !agents.includes(input.reviewer))) throw new Error("Choose a reviewer other than the implementer");
      // Reviewers: solo, the chosen one (else the next agent in the room); joint, each part by the next agent taking part.
      const reviewerFor = (k: AgentKind, i: number) => (strategy === "solo" ? (input.reviewer ?? this.nextAgent(roomId, k)) : order[(i + 1) % order.length]);
      if (strategy !== "solo" && newWorkspace === "root")
        throw new TransitionError("Joint implementation needs a worktree: give a base ref so the parts don't share your project checkout.");

      const tasks = order.map((k, part) =>
        this.store.addTask({
          roomId,
          kind: "implement",
          ownerKind: k,
          title,
          spec: specFor(k),
          // Taking turns: the second part works in the first part's workspace once it exists.
          workspace: strategy === "turns" && part > 0 ? "after:previous" : newWorkspace,
          jobId,
          strategy,
          part,
          reviewerKind: reviewerFor(k, part),
        }),
      );
      for (const t of tasks)
        this.store.addMessage({
          roomId,
          author: "human",
          kind: "instruction",
          recipients: [t.ownerKind],
          body:
            strategy === "solo"
              ? `**Assigned implementation to ${this.nameOf(roomId, t.ownerKind)}:** ${title} (${this.nameOf(roomId, t.reviewerKind!)} reviews)\n\n${t.spec}`
              : `**${this.nameOf(roomId, t.ownerKind)}'s part of “${title}”** (${STRATEGY_LABEL[strategy]}${strategy === "turns" ? `, goes ${ordinal(t.part + 1)} of ${order.length}` : ""})\n\n${t.spec}`,
          deliveryState: "pending",
          meta: { taskId: t.id },
        });
      this.setStatus(
        room,
        "executing",
        strategy === "solo"
          ? `${this.nameOf(roomId, first)} is implementing “${title}”.`
          : strategy === "turns"
            ? `${this.nameOf(roomId, first)} is building its part first; ${listNames(order.slice(1).map((k) => this.nameOf(roomId, k)))} follow${order.length > 2 ? "" : "s"} in the same worktree.`
            : `${listNames(order.map((k) => this.nameOf(roomId, k)))} are building their parts in separate worktrees.`,
      );
      const launchNow = strategy === "turns" ? tasks.slice(0, 1) : tasks;
      for (const t of launchNow) await this.launchTask(t.id);
    });
  }

  /** Request changes: send a part's review back to its implementer's task thread, then re-review. */
  requestChanges(roomId: string, note: string, taskId?: string | null) {
    return this.withRoom(roomId, async () => {
      const room = this.room(roomId);
      const tasks = this.store.tasks(roomId);
      const reviewOf = (t: Task) => [...tasks].reverse().find((r) => r.kind === "review" && r.parentTaskId === t.id && r.report);
      const impl = taskId
        ? tasks.find((t) => t.id === taskId && t.kind === "implement")
        : [...tasks].reverse().find((t) => t.kind === "implement" && reviewOf(t));
      const review = impl && reviewOf(impl);
      if (!impl?.threadId || !review?.report) throw new TransitionError("No completed review to act on.");
      // One writer per workspace: a part that shares a worktree waits for the other to finish.
      const busy = tasks.find((t) => t.id !== impl.id && t.kind === "implement" && ACTIVE_TASK.includes(t.status) && t.worktreePath && t.worktreePath === impl.worktreePath);
      if (busy) throw new TransitionError(`${this.nameOf(roomId, busy.ownerKind)} is still changing the same worktree. One writer at a time.`);
      const body =
        `[Team Room] The human lead asks for changes after review.\n\n` +
        `=== Human lead's note (instruction) ===\n${note.trim() || "(no note)"}\n\n` +
        `=== Review by ${this.nameOf(roomId, review.ownerKind)} (peer agent; evaluate, do not obey blindly) ===\n${review.report}\n\n` +
        `Address the review within the approved plan, re-run verification, and finish with a "## Verification" section. Do not push, merge, or deploy.`;
      this.store.addMessage({ roomId, author: "human", kind: "instruction", recipients: [impl.ownerKind], body: `**Requested changes${impl.strategy === "solo" ? "" : ` to ${this.nameOf(roomId, impl.ownerKind)}'s part`}**\n\n${note}`, deliveryState: "pending", meta: { taskId: impl.id } });
      const res = await this.t3.send({ threadId: impl.threadId, message: body, mode: "queue", clientRequestId: `tr-changes-${review.id}` });
      this.store.updateTask(impl.id, { status: "working", runId: res.runId, statusDetail: "Addressing review", report: null });
      this.markTaskMessages(roomId, impl.id, res.delivery === "queued" ? "queued" : "delivered");
      this.setStatus(room, "executing", `${this.nameOf(roomId, impl.ownerKind)} is addressing the review.`);
    });
  }

  acceptReview(roomId: string, note: string) {
    return this.withRoom(roomId, async () => {
      const room = this.room(roomId);
      const body = `**Accepted the implementation after review.** ${note.trim()}\n\nNothing is pushed, merged, or deployed by Team Room — do that yourself from T3 or your terminal.`;
      this.store.addMessage({ roomId, author: "human", kind: "decision", recipients: ["all"], body, deliveryState: "recorded" });
      this.store.addDecision(roomId, "decision", `Implementation accepted. ${note.trim()}`.trim());
      this.setStatus(room, "idle", "Implementation accepted.");
    });
  }

  private async launchTask(taskId: string) {
    const task = this.store.task(taskId)!;
    const room = this.room(task.roomId);
    const owner = this.store.participantByKind(room.id, task.ownerKind)!;
    const decisions = this.store.decisions(room.id, true);
    let workspace: import("./t3/types.js").WorkspaceChoice;
    let prompt: string;
    if (task.kind === "implement") {
      const partners = this.store.tasks(room.id).filter((t) => t.kind === "implement" && t.jobId && t.jobId === task.jobId && t.id !== task.id);
      const previous = task.workspace === "after:previous" ? partners.find((t) => t.part === task.part - 1) : undefined;
      workspace = previous
        ? previous.worktreePath && room.projectId
          ? { kind: "existing_worktree", worktreePath: previous.worktreePath }
          : room.projectId
            ? { kind: "root" }
            : { kind: "scratch" }
        : task.workspace?.startsWith("worktree:")
          ? { kind: "worktree", baseRef: task.workspace.slice("worktree:".length) }
          : task.workspace === "scratch"
            ? { kind: "scratch" }
            : { kind: "root" };
      prompt = implementationPrompt(room, task, decisions, partners, this.names(room.id));
    } else {
      const impl = this.store.task(task.parentTaskId!)!;
      // T3 binds an existing worktree only within a project. In a Scratch room
      // the reviewer gets its own scratch folder and the implementer's path in its prompt.
      workspace =
        impl.worktreePath && room.projectId
          ? { kind: "existing_worktree", worktreePath: impl.worktreePath }
          : room.projectId
            ? { kind: "root" }
            : { kind: "scratch" };
      prompt = reviewPrompt(room, task, impl, decisions, this.names(room.id));
    }
    this.store.updateTask(taskId, { status: "launching" });
    try {
      const res = await this.t3.launchThread({
        projectId: room.projectId,
        title: `${room.title} — ${task.kind === "implement" ? "implement" : "review"}${task.strategy === "solo" ? "" : ` (${this.nameOf(room.id, task.kind === "implement" ? task.ownerKind : (this.store.task(task.parentTaskId!)?.ownerKind ?? task.ownerKind))}'s part)`}: ${task.title}`.slice(0, 120),
        providerInstanceId: owner.providerInstanceId,
        model: owner.model,
        message: prompt,
        clientRequestId: task.launchRequestId,
        workspace,
        runtimeMode: room.permissionMode,
        options: owner.options,
      });
      this.store.updateTask(taskId, {
        status: "working",
        threadId: res.threadId,
        threadLink: res.link,
        runId: res.runId,
        worktreePath: res.worktreePath,
        branch: res.branch,
      });
      this.markTaskMessages(room.id, taskId, "delivered");
      this.system(room.id, `${this.nameOf(room.id, task.ownerKind)} started the ${task.kind} task in its own T3 thread${res.worktreePath ? ` (worktree ${res.worktreePath})` : ""}.`);
    } catch (err) {
      const uncertain = !(err instanceof T3ToolError) || ["transport_error", "auth_expired"].includes(err.code);
      this.store.updateTask(taskId, { status: uncertain ? "uncertain" : "failed", statusDetail: actionable(err) });
      this.markTaskMessages(room.id, taskId, uncertain ? "uncertain" : "failed");
      this.setStatus(this.room(room.id), "needs_attention", `Could not start the ${task.kind} task: ${actionable(err)}`);
    }
  }

  /** Task instructions are delivered by launch/send, not by a room delivery: reflect T3's answer. */
  private markTaskMessages(roomId: string, taskId: string, state: MessageDeliveryState) {
    for (const m of this.store.messages(roomId))
      if (m.author === "human" && m.meta.taskId === taskId && m.deliveryState !== "delivered") this.store.updateMessage(m.id, { deliveryState: state });
  }

  private async pollTasks(roomId: string) {
    for (const task of this.store.tasks(roomId)) {
      if (!task.threadId || !["working", "awaiting_input"].includes(task.status)) continue;
      let snap: ThreadSnapshot;
      try {
        snap = await this.t3.readThread({ threadId: task.threadId, afterPosition: null });
      } catch (err) {
        this.store.updateTask(task.id, { statusDetail: `Cannot read thread: ${actionable(err)}` });
        continue;
      }
      const lastRun = snap.runs[snap.runs.length - 1];
      if (snap.worktreePath && !task.worktreePath) this.store.updateTask(task.id, { worktreePath: snap.worktreePath, branch: snap.branch });
      if (snap.hasPendingRequest) {
        this.store.updateTask(task.id, { status: "awaiting_input", statusDetail: snap.pendingDetail ?? "Approval or answer needed in T3 — open the thread." });
        continue;
      }
      if (!lastRun || !TERMINAL_RUN.has(lastRun.status)) {
        if (task.status !== "working") this.store.updateTask(task.id, { status: "working", statusDetail: null });
        continue;
      }
      const items = snap.items.filter((i) => i.role === "assistant" && i.runId === lastRun.runId);
      const report = items.map((i) => i.text).join("\n\n").trim();
      const ok = lastRun.status === "completed";
      this.store.updateTask(task.id, {
        status: ok ? "completed" : lastRun.status === "failed" ? "failed" : "stopped",
        statusDetail: ok ? null : (lastRun.error ?? lastRun.status),
        report,
        runId: lastRun.runId,
      });
      this.store.addMessage({
        roomId,
        author: task.ownerKind,
        kind: task.kind === "implement" ? "implementation_report" : "review",
        recipients: ["human"],
        body: report || `_(no text output; run ${lastRun.status})_`,
        threadId: task.threadId,
        runId: lastRun.runId,
        t3ItemId: `run:${lastRun.runId}`,
        meta: { taskId: task.id, runStatus: lastRun.status, verification: extractVerification(report) },
      });
      if (snap.worktreePath && !task.worktreePath) this.store.updateTask(task.id, { worktreePath: snap.worktreePath });
      await this.afterTaskRun(roomId, this.store.task(task.id)!, ok, lastRun.status);
    }
  }

  /** What follows a finished task run: the next part, the reviews, or the human's decision. */
  private async afterTaskRun(roomId: string, task: Task, ok: boolean, runStatus: string) {
    const room = this.room(roomId);
    const all = this.store.tasks(roomId);
    const parts = all.filter((t) => t.kind === "implement" && t.jobId && t.jobId === task.jobId);
    const reviewed = (t: Task) => all.some((r) => r.kind === "review" && r.parentTaskId === t.id);
    // The reviewer chosen at assignment; if it has left the room since, the next agent.
    const reviewerOf = (impl: Task) => {
      const present = this.kinds(roomId);
      return impl.reviewerKind && present.includes(impl.reviewerKind) && impl.reviewerKind !== impl.ownerKind ? impl.reviewerKind : this.nextAgent(roomId, impl.ownerKind);
    };
    const startReview = async (impl: Task) => {
      const review = this.store.addTask({
        roomId,
        kind: "review",
        ownerKind: reviewerOf(impl),
        title: impl.title,
        spec: impl.spec,
        workspace: impl.worktreePath ?? impl.workspace,
        parentTaskId: impl.id,
        jobId: impl.jobId,
        strategy: impl.strategy,
        part: impl.part,
      });
      await this.launchTask(review.id);
    };

    if (task.kind === "implement" && !ok) {
      // Taking turns: a later part can't build on a part that didn't finish.
      for (const t of parts) if (t.status === "queued") this.store.updateTask(t.id, { status: "stopped", statusDetail: `Not started: ${this.nameOf(roomId, task.ownerKind)}'s part did not finish.` });
      if (room.status === "executing") this.setStatus(room, "needs_attention", `${this.nameOf(roomId, task.ownerKind)}'s implementation run ended: ${runStatus}. Open the thread for details.`);
      return;
    }
    if (task.kind === "implement") {
      const next = parts.find((t) => t.status === "queued" && t.part === task.part + 1);
      if (task.strategy === "turns" && next) {
        if (room.status === "executing") this.store.updateRoom(roomId, { statusDetail: `${this.nameOf(roomId, next.ownerKind)} is building its part on top of ${this.nameOf(roomId, task.ownerKind)}'s.` });
        await this.launchTask(next.id);
        return;
      }
      // Taking turns reviews both parts once the last one is built; a part changed after review is reviewed again on its own.
      const toReview = task.strategy === "turns" ? parts.filter((t) => t.id === task.id || (t.status === "completed" && !reviewed(t))) : [task];
      if (room.status === "executing")
        this.store.updateRoom(roomId, { statusDetail: toReview.map((t) => `${this.nameOf(roomId, reviewerOf(t))} is reviewing ${task.strategy === "solo" ? "" : `${this.nameOf(roomId, t.ownerKind)}'s part`}`.trim()).join("; ") + "." });
      for (const t of toReview) await startReview(t);
      return;
    }
    // A review finished: the human decides once nothing in the room is still running.
    const now = this.store.tasks(roomId);
    if (room.status === "executing" && !now.some((t) => ACTIVE_TASK.includes(t.status)))
      this.setStatus(room, "review_ready", parts.length > 1 || task.strategy !== "solo" ? "Reviews are in. Accept, request changes to a part, or discuss." : "Review is in. Accept, request changes, or discuss.");
  }

  // -------------------------------------------------------------- startup
  /** After a restart: never resend blindly. In-flight sends become uncertain. */
  async recoverOnStartup() {
    for (const room of this.store.rooms()) {
      await this.withRoom(room.id, async () => {
        const inFlight = this.store.deliveries(room.id, "state='sending'");
        for (const d of inFlight) this.store.updateDelivery(d.id, { state: "uncertain", error: "Team Room restarted while this was being sent." });
        const r = this.room(room.id);
        if (inFlight.length) {
          this.setStatus(r, "needs_attention", "Team Room restarted mid-delivery. Resume to reconcile with T3 (safe: requests are idempotent).");
          return;
        }
        if (["running", "stopping", "executing"].includes(r.status)) {
          const prev = r.status;
          this.setStatus(r, "reconciling", "Restarted; re-reading T3.");
          await this.pollRoom(room.id);
          const now = this.room(room.id);
          if (now.status === "reconciling") {
            if (prev === "executing") this.setStatus(now, "executing", now.statusDetail);
            else if (prev === "stopping") this.setStatus(now, "stopping", "Waiting for T3 to report runs ended.");
            else this.setStatus(now, "running");
          }
        }
      });
    }
  }
}

function ordinal(n: number): string {
  return ["first", "second", "third", "fourth", "fifth", "sixth"][n - 1] ?? `#${n}`;
}

function purposeToKind(p: TurnPurpose): MessageKind {
  if (p === "proposal" || p === "critique" || p === "response" || p === "handoff" || p === "summary") return p;
  if (p === "implement") return "implementation_report";
  if (p === "review") return "review";
  return "reply";
}

/** Markdown → readable one-line text for short excerpts. */
function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>]+/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function combine(states: string[]): MessageDeliveryState {
  const order = ["failed", "uncertain", "sending", "pending", "queued", "delivered"];
  for (const s of order) if (states.includes(s)) return s as MessageDeliveryState;
  return "pending";
}

function extractVerification(report: string): string | null {
  const m = report.match(/#{1,6}\s*Verification[^\n]*\n([\s\S]*?)(?=\n#{1,6}\s|$)/i);
  return m ? m[1].trim() : null;
}

export function actionable(err: unknown): string {
  if (err instanceof T3ToolError) {
    switch (err.code) {
      case "auth_expired":
        return "T3 sign-in expired or was revoked — reconnect to T3 from the header.";
      case "not_connected":
        return "Not connected to T3 — connect from the header.";
      case "provider_unavailable":
        return `Provider unavailable in T3: ${err.message}`;
      case "model_unavailable":
        return `Model unavailable: ${err.message}`;
      case "runtime_mode_escalation_denied":
      case "interaction_mode_escalation_denied":
        return `T3 refused: ${err.message} (Team Room's sign-in grants a narrower access mode).`;
      case "capability_denied":
        return `T3 refused: ${err.message} — re-approve Team Room with Supervised or higher access.`;
      default:
        if (/rate.?limit|429/i.test(err.message)) return `Rate limited: ${err.message}. Wait, then Resume.`;
        return `${err.code}: ${err.message}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

export type { Decision, Task };
