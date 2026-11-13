// AutoResearch: types shared by the research engine, its API and the dashboard.
import type { AgentKind, PermissionMode } from "./types.js";

export const RESEARCH_STRATEGIES = ["greedy", "parallel", "explore_exploit", "failure_driven"] as const;
export type ResearchStrategyId = (typeof RESEARCH_STRATEGIES)[number];

export const STRATEGY_LABELS: Record<ResearchStrategyId, string> = {
  greedy: "Greedy improvement",
  parallel: "Parallel exploration",
  explore_exploit: "Explore / exploit",
  failure_driven: "Failure-driven investigation",
};

export type Direction = "minimize" | "maximize" | "pass_fail";

/**
 * How an experiment is judged.
 * - command: Team Room runs an executable evaluation and reads its JSON result (autonomous).
 * - human: no trustworthy automated evaluation; the human judges each experiment against written criteria (assisted).
 */
export type EvalKind = "command" | "human";

export type ResearchRunStatus =
  | "draft"
  | "baseline" // measuring the baseline
  | "running"
  | "paused"
  | "finishing" // a limit was reached; in-flight experiments finish, nothing new starts
  | "stopping"
  | "stopped"
  | "completed"
  | "needs_attention";

export type ExperimentStatus =
  | "proposed" // hypothesis recorded, waiting for a slot
  | "implementing" // an implementer agent is working in the experiment's worktree
  | "eval_queued"
  | "evaluating"
  | "reviewing" // the evaluator agent is checking a candidate improvement
  | "awaiting_human" // assisted evaluation, or a decision the human must make
  | "done"
  | "cancelled";

export type Decision = "keep" | "discard" | "invalid" | "inconclusive";

export type ResearchRoles = {
  researcher: AgentKind;
  /** Agents that implement experiments, used in turn. */
  implementers: AgentKind[];
  /** Agent that independently reviews candidate improvements; "other" = not the experiment's implementer. */
  evaluator: AgentKind | "other" | "off";
  /**
   * Whether agents may run shell commands. Off by default: Team Room runs the evaluation itself and sends
   * errors back, so agents only read and edit files, and below Full access every command needs an approval.
   */
  agentCommands?: boolean;
};

export type ResearchLimits = {
  maxExperiments: number;
  maxMinutes: number;
  maxConcurrency: number;
  /** Implementation attempts after the first, per experiment, when the build or evaluation errors. */
  maxRetries: number;
  /** Stop after this many decided experiments in a row without an improvement. */
  stagnationLimit: number;
  /** Spending cap in USD. Only enforced when the runtime reports usage costs (T3 0.1.7 does not). */
  maxSpendUsd: number | null;
};

export type EvalConfig = {
  kind: EvalKind;
  /** Shell command run in the experiment's checkout. $EVAL_DIR points at a fresh copy of the protected evaluation files. */
  command: string | null;
  /** Written acceptance criteria (always shown to agents; the only evaluation in assisted mode). */
  criteria: string;
  direction: Direction;
  metricName: string;
  /** Runs per evaluation; the median is the result. */
  repeats: number;
  /** Smallest relative improvement that counts, e.g. 0.02 = 2%. */
  minImprovement: number;
  timeoutSec: number;
  /** Paths (files or directories, relative to the repo) that experiments must not modify. */
  protectedPaths: string[];
};

export type ResearchRun = {
  id: string;
  title: string;
  objective: string;
  projectId: string;
  projectTitle: string | null;
  repoPath: string;
  baseRef: string;
  baseSha: string | null;
  /** Glob-like patterns (relative to the repo) experiments may change. */
  allowedScope: string[];
  eval: EvalConfig;
  strategy: ResearchStrategyId;
  roles: ResearchRoles;
  models: Partial<Record<AgentKind, { providerInstanceId: string; model: string; options?: Record<string, string | boolean> }>>;
  permissionMode: PermissionMode;
  limits: ResearchLimits;
  status: ResearchRunStatus;
  statusDetail: string | null;
  baselineId: string | null;
  bestId: string | null;
  /** Time spent running (paused time excluded). */
  activeMs: number;
  startedAt: string | null;
  resumedAt: string | null;
  endedAt: string | null;
  researcherThreadId: string | null;
  researcherThreadLink: string | null;
  /** The researcher's open request: its T3 run, what was asked, and parse attempts. Null when idle. */
  researcherAsk: { runId: string | null; wanted: number; lessonsFor: string[]; attempt: number; requestedAt: string; clientRequestId: string } | null;
  /** Run-owned read-only checkout of the current best, where the researcher works. */
  referencePath: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EvalSample = {
  id: string;
  experimentId: string;
  attempt: number;
  revision: string | null;
  exitCode: number | null;
  metric: number | null;
  pass: boolean | null;
  metrics: Record<string, unknown>;
  error: string | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  startedAt: string;
};

export type Experiment = {
  id: string;
  runId: string;
  seq: number;
  parentId: string | null;
  kind: "baseline" | "experiment";
  source: "researcher" | "human";
  title: string;
  hypothesis: string;
  rationale: string;
  design: string;
  /** Short name of the approach family, used to spot repeated failures of one idea. */
  approach: string;
  params: Record<string, unknown>;
  status: ExperimentStatus;
  decision: Decision | null;
  decisionReason: string | null;
  agentKind: AgentKind | null;
  model: string | null;
  threadId: string | null;
  threadLink: string | null;
  agentRunId: string | null;
  worktreePath: string | null;
  branch: string | null;
  baseSha: string | null;
  commitSha: string | null;
  changedFiles: string[];
  diff: string | null;
  report: string | null;
  metric: number | null;
  metricSpread: number | null;
  metrics: Record<string, unknown>;
  passed: boolean | null;
  review: string | null;
  reviewVerdict: "valid" | "invalid" | null;
  reviewThreadId: string | null;
  reviewThreadLink: string | null;
  lessons: string | null;
  failureReason: string | null;
  retries: number;
  pinned: boolean;
  rejected: boolean;
  awaitingInput: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ResearchEvent = { id: number; runId: string; at: string; experimentId: string | null; kind: string; message: string };

export type ResearchRunListItem = Pick<ResearchRun, "id" | "title" | "status" | "updatedAt" | "projectTitle"> & {
  /** Experiments whose agent is waiting for the human's approval in T3. */
  waiting?: string[];
};

export type ResearchView = {
  run: ResearchRun;
  experiments: Experiment[];
  evals: EvalSample[];
  events: ResearchEvent[];
  /** Derived numbers for the overview. */
  summary: {
    completed: number;
    kept: number;
    running: number;
    activeAgents: { kind: AgentKind; role: string; experimentSeq: number | null; threadLink: string | null; awaitingInput: boolean }[];
    baselineMetric: number | null;
    bestMetric: number | null;
    improvementPct: number | null;
    remaining: { experiments: number; minutes: number };
    spendUsd: number | null;
  };
};

export type CreateResearchInput = {
  title: string;
  objective: string;
  projectId: string;
  baseRef?: string;
  allowedScope: string[];
  eval: Partial<EvalConfig> & Pick<EvalConfig, "kind" | "criteria" | "direction">;
  strategy?: ResearchStrategyId;
  roles: ResearchRoles;
  models: Partial<Record<AgentKind, { providerInstanceId: string; model: string; options?: Record<string, string | boolean> }>>;
  permissionMode?: PermissionMode;
  limits?: Partial<ResearchLimits>;
};
