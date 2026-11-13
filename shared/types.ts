// Types shared by the backend and the browser.

/**
 * An agent's handle in its room: unique there, used for @mentions and as the author of its messages
 * (e.g. "claude", "codex", "grok", "claude2"). Rooms made before multi-agent support use "claude" and "codex".
 */
export type AgentKind = string;
export type Author = "human" | AgentKind | "system";

/** Agents a room may have. */
export const MIN_AGENTS = 2;
export const MAX_AGENTS = 6;

/** Handle base and display name for an agent of a T3 provider driver. */
export function agentIdentity(driver: string, displayName: string): { handle: string; name: string } {
  if (driver === "claudeAgent") return { handle: "claude", name: "Claude Code" };
  if (driver === "codex") return { handle: "codex", name: "Codex" };
  const handle = (driver || displayName).toLowerCase().replace(/agent$/, "").replace(/[^a-z0-9]+/g, "") || "agent";
  return { handle, name: displayName || driver };
}

/** Handles for a room's agents: the provider's handle, numbered from the second agent of the same provider ("claude2"). */
export function assignHandles(agents: { driver: string; displayName: string }[], taken: string[] = []): { handle: string; name: string }[] {
  const used = new Set(taken);
  return agents.map((a) => {
    const base = agentIdentity(a.driver, a.displayName);
    let handle = base.handle;
    let n = 1;
    while (used.has(handle) || RESERVED_HANDLES.includes(handle)) handle = `${base.handle}${++n}`;
    used.add(handle);
    return { handle, name: n > 1 ? `${base.name} ${n}` : base.name };
  });
}
const RESERVED_HANDLES = ["all", "everyone", "human", "system", "room"];

export type RoomMode = "manual" | "auto";
export type RoomPhase = "discussion" | "execution";
export type RoomStatus =
  | "setting_up" // creating participant threads in T3
  | "idle" // nothing running, waiting for the human
  | "running" // agent turns in flight
  | "paused" // human paused (or intervened); no new turns are scheduled
  | "stopping" // cancellation requested; waiting to observe runs end
  | "reconciling" // re-reading T3 after restart/resume
  | "awaiting_decision" // automatic round finished; human decides
  | "executing" // implementation/review tasks in flight
  | "review_ready" // review is back; human decides
  | "needs_attention"; // uncertain state or failure that needs the human

