// The normalized interface the room controller uses. Only adapter.ts knows the
// shapes of T3's MCP tools; the controller never sees them.
import type { PermissionMode, ProviderInfo, T3Status } from "../../shared/types.js";

export type WorkspaceChoice =
  | { kind: "root" }
  | { kind: "scratch" }
  | { kind: "worktree"; baseRef: string; branch?: string }
  | { kind: "existing_worktree"; worktreePath: string };

export type LaunchInput = {
  projectId: string | null;
  title: string;
  providerInstanceId: string;
  model: string;
  message?: string;
  clientRequestId: string;
  workspace: WorkspaceChoice;
  runtimeMode?: PermissionMode;
  /** Model settings (modelSelection.options), e.g. thinking level. */
  options?: Record<string, string | boolean>;
};

export type LaunchResult = {
  threadId: string;
  link: string | null;
  runId: string | null;
  worktreePath: string | null;
  branch: string | null;
};

export type SendResult = {
  runId: string | null;
  /** What T3 reported: started a new turn, steered the active one, or queued. */
  delivery: "started" | "steered" | "queued" | string;
};

export type RunStatus = "queued" | "starting" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted" | "rolled_back" | string;

export const TERMINAL_RUN: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);

export type ThreadItem = {
  itemId: string;
  position: number;
  role: "user" | "assistant" | "plan" | "other";
  runId: string | null;
  text: string;
  createdAt: string | null;
};

export type ThreadRun = {
  runId: string;
  status: RunStatus;
  error: string | null;
  usage: Record<string, unknown> | null;
};

export type ThreadSnapshot = {
  threadId: string;
  status: string;
  runs: ThreadRun[];
  items: ThreadItem[];
  nextPosition: number | null;
  hasPendingRequest: boolean;
  pendingDetail: string | null;
  link: string | null;
  worktreePath: string | null;
  branch: string | null;
};

export interface T3Adapter {
  readonly mode: "live" | "fixture";
  status(): T3Status;
  connect(): Promise<void>;
  providers(): Promise<ProviderInfo[]>;
  launchThread(input: LaunchInput): Promise<LaunchResult>;
  send(input: { threadId: string; message: string; mode: "auto" | "queue"; clientRequestId: string }): Promise<SendResult>;
  readThread(input: { threadId: string; afterPosition: number | null }): Promise<ThreadSnapshot>;
  interrupt(input: { threadId: string; runId?: string | null }): Promise<{ status: string }>;
  /** Change a thread's model settings (e.g. thinking level); applies from its next turn. Permission modes cannot change. */
  configureThread(input: { threadId: string; providerInstanceId: string; model: string; options: Record<string, string | boolean> }): Promise<void>;
  /** Rename a thread (T3's sidebar shows the title). */
  renameThread(input: { threadId: string; title: string; clientRequestId: string }): Promise<void>;
}
