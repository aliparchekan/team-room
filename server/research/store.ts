// Durable AutoResearch state, in the same SQLite database as rooms. Every
// decision the engine makes is read back from here after a restart; nothing
// depends on an agent's conversational memory.
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { EvalSample, Experiment, ResearchEvent, ResearchRun } from "../../shared/research.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS research_runs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_title TEXT,
  repo_path TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  base_sha TEXT,
  allowed_scope TEXT NOT NULL,
  eval TEXT NOT NULL,
  strategy TEXT NOT NULL,
  roles TEXT NOT NULL,
  models TEXT NOT NULL,
  permission_mode TEXT NOT NULL,
  limits TEXT NOT NULL,
  status TEXT NOT NULL,
  status_detail TEXT,
  baseline_id TEXT,
  best_id TEXT,
  active_ms INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  resumed_at TEXT,
  ended_at TEXT,
  researcher_thread_id TEXT,
  researcher_thread_link TEXT,
  researcher_ask TEXT,
  reference_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS research_experiments (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES research_runs(id),
  seq INTEGER NOT NULL,
  parent_id TEXT,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  design TEXT NOT NULL DEFAULT '',
  approach TEXT NOT NULL DEFAULT '',
  params TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  decision TEXT,
  decision_reason TEXT,
  agent_kind TEXT,
  model TEXT,
  thread_id TEXT,
  thread_link TEXT,
  agent_run_id TEXT,
  worktree_path TEXT,
  branch TEXT,
  base_sha TEXT,
  commit_sha TEXT,
  changed_files TEXT NOT NULL DEFAULT '[]',
  diff TEXT,
  report TEXT,
  metric REAL,
  metric_spread REAL,
  metrics TEXT NOT NULL DEFAULT '{}',
  passed INTEGER,
  review TEXT,
  review_verdict TEXT,
  review_thread_id TEXT,
  review_thread_link TEXT,
  lessons TEXT,
  failure_reason TEXT,
  retries INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  awaiting_input INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, seq)
);
CREATE TABLE IF NOT EXISTS research_evals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  revision TEXT,
  exit_code INTEGER,
  metric REAL,
  pass INTEGER,
  metrics TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  duration_ms INTEGER NOT NULL,
  stdout_tail TEXT NOT NULL DEFAULT '',
  stderr_tail TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS research_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  at TEXT NOT NULL,
  experiment_id TEXT,
  kind TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS research_exp_run ON research_experiments(run_id, seq);