/** T3 runtime modes, least to most autonomous (T3's labels: Supervised, Auto-accept edits, Auto, Full access). */
export const PERMISSION_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
/** How a message to everyone is answered: all at once (first answers passed to the others), or one agent first. */
export type ReplyOrder = "parallel" | AgentKind;
export const PERMISSION_LABELS: Record<PermissionMode, string> = {
  "approval-required": "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

/** T3's own descriptions of its runtime modes (from T3 Code 0.1.7). */
export const PERMISSION_DESCRIPTIONS: Record<PermissionMode, string> = {
  "approval-required": "Ask before commands and file changes.",
  "auto-accept-edits": "Auto-approve edits, ask before other actions.",
  auto: "Supported providers approve routine actions; others still ask.",
  "full-access": "Allow commands and edits without prompts.",
};

export type Room = {
  id: string;
  title: string;
  brief: string;
  projectId: string | null;
  projectTitle: string | null;
  mode: RoomMode;
  status: RoomStatus;
  statusDetail: string | null;
  phase: RoomPhase;
  autoStep: number;
  turnLimit: number;
  turnsUsed: number;
  briefVersion: number;
  permissionMode: PermissionMode;
  /** Agent-to-agent hand-offs allowed in a row before the room waits for the human. 0 turns them off. */
  peerLimit: number;
  live: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ParticipantStatus =
  | "connecting"
  | "ready"
  | "queued"
  | "working"
  | "awaiting_input" // T3 approval or question pending in the thread
  | "stopping"
  | "stopped"
  | "failed"
  | "complete";

export type Participant = {
  id: string;
  roomId: string;
  kind: AgentKind;
  name: string;
  providerInstanceId: string;
  model: string;
  threadId: string | null;
  threadLink: string | null;
  launchRequestId: string;
  status: ParticipantStatus;
  statusDetail: string | null;
  readPosition: number | null;
  deliveredThroughSeq: number;
  contextVersion: string | null;
  activeRunId: string | null;
  usage: Record<string, unknown> | null;
  /** Model settings sent to T3 (modelSelection.options), e.g. { effort: "high" }. */
  options: Record<string, string | boolean>;
  /** Permission mode the current thread was started with (null for threads from before this was recorded). */
  threadMode: PermissionMode | null;
  /** Threads this agent used before moving to a new one (see transfer). */
  previousThreads: { threadId: string; link: string | null; mode: PermissionMode; endedAt: string }[];
  /** A move to a new thread in progress: waiting for the handoff note, then launching. */
  transfer: { mode: PermissionMode; from: PermissionMode; handoffDeliveryId: string | null; requestedAt: string } | null;
  /** Order in the room (the order agents were added). */
  position: number;
  /** Set when the human removed the agent from the room; its messages stay in the record. */
  leftAt: string | null;
};

export type MessageKind =
  | "instruction" // the human, addressed to agents
  | "note" // the human, to the room, no reply requested
  | "proposal"
  | "critique"
  | "response"
  | "reply"
  | "progress" // tool results / execution progress
  | "implementation_report"
  | "review"
  | "decision" // approved by the human
  | "handoff" // an agent's note to its successor thread
  | "summary" // an agent's summary of a stretch of discussion, for the human
  | "system";

export type Recipient = AgentKind | "human" | "all";

export type MessageDeliveryState =
  | "recorded" // human message stored, nothing to deliver
  | "pending"
  | "sending"
  | "delivered" // T3 accepted (started/steered)
  | "queued" // T3 accepted and queued behind active work
  | "uncertain"
  | "failed";

export type RoomMessage = {
  id: string;
  roomId: string;
  seq: number;
  author: Author;
  kind: MessageKind;
  recipients: Recipient[];
  body: string;
  createdAt: string;
  deliveryState: MessageDeliveryState | null;
  threadId: string | null;
  runId: string | null;
  t3ItemId: string | null;
  deliveryId: string | null;
  meta: Record<string, any>;
};

export type TurnPurpose =
  | "proposal"
  | "critique"
  | "response"
  | "reply" // manual ask
  | "human_followup" // human message steered/queued to a busy agent
  | "follow" // answers a message to everyone after the agent the human chose to go first
  | "peer_update" // another agent answered the same message first; steered into this agent's turn
  | "peer_question" // another agent addressed this agent with @mention
  | "join" // the first turn of an agent added to a room that already has a record
  | "implement"
  | "review"
  | "handoff" // the agent writes a handoff note before moving to a new thread
  | "transfer" // the agent's first turn in its new thread
  | "summary"; // the human asked an agent to summarize a range of the discussion

export type DeliveryState =
  | "pending" // stored, not sent yet
  | "held" // pending but blocked by pause
  | "sending" // request in flight; if we crash here it becomes uncertain
  | "accepted" // T3 confirmed (run started/steered/queued)
  | "completed" // its run finished and the reply is recorded
  | "uncertain"
  | "failed"
  | "cancelled";

export type Delivery = {
  id: string; // also the T3 clientRequestId
  roomId: string;
  participantId: string;
  purpose: TurnPurpose;
  messageSeqs: number[];
  throughSeq: number;
  contextVersion: string | null;
  envelope: string;
  sendMode: "auto" | "queue";
  state: DeliveryState;
  t3Delivery: string | null; // what T3 said: started | steered | queued
  runId: string | null;
  runStatus: string | null;
  autoStep: number | null;
  countsAsTurn: boolean;
  taskId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Decision = {
  id: string;
  roomId: string;
  kind: "decision" | "constraint" | "approved_plan";
  body: string;
  sourceMessageId: string | null;
  active: boolean;
  createdAt: string;
};

export type TaskStatus =
  | "queued"
  | "launching"
  | "working"
  | "awaiting_input"
  | "completed"
  | "failed"
  | "stopped"
  | "uncertain";

/**
 * How an implementation job is shared out:
 * - solo: one agent implements, another reviews;
 * - turns: each chosen agent builds its part, one after the other, in the same workspace; then each part is reviewed by the next agent;
 * - parallel: each chosen agent builds its part at the same time in its own workspace; then each part is reviewed by the next agent.
 */
export const TASK_STRATEGIES = ["solo", "turns", "parallel"] as const;
export type TaskStrategy = (typeof TASK_STRATEGIES)[number];

export type Task = {
  id: string;
  roomId: string;
  kind: "implement" | "review";
  ownerKind: AgentKind;
  /** Tasks started by one assignment share a job id. */
  jobId: string | null;
  strategy: TaskStrategy;
  /** Order of an implementation part within a job (0 = first). */
  part: number;
  /** Implementation: who reviews it (null: the next agent in the room). */
  reviewerKind: AgentKind | null;
  title: string;
  spec: string;
  status: TaskStatus;
  statusDetail: string | null;
  threadId: string | null;
  threadLink: string | null;
  launchRequestId: string;
  workspace: string | null;
  worktreePath: string | null;
  branch: string | null;
  runId: string | null;
  readPosition: number | null;
  report: string | null;
  parentTaskId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProviderInfo = {
  instanceId: string;
  driver: string;
  displayName: string;
  available: boolean;
  unavailableReason: string | null;
  models: { slug: string; name: string; options?: ModelOption[] }[];
  defaultModel: string | null;
};

/** A model setting T3 accepts in modelSelection.options, e.g. Claude's `effort` or Codex's `reasoningEffort`. */
export type ModelOption = { id: string; values: (string | boolean)[]; default: string | boolean | null };

/** Option ids that set how much a model thinks (Claude: effort, Codex: reasoningEffort). */
export const THINKING_OPTION_IDS = ["effort", "reasoningEffort", "thinking", "reasoning"];

export function thinkingOption(providers: ProviderInfo[], providerInstanceId: string, model: string): ModelOption | null {
  const m = providers.find((p) => p.instanceId === providerInstanceId)?.models.find((x) => x.slug === model);
  return m?.options?.find((o) => THINKING_OPTION_IDS.includes(o.id)) ?? null;
}

export type T3Status = {
  mcpUrl: string;
  connection:
    | { kind: "disconnected"; detail?: string }
    | { kind: "connecting" }
    | { kind: "needs_auth"; authorizationUrl: string | null }
    | { kind: "connected"; serverName: string; serverVersion: string }
    | { kind: "error"; detail: string };
  environmentId: string | null;
  providers: ProviderInfo[];
  projects: { id: string; title: string; workspaceRoot: string }[];
  /** The most autonomous mode T3 lets Team Room start threads with (the access level chosen when approving Team Room). */
  maxPermission: PermissionMode | null;
  /** Origin of the local T3 server, which also serves T3's own web app (used to show T3's approval screen in a panel). */
  webOrigin: string | null;
  /** The local model (Ollama) used for free summaries and question finding, if available. */
  localModel?: { available: boolean; model: string | null; detail: string | null };
  /** Identifies the interface build the server is serving; an open page reloads when it changes. */
  buildId?: string | null;
  /** Team Room is keeping the Mac awake because agents have work in flight (macOS only). */
  keepAwake?: boolean;
  /** The human lead's first name, if set; agents' questions that address the lead by name count as questions. */
  leadName?: string | null;
  mode: "live" | "fixture";
};

export type RoomView = {
  room: Room;
  /** The room's current agents, in order. */
  participants: Participant[];
  /** Agents removed from the room (their messages are still in it). */
  formerParticipants: Participant[];
  messages: RoomMessage[];
  deliveries: Delivery[];
  decisions: Decision[];
  tasks: Task[];
  summary: DecisionSummary | null;
  /** Questions the agents asked the human: open ones, and the most recently answered or dismissed. */
  questions: Question[];
  /** Summaries written by the local model (Ollama), per stretch of discussion. */
  localDigests?: { from: number; to: number; model: string; status: "queued" | "running" | "done" | "failed"; body: string | null; error: string | null }[];
};

/** A question an agent asked the human lead, picked out of its message (not questions the agents ask each other). */
export type Question = {
  id: string;
  roomId: string;
  author: AgentKind;
  seq: number;
  text: string;
  /** expired: the human wrote again without answering it, so it is taken as handled. */
  status: "open" | "answered" | "dismissed" | "expired";
  /** Answers to offer as buttons (may be empty: free-text answer only). */
  options: string[];
  /** The human message that answered it. */
  answerSeq: number | null;
  createdAt: string;
  updatedAt: string;
};

export type DecisionSummary = {
  proposals: { author: AgentKind; messageId: string; excerpt: string }[];
  sections: { author: AgentKind; agreements: string[]; disagreements: string[]; questions: string[] }[];
  limitReached: boolean;
};