CREATE INDEX IF NOT EXISTS research_evals_exp ON research_evals(experiment_id);
CREATE INDEX IF NOT EXISTS research_events_run ON research_events(run_id, id);
`;

const now = () => new Date().toISOString();
const json = (v: unknown) => JSON.stringify(v ?? null);
const parse = <T>(s: string | null | undefined, fallback: T): T => {
  if (s == null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

const RUN_COLS: Record<string, [string, "json" | "plain"]> = {
  title: ["title", "plain"],
  objective: ["objective", "plain"],
  baseSha: ["base_sha", "plain"],
  allowedScope: ["allowed_scope", "json"],
  eval: ["eval", "json"],
  strategy: ["strategy", "plain"],
  roles: ["roles", "json"],
  models: ["models", "json"],
  permissionMode: ["permission_mode", "plain"],
  limits: ["limits", "json"],
  status: ["status", "plain"],
  statusDetail: ["status_detail", "plain"],
  baselineId: ["baseline_id", "plain"],
  bestId: ["best_id", "plain"],
  activeMs: ["active_ms", "plain"],
  startedAt: ["started_at", "plain"],
  resumedAt: ["resumed_at", "plain"],
  endedAt: ["ended_at", "plain"],
  researcherThreadId: ["researcher_thread_id", "plain"],
  researcherThreadLink: ["researcher_thread_link", "plain"],
  researcherAsk: ["researcher_ask", "json"],
  referencePath: ["reference_path", "plain"],
};

const EXP_COLS: Record<string, [string, "json" | "plain" | "bool"]> = {
  parentId: ["parent_id", "plain"],
  title: ["title", "plain"],
  hypothesis: ["hypothesis", "plain"],
  rationale: ["rationale", "plain"],
  design: ["design", "plain"],
  approach: ["approach", "plain"],
  params: ["params", "json"],
  status: ["status", "plain"],
  decision: ["decision", "plain"],
  decisionReason: ["decision_reason", "plain"],
  agentKind: ["agent_kind", "plain"],
  model: ["model", "plain"],
  threadId: ["thread_id", "plain"],
  threadLink: ["thread_link", "plain"],
  agentRunId: ["agent_run_id", "plain"],
  worktreePath: ["worktree_path", "plain"],
  branch: ["branch", "plain"],
  baseSha: ["base_sha", "plain"],
  commitSha: ["commit_sha", "plain"],
  changedFiles: ["changed_files", "json"],
  diff: ["diff", "plain"],
  report: ["report", "plain"],
  metric: ["metric", "plain"],
  metricSpread: ["metric_spread", "plain"],
  metrics: ["metrics", "json"],
  passed: ["passed", "bool"],
  review: ["review", "plain"],
  reviewVerdict: ["review_verdict", "plain"],
  reviewThreadId: ["review_thread_id", "plain"],
  reviewThreadLink: ["review_thread_link", "plain"],
  lessons: ["lessons", "plain"],
  failureReason: ["failure_reason", "plain"],
  retries: ["retries", "plain"],
  pinned: ["pinned", "bool"],
  rejected: ["rejected", "bool"],
  awaitingInput: ["awaiting_input", "bool"],
  startedAt: ["started_at", "plain"],
  finishedAt: ["finished_at", "plain"],
};

function encode(v: unknown, how: "json" | "plain" | "bool") {
  if (how === "json") return json(v);
  if (how === "bool") return v == null ? null : v ? 1 : 0;
  return (v ?? null) as any;
}

export class ResearchStore {
  constructor(readonly db: DatabaseSync) {
    db.exec(SCHEMA);
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ---------- runs
  createRun(
    r: Omit<
      ResearchRun,
      "id" | "createdAt" | "updatedAt" | "activeMs" | "baselineId" | "bestId" | "baseSha" | "startedAt" | "resumedAt" | "endedAt" | "researcherThreadId" | "researcherThreadLink" | "statusDetail" | "researcherAsk" | "referencePath"
    >,
  ): ResearchRun {
    const id = randomUUID();
    const t = now();
    this.db
      .prepare(
        `INSERT INTO research_runs (id,title,objective,project_id,project_title,repo_path,base_ref,allowed_scope,eval,strategy,roles,models,permission_mode,limits,status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, r.title, r.objective, r.projectId, r.projectTitle, r.repoPath, r.baseRef, json(r.allowedScope), json(r.eval), r.strategy, json(r.roles), json(r.models), r.permissionMode, json(r.limits), r.status, t, t);
    return this.run(id)!;
  }

  run(id: string): ResearchRun | null {
    const r = this.db.prepare("SELECT * FROM research_runs WHERE id=?").get(id) as any;
    return r ? rowToRun(r) : null;
  }

  runs(): ResearchRun[] {
    return (this.db.prepare("SELECT * FROM research_runs ORDER BY updated_at DESC").all() as any[]).map(rowToRun);
  }

  updateRun(id: string, patch: Partial<ResearchRun>) {
    const sets: string[] = [];
    const vals: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const c = RUN_COLS[k];
      if (!c) throw new Error(`Cannot update run field ${k}`);
      sets.push(`${c[0]}=?`);
      vals.push(encode(v, c[1]));
    }
    if (!sets.length) return;
    sets.push("updated_at=?");
    vals.push(now(), id);
    this.db.prepare(`UPDATE research_runs SET ${sets.join(",")} WHERE id=?`).run(...vals);
  }

  // ---------- experiments
  addExperiment(e: Pick<Experiment, "runId" | "kind" | "source" | "title" | "hypothesis"> & Partial<Experiment>): Experiment {
    const id = randomUUID();
    const t = now();
    const seq = ((this.db.prepare("SELECT MAX(seq) AS m FROM research_experiments WHERE run_id=?").get(e.runId) as any)?.m ?? -1) + 1;
    this.db
      .prepare(
        `INSERT INTO research_experiments (id,run_id,seq,parent_id,kind,source,title,hypothesis,rationale,design,approach,params,status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, e.runId, seq, e.parentId ?? null, e.kind, e.source, e.title, e.hypothesis, e.rationale ?? "", e.design ?? "", e.approach ?? "", json(e.params ?? {}), e.status ?? "proposed", t, t);
    return this.experiment(id)!;
  }

  experiment(id: string): Experiment | null {
    const r = this.db.prepare("SELECT * FROM research_experiments WHERE id=?").get(id) as any;
    return r ? rowToExperiment(r) : null;
  }

  experiments(runId: string, where = "", ...args: any[]): Experiment[] {
    return (this.db.prepare(`SELECT * FROM research_experiments WHERE run_id=? ${where ? `AND ${where}` : ""} ORDER BY seq`).all(runId, ...args) as any[]).map(rowToExperiment);
  }

  updateExperiment(id: string, patch: Partial<Experiment>) {
    const sets: string[] = [];
    const vals: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const c = EXP_COLS[k];
      if (!c) throw new Error(`Cannot update experiment field ${k}`);
      sets.push(`${c[0]}=?`);
      vals.push(encode(v, c[1]));
    }
    if (!sets.length) return;
    sets.push("updated_at=?");
    vals.push(now(), id);
    this.db.prepare(`UPDATE research_experiments SET ${sets.join(",")} WHERE id=?`).run(...vals);
  }

  // ---------- evaluations
  addEval(s: Omit<EvalSample, "id"> & { runId: string }): EvalSample {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO research_evals (id,run_id,experiment_id,attempt,revision,exit_code,metric,pass,metrics,error,duration_ms,stdout_tail,stderr_tail,started_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, s.runId, s.experimentId, s.attempt, s.revision, s.exitCode, s.metric, s.pass == null ? null : s.pass ? 1 : 0, json(s.metrics), s.error, s.durationMs, s.stdoutTail, s.stderrTail, s.startedAt);
    return { ...s, id };
  }

  evals(runId: string): EvalSample[] {
    return (this.db.prepare("SELECT * FROM research_evals WHERE run_id=? ORDER BY started_at").all(runId) as any[]).map(rowToEval);
  }

  evalsFor(experimentId: string): EvalSample[] {
    return (this.db.prepare("SELECT * FROM research_evals WHERE experiment_id=? ORDER BY started_at").all(experimentId) as any[]).map(rowToEval);
  }

  // ---------- events
  event(runId: string, kind: string, message: string, experimentId: string | null = null) {
    this.db.prepare("INSERT INTO research_events (run_id,at,experiment_id,kind,message) VALUES (?,?,?,?,?)").run(runId, now(), experimentId, kind, message);
  }

  events(runId: string, limit = 500): ResearchEvent[] {
    return (this.db.prepare("SELECT * FROM research_events WHERE run_id=? ORDER BY id DESC LIMIT ?").all(runId, limit) as any[])
      .reverse()
      .map((r) => ({ id: r.id, runId: r.run_id, at: r.at, experimentId: r.experiment_id, kind: r.kind, message: r.message }));
  }
}

function rowToRun(r: any): ResearchRun {
  return {
    id: r.id,
    title: r.title,
    objective: r.objective,
    projectId: r.project_id,
    projectTitle: r.project_title,
    repoPath: r.repo_path,
    baseRef: r.base_ref,
    baseSha: r.base_sha,
    allowedScope: parse(r.allowed_scope, []),
    eval: parse(r.eval, {} as any),
    strategy: r.strategy,
    roles: parse(r.roles, {} as any),
    models: parse(r.models, {}),
    permissionMode: r.permission_mode,
    limits: parse(r.limits, {} as any),
    status: r.status,
    statusDetail: r.status_detail,
    baselineId: r.baseline_id,
    bestId: r.best_id,
    activeMs: r.active_ms,
    startedAt: r.started_at,
    resumedAt: r.resumed_at,
    endedAt: r.ended_at,
    researcherThreadId: r.researcher_thread_id,
    researcherThreadLink: r.researcher_thread_link,
    researcherAsk: parse(r.researcher_ask, null),
    referencePath: r.reference_path,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToExperiment(r: any): Experiment {
  return {
    id: r.id,
    runId: r.run_id,
    seq: r.seq,
    parentId: r.parent_id,
    kind: r.kind,
    source: r.source,
    title: r.title,
    hypothesis: r.hypothesis,
    rationale: r.rationale,
    design: r.design,
    approach: r.approach,
    params: parse(r.params, {}),
    status: r.status,
    decision: r.decision,
    decisionReason: r.decision_reason,
    agentKind: r.agent_kind,
    model: r.model,
    threadId: r.thread_id,
    threadLink: r.thread_link,
    agentRunId: r.agent_run_id,
    worktreePath: r.worktree_path,
    branch: r.branch,
    baseSha: r.base_sha,
    commitSha: r.commit_sha,
    changedFiles: parse(r.changed_files, []),
    diff: r.diff,
    report: r.report,
    metric: r.metric,
    metricSpread: r.metric_spread,
    metrics: parse(r.metrics, {}),
    passed: r.passed == null ? null : !!r.passed,
    review: r.review,
    reviewVerdict: r.review_verdict,
    reviewThreadId: r.review_thread_id,
    reviewThreadLink: r.review_thread_link,
    lessons: r.lessons,
    failureReason: r.failure_reason,
    retries: r.retries,
    pinned: !!r.pinned,
    rejected: !!r.rejected,
    awaitingInput: !!r.awaiting_input,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToEval(r: any): EvalSample {
  return {
    id: r.id,
    experimentId: r.experiment_id,
    attempt: r.attempt,
    revision: r.revision,
    exitCode: r.exit_code,
    metric: r.metric,
    pass: r.pass == null ? null : !!r.pass,
    metrics: parse(r.metrics, {}),
    error: r.error,
    durationMs: r.duration_ms,
    stdoutTail: r.stdout_tail,
    stderrTail: r.stderr_tail,
    startedAt: r.started_at,
  };
}
