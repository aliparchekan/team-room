// AutoResearch engine: the ORCHESTRATOR role. A deterministic state machine
// over the research tables. It asks the RESEARCHER agent for hypotheses, gives
// each experiment to an IMPLEMENTER agent in its own git worktree, runs the
// evaluation itself, has the EVALUATOR agent check candidate improvements, and
// keeps the best valid result. Agents run as real T3 threads; all state lives
// in SQLite, so a restart resumes from the records, not from agent memory.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentKind } from "../../shared/types.js";
import { PERMISSION_LABELS, PERMISSION_MODES } from "../../shared/types.js";
import {
  RESEARCH_STRATEGIES,
  type CreateResearchInput,
  type Decision,
  type EvalConfig,
  type Experiment,
  type ResearchLimits,
  type ResearchRun,
  type ResearchView,
} from "../../shared/research.js";
import { T3ToolError } from "../t3/connection.js";
import { TERMINAL_RUN, type T3Adapter } from "../t3/types.js";
import { AGENT_NAMES } from "../envelope.js";
import { ResearchStore } from "./store.js";
import { compare, improvementPct, runEvaluation, summarize, type Summary } from "./evaluator.js";
import { STRATEGIES, exhaustedApproaches, normalizeApproach } from "./strategies.js";
import { implementerPrompt, parseResearcherReply, parseReview, researcherPrompt, retryPrompt, reviewerPrompt } from "./prompts.js";
import {
  changedFiles,
  commitAll,
  createWorktree,
  diffText,
  removeOwnedWorktree,
  repoRoot,
  resetOwnedWorktree,
  resolveRef,
  scopeViolations,
  snapshotPaths,
  uncommitted,
} from "./workspace.js";

export class ResearchError extends Error {}

const ACTIVE: Experiment["status"][] = ["implementing", "eval_queued", "evaluating", "reviewing"];
const LIVE_RUN: ResearchRun["status"][] = ["baseline", "running", "paused", "finishing", "stopping"];
const MAX_RESEARCHER_ATTEMPTS = 2;

export const DEFAULT_LIMITS: ResearchLimits = {
  maxExperiments: 12,
  maxMinutes: 120,
  maxConcurrency: 2,
  maxRetries: 1,
  stagnationLimit: 6,
  maxSpendUsd: null,
};

const other = (k: AgentKind): AgentKind => (k === "claude" ? "codex" : "claude");
const fmt = (n: number | null | undefined) => (n == null ? "—" : Number(n.toPrecision(5)).toString());

export class ResearchEngine {
  onChange: (runId: string) => void = () => {};
  private locks = new Map<string, Promise<unknown>>();
  /** One evaluation at a time on this machine: parallel benchmarks would distort each other's timings. */
  private evaluating: Promise<void> | null = null;

  constructor(
    readonly store: ResearchStore,
    readonly t3: T3Adapter,
    readonly opts: { dataDir: string },
  ) {}

  private withRun<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(runId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(runId, next.catch(() => {}));
    return next.finally(() => this.onChange(runId));
  }

  private run(id: string): ResearchRun {
    const r = this.store.run(id);
    if (!r) throw new ResearchError("Research run not found");
    return r;
  }

  private runDir(run: ResearchRun) {
    return path.join(this.opts.dataDir, "research", run.id);
  }
  private snapshotDir(run: ResearchRun) {
    return path.join(this.runDir(run), "eval-snapshot");
  }
  private wtPath(run: ResearchRun, label: string) {
    return path.join(this.runDir(run), "wt", label);
  }
  /** Branch namespace this run owns. */
  namespace(run: ResearchRun) {
    return `autoresearch/${run.id.slice(0, 8)}/`;
  }

  private setStatus(run: ResearchRun, status: ResearchRun["status"], detail: string | null = null) {
    const patch: Partial<ResearchRun> = { status, statusDetail: detail };
    const counting = (s: string) => s === "running" || s === "finishing" || s === "baseline";
    if (counting(run.status) && run.resumedAt) patch.activeMs = run.activeMs + (Date.now() - Date.parse(run.resumedAt));
    patch.resumedAt = counting(status) ? new Date().toISOString() : null;
    if (["stopped", "completed"].includes(status)) patch.endedAt = new Date().toISOString();
    this.store.updateRun(run.id, patch);
    Object.assign(run, patch);
    if (detail) this.store.event(run.id, "status", `${status}: ${detail}`);
  }

  // ================================================================ create
  async createRun(input: CreateResearchInput): Promise<ResearchRun> {
    const st = this.t3.status();
    const project = st.projects.find((p) => p.id === input.projectId);
    if (!project) throw new ResearchError("Choose a T3 project. AutoResearch works in a git repository that T3 knows, so agents can run in experiment worktrees.");
    const repo = await repoRoot(project.workspaceRoot);
    if (!input.objective?.trim()) throw new ResearchError("Describe the research objective.");
    const ev = input.eval;
    if (!["command", "human"].includes(ev.kind)) throw new ResearchError("Unknown evaluation kind");
    if (ev.kind === "command" && !ev.command?.trim()) throw new ResearchError("Give an evaluation command, or choose assisted (human) evaluation.");
    if (!["minimize", "maximize", "pass_fail"].includes(ev.direction)) throw new ResearchError("Choose minimize, maximize, or pass/fail.");
    if (ev.kind === "human" && !ev.criteria?.trim()) throw new ResearchError("Assisted research needs written evaluation criteria.");
    const evalConfig: EvalConfig = {
      kind: ev.kind,
      command: ev.kind === "command" ? ev.command!.trim() : null,
      criteria: (ev.criteria ?? "").trim(),
      direction: ev.direction,
      metricName: ev.metricName?.trim() || "metric",
      repeats: clampInt(ev.repeats ?? 3, 1, 20, "Repeats"),
      minImprovement: clampNum(ev.minImprovement ?? 0.02, 0, 10, "Minimum improvement"),
      timeoutSec: clampInt(ev.timeoutSec ?? 300, 5, 7200, "Evaluation timeout"),
      protectedPaths: (ev.protectedPaths ?? []).map((p) => p.trim()).filter(Boolean),
    };
    const roles = input.roles;
    if (!roles?.implementers?.length) throw new ResearchError("Choose at least one implementer agent.");
    const used = new Set<AgentKind>([roles.researcher, ...roles.implementers]);
    if (roles.evaluator === "other") roles.implementers.forEach((k) => used.add(other(k)));
    else if (roles.evaluator !== "off") used.add(roles.evaluator);
    for (const k of used) if (!input.models?.[k]?.model) throw new ResearchError(`Choose a model for ${AGENT_NAMES[k]}.`);
    const permissionMode = input.permissionMode ?? "approval-required";
    const cap = st.maxPermission;
    if (cap && PERMISSION_MODES.indexOf(permissionMode) > PERMISSION_MODES.indexOf(cap))
      throw new ResearchError(`T3 lets Team Room start agents up to ${PERMISSION_LABELS[cap]}. Choose that or less, or raise Team Room's access in T3.`);
    const limits = validLimits({ ...DEFAULT_LIMITS, ...(input.limits ?? {}) });
    const strategy = input.strategy ?? "explore_exploit";
    if (!RESEARCH_STRATEGIES.includes(strategy)) throw new ResearchError(`Unknown strategy ${strategy}`);
    const run = this.store.createRun({
      title: input.title?.trim() || input.objective.trim().slice(0, 60),
      objective: input.objective.trim(),
      projectId: project.id,
      projectTitle: project.title,
      repoPath: repo,
      baseRef: input.baseRef?.trim() || "HEAD",
      allowedScope: input.allowedScope.map((s) => s.trim()).filter(Boolean),
      eval: evalConfig,
      strategy,
      roles,
      models: input.models,
      permissionMode,
      limits,
      status: "draft",
    });
    this.store.event(run.id, "created", `Run created on ${project.title} (${repo}).`);
    return run;
  }

  // ================================================================ controls
  start(runId: string) {
    return this.withRun(runId, async () => {
      const run = this.run(runId);
      if (run.baselineId && run.status !== "needs_attention") throw new ResearchError("This run has already started.");
      const baseSha = await resolveRef(run.repoPath, run.baseRef);
      const dirty = await uncommitted(run.repoPath);
      if (dirty.length)
        this.store.event(run.id, "warning", `Your checkout has ${dirty.length} uncommitted change(s). They are not part of the baseline (${run.baseRef} = ${baseSha.slice(0, 10)}) and AutoResearch never touches them.`);
      if (run.eval.kind === "command") {
        fs.rmSync(this.snapshotDir(run), { recursive: true, force: true });
        fs.mkdirSync(this.snapshotDir(run), { recursive: true });
        const files = await snapshotPaths(run.repoPath, baseSha, run.eval.protectedPaths, this.snapshotDir(run));
        this.store.event(run.id, "setup", files.length ? `Froze ${files.length} protected evaluation file(s) from ${baseSha.slice(0, 10)}.` : "No protected paths: the evaluation command is not shielded from experiments. List the evaluation files as protected to keep it independent.");
      }
      // A failed earlier attempt leaves an invalid baseline behind; start a fresh one.
      const old = run.baselineId ? this.store.experiment(run.baselineId) : null;
      if (old) this.store.updateExperiment(old.id, { status: "cancelled", decision: "invalid", decisionReason: old.decisionReason ?? "Superseded by a new baseline" });
      const base = this.store.addExperiment({
        runId: run.id,
        kind: "baseline",
        source: "human",
        title: "Baseline",
        hypothesis: `Unmodified code at ${run.baseRef} (${baseSha.slice(0, 10)}).`,
        status: run.eval.kind === "command" ? "eval_queued" : "done",
      });
      const wt = await createWorktree(run.repoPath, this.wtPath(run, `E${base.seq}`), `${this.namespace(run)}E${base.seq}`, baseSha);
      this.store.updateExperiment(base.id, { worktreePath: wt.path, branch: wt.branch, baseSha, commitSha: baseSha, startedAt: new Date().toISOString() });
      const ref = await createWorktree(run.repoPath, this.wtPath(run, "reference"), `${this.namespace(run)}reference`, baseSha);
      this.store.updateRun(run.id, { baseSha, baselineId: base.id, referencePath: ref.path, startedAt: run.startedAt ?? new Date().toISOString() });
      Object.assign(run, { baseSha, baselineId: base.id, referencePath: ref.path });
      if (run.eval.kind === "command") this.setStatus(run, "baseline", `Measuring the baseline (${run.eval.repeats} run${run.eval.repeats === 1 ? "" : "s"}).`);
      else {
        this.store.updateExperiment(base.id, { decision: "keep", decisionReason: "Baseline (assisted research: judged by the human lead)", finishedAt: new Date().toISOString() });
        this.store.updateRun(run.id, { bestId: base.id });
        this.setStatus(run, "running", null);
      }
      this.kickEvaluations();
    });
  }

  pause(runId: string) {
    return this.withRun(runId, async () => {
      const run = this.run(runId);
      if (!["running", "finishing", "baseline"].includes(run.status)) throw new ResearchError(`Cannot pause a ${run.status} run.`);
      this.setStatus(run, "paused", "Paused by you. Agents already working finish their current step; nothing new starts.");
    });
  }

  resume(runId: string) {
    return this.withRun(runId, async () => {
      const run = this.run(runId);
      if (!["paused", "needs_attention", "stopped", "completed"].includes(run.status)) throw new ResearchError(`Cannot resume a ${run.status} run.`);
      const base = run.baselineId ? this.store.experiment(run.baselineId) : null;
      if (!base || base.decision !== "keep") throw new ResearchError("The baseline has not been measured. Use Start.");
      await this.ensureReference(run);
      if (["stopped", "completed"].includes(run.status)) {
        const started = this.store.experiments(run.id, "kind='experiment' AND started_at IS NOT NULL").length;
        if (started >= run.limits.maxExperiments) throw new ResearchError("The experiment limit is reached. Raise it under Budget first.");
        this.store.updateRun(run.id, { endedAt: null });
      }
      this.store.event(run.id, "resume", "Resumed. State rebuilt from Team Room's records.");
      this.setStatus(run, "running", null);
    });
  }

  stop(runId: string) {
    return this.withRun(runId, async () => {
      const run = this.run(runId);
      if (!LIVE_RUN.includes(run.status) && run.status !== "needs_attention") throw new ResearchError(`The run is already ${run.status}.`);
      if (run.researcherAsk && run.researcherThreadId) await this.t3.interrupt({ threadId: run.researcherThreadId }).catch(() => {});
      this.store.updateRun(run.id, { researcherAsk: null });
      for (const e of this.store.experiments(run.id)) {
        if (e.status === "proposed" || e.status === "eval_queued" || e.status === "awaiting_human")
          this.store.updateExperiment(e.id, { status: "cancelled", decisionReason: "Run stopped before it finished" });
        else if ((e.status === "implementing" || e.status === "reviewing") && (e.status === "implementing" ? e.threadId : e.reviewThreadId))
          await this.t3.interrupt({ threadId: (e.status === "implementing" ? e.threadId : e.reviewThreadId)! }).catch(() => {});
      }
      this.setStatus(run, "stopping", "Stopping: asked T3 to interrupt every agent of this run; waiting until they have stopped.");
    });
  }

  updateLimits(runId: string, patch: Partial<ResearchLimits>) {
    return this.withRun(runId, async () => {
      const run = this.run(runId);
      const limits = validLimits({ ...run.limits, ...patch });
      this.store.updateRun(run.id, { limits });
      this.store.event(run.id, "budget", `Limits changed: ${limits.maxExperiments} experiments, ${limits.maxMinutes} min, ${limits.maxConcurrency} at a time, ${limits.maxRetries} retries, stop after ${limits.stagnationLimit} without improvement.`);
      if (run.status === "finishing" && /limit reached|No improvement/.test(run.statusDetail ?? "")) this.setStatus(run, "running", null);
    });
  }

  suggest(runId: string, input: { hypothesis: string; parentSeq?: number | null; approach?: string }) {
    return this.withRun(runId, async () => {
      const run = this.run(runId);
      const text = input.hypothesis.trim();
      if (!text) throw new ResearchError("Write the hypothesis.");
      if (!run.bestId) throw new ResearchError("Wait for the baseline before suggesting experiments.");
      const parent = input.parentSeq != null ? this.store.experiments(run.id, "seq=?", input.parentSeq)[0] : this.store.experiment(run.bestId);
      if (!parent?.commitSha || (parent.kind === "experiment" && parent.decision !== "keep")) throw new ResearchError("Build on the baseline or a kept experiment.");
      const e = this.store.addExperiment({
        runId: run.id,
        kind: "experiment",
        source: "human",
        title: text.split("\n")[0].slice(0, 80),
        hypothesis: text,
        approach: input.approach?.trim() || "human suggestion",
        parentId: parent.id,
        status: "proposed",
      });
      this.store.event(run.id, "suggestion", `You suggested E${e.seq}: ${e.title}. It runs next.`, e.id);
    });
  }

  setPinned(runId: string, expId: string, pinned: boolean) {
    return this.withRun(runId, async () => {
      const e = this.exp(runId, expId);
      this.store.updateExperiment(e.id, { pinned });
      this.store.event(runId, "pin", `${pinned ? "Pinned" : "Unpinned"} E${e.seq}.`, e.id);
    });
  }

  rejectDirection(runId: string, expId: string) {
    return this.withRun(runId, async () => {
      const run = this.run(runId);
      const e = this.exp(runId, expId);
      if (e.kind === "baseline") throw new ResearchError("The baseline cannot be rejected.");
      if (run.bestId === e.id) throw new ResearchError("This is the current best result; it stays the reference.");
      this.store.updateExperiment(e.id, { rejected: true });
      const key = normalizeApproach(e.approach);
      let cancelled = 0;
      for (const p of this.store.experiments(runId, "status='proposed'"))
        if (this.descendsFrom(runId, p, e.id) || (key && normalizeApproach(p.approach) === key)) {
          this.store.updateExperiment(p.id, { status: "cancelled", decisionReason: `Direction of E${e.seq} rejected by you` });
          cancelled++;
        }
      this.store.event(runId, "reject", `Rejected the direction of E${e.seq} (${e.approach || e.title}). ${cancelled} queued experiment(s) cancelled; the researcher is told not to pursue it.`, e.id);
    });
  }

  /** Assisted evaluation: the human judges an experiment against the written criteria. */
  humanDecide(runId: string, expId: string, decision: Decision, note: string) {
    return this.withRun(runId, async () => {
      const run = this.run(runId);
      const e = this.exp(runId, expId);
      if (e.status !== "awaiting_human") throw new ResearchError(`E${e.seq} is not waiting for your judgement.`);
      await this.decide(run, e, decision, `Judged by the human lead${note.trim() ? `: ${note.trim()}` : ""}`, decision === "keep");
    });
  }

  private exp(runId: string, expId: string) {
    const e = this.store.experiment(expId);
    if (!e || e.runId !== runId) throw new ResearchError("Experiment not found");
    return e;
  }

  private descendsFrom(runId: string, e: Experiment, ancestorId: string) {
    let cur: Experiment | null = e;
    for (let i = 0; cur && i < 1000; i++) {
      if (cur.parentId === ancestorId) return true;
      cur = cur.parentId ? this.store.experiment(cur.parentId) : null;
    }
    return false;
  }

  // ================================================================ tick
  /** True while a research run is measuring, experimenting, finishing or stopping. */
  isBusy(): boolean {
    return !!this.evaluating || this.store.runs().some((r) => ["baseline", "running", "finishing", "stopping"].includes(r.status));
  }

  /** Called by the server's poll loop. Advances every live run one step. */
  async tick() {
    for (const run of this.store.runs()) if (LIVE_RUN.includes(run.status)) await this.withRun(run.id, () => this.step(run.id));
    this.kickEvaluations();
  }

  /** After a restart: an evaluation that was running died with the process, so measure it again. */
  recoverOnStartup() {
    for (const run of this.store.runs()) {
      for (const e of this.store.experiments(run.id, "status='evaluating'")) {
        this.store.updateExperiment(e.id, { status: "eval_queued" });
        this.store.event(run.id, "recovery", `E${e.seq}'s evaluation was interrupted by a restart; measuring it again.`, e.id);
      }
      if (["running", "finishing", "baseline"].includes(run.status)) this.store.updateRun(run.id, { resumedAt: new Date().toISOString() });
    }
  }

  private async step(runId: string) {
    const run = this.run(runId);
    if (["running", "finishing", "baseline"].includes(run.status) && run.resumedAt) {
      const nowIso = new Date().toISOString();
      this.store.updateRun(run.id, { activeMs: run.activeMs + (Date.now() - Date.parse(run.resumedAt)), resumedAt: nowIso });
      run.activeMs += Date.now() - Date.parse(run.resumedAt);
      run.resumedAt = nowIso;
    }
    await this.pollResearcher(run);
    for (const e of this.store.experiments(run.id, "status IN ('implementing','reviewing')")) await this.pollAgent(run, e);
    const fresh = this.run(runId);
    if (fresh.status === "stopping") return this.finishStopping(fresh);
    if (fresh.status === "running") {
      if (this.checkLimits(fresh)) return;
      await this.schedule(fresh);
    }
    if (fresh.status === "finishing") {
      const busy = this.store.experiments(fresh.id).some((e) => ACTIVE.includes(e.status));
      if (!busy && !fresh.researcherAsk) {
        await this.cleanupWorktrees(fresh);
        this.setStatus(fresh, "completed", fresh.statusDetail?.replace(/;.*$/, "") ?? "Done.");
      }
    }
  }

  private checkLimits(run: ResearchRun): boolean {
    const exps = this.store.experiments(run.id, "kind='experiment'");
    const started = exps.filter((e) => e.startedAt).length;
    const reason =
      started >= run.limits.maxExperiments
        ? `Experiment limit reached (${run.limits.maxExperiments})`
        : run.activeMs >= run.limits.maxMinutes * 60_000
          ? `Time limit reached (${run.limits.maxMinutes} min)`
          : this.stagnation(exps) >= run.limits.stagnationLimit
            ? `No improvement in the last ${run.limits.stagnationLimit} experiments`
            : null;
    if (!reason) return false;
    for (const e of exps.filter((x) => x.status === "proposed")) this.store.updateExperiment(e.id, { status: "cancelled", decisionReason: `Not started: ${reason.toLowerCase()}` });
    if (run.researcherAsk && run.researcherThreadId) {
      this.t3.interrupt({ threadId: run.researcherThreadId }).catch(() => {});
      this.store.updateRun(run.id, { researcherAsk: null });
      run.researcherAsk = null;
    }
    this.setStatus(run, "finishing", `${reason}; letting running experiments finish.`);
    return true;
  }

  private stagnation(exps: Experiment[]) {
    const decided = exps.filter((e) => e.decision && e.finishedAt).sort((a, b) => a.finishedAt!.localeCompare(b.finishedAt!));
    let streak = 0;
    for (let i = decided.length - 1; i >= 0 && decided[i].decision !== "keep"; i--) streak++;
    return streak;
  }

  private async schedule(run: ResearchRun) {
    const exps = this.store.experiments(run.id);
    const best = this.store.experiment(run.bestId!)!;
    const baseline = this.store.experiment(run.baselineId!)!;
    let active = exps.filter((e) => ACTIVE.includes(e.status)).length;
    const started = exps.filter((e) => e.kind === "experiment" && e.startedAt).length;
    let remaining = run.limits.maxExperiments - started;
    const proposed = exps.filter((e) => e.status === "proposed").sort((a, b) => (a.source === b.source ? a.seq - b.seq : a.source === "human" ? -1 : 1));
    for (const p of proposed) {
      if (active >= run.limits.maxConcurrency || remaining <= 0) break;
      await this.launchExperiment(run, p);
      active++;
      remaining--;
    }
    if (run.researcherAsk) return;
    const queued = this.store.experiments(run.id, "status='proposed'").length;
    const freeSlots = Math.max(0, Math.min(run.limits.maxConcurrency - active - queued, remaining - queued));
    const strategy = STRATEGIES[run.strategy];
    const ctx = { run, experiments: this.store.experiments(run.id), best, baseline, freeSlots };
    const wanted = strategy.wanted(ctx);
    if (wanted > 0) await this.askResearcher(run, wanted);
  }

  // ================================================================ researcher
  private async ensureReference(run: ResearchRun) {
    const best = this.store.experiment(run.bestId ?? run.baselineId!)!;
    const p = run.referencePath ?? this.wtPath(run, "reference");
    if (!fs.existsSync(p)) await createWorktree(run.repoPath, p, `${this.namespace(run)}reference`, best.commitSha!);
    await resetOwnedWorktree(p, best.commitSha!);
    if (run.referencePath !== p) this.store.updateRun(run.id, { referencePath: p });
    run.referencePath = p;
  }

  private async askResearcher(run: ResearchRun, wanted: number) {
    await this.ensureReference(run);
    const exps = this.store.experiments(run.id);
    const best = this.store.experiment(run.bestId!)!;
    const baseline = this.store.experiment(run.baselineId!)!;
    const strategy = STRATEGIES[run.strategy];
    const ctx = { run, experiments: exps, best, baseline, freeSlots: wanted };
    const needLessons = exps.filter((e) => e.kind === "experiment" && e.decision && !e.lessons).slice(-10);
    const prompt = researcherPrompt({
      run,
      experiments: exps.filter((e) => e.status !== "cancelled" || e.decision),
      best,
      baseline,
      wanted,
      parents: strategy.parents(ctx),
      guidance: strategy.guidance(ctx, wanted),
      exhausted: exhaustedApproaches(exps),
      needLessons,
      suggestions: exps.filter((e) => e.source === "human" && e.status === "proposed").map((e) => e.hypothesis),
    });
    const ask = { runId: null as string | null, wanted, lessonsFor: needLessons.map((e) => e.id), attempt: 0, requestedAt: new Date().toISOString(), clientRequestId: `ar-${run.id}-ask-${randomUUID()}` };
    this.store.updateRun(run.id, { researcherAsk: ask });
    run.researcherAsk = ask;
    const agent = run.roles.researcher;
    try {
      if (!run.researcherThreadId) {
        const res = await this.t3.launchThread({
          projectId: run.projectId,
          title: `${run.title} — AutoResearch researcher`,
          providerInstanceId: run.models[agent]!.providerInstanceId,
          model: run.models[agent]!.model,
          options: run.models[agent]!.options,
          message: prompt,
          clientRequestId: `ar-${run.id}-researcher`,
          workspace: { kind: "existing_worktree", worktreePath: run.referencePath! },
          runtimeMode: run.permissionMode,
        });
        this.store.updateRun(run.id, { researcherThreadId: res.threadId, researcherThreadLink: res.link, researcherAsk: { ...ask, runId: res.runId } });
      } else {
        const res = await this.t3.send({ threadId: run.researcherThreadId, message: prompt, mode: "queue", clientRequestId: ask.clientRequestId });
        this.store.updateRun(run.id, { researcherAsk: { ...ask, runId: res.runId } });
      }
      this.store.event(run.id, "research", `${AGENT_NAMES[agent]} (researcher) asked for ${wanted} hypothes${wanted === 1 ? "is" : "es"}.`);
    } catch (err) {
      this.store.updateRun(run.id, { researcherAsk: null });
      this.setStatus(run, "needs_attention", `Could not reach the researcher in T3: ${(err as Error).message}`);
    }
  }

  private async pollResearcher(run: ResearchRun) {
    const ask = run.researcherAsk;
    if (!ask) return;
    if (!run.researcherThreadId) {
      // The launch never confirmed (e.g. a restart mid-call). Asking again re-launches with the same
      // clientRequestId, which T3 de-duplicates.
      this.store.updateRun(run.id, { researcherAsk: null });
      run.researcherAsk = null;
      return;
    }
    const snap = await this.t3.readThread({ threadId: run.researcherThreadId, afterPosition: null });
    const r = ask.runId ? snap.runs.find((x) => x.runId === ask.runId) : snap.runs[snap.runs.length - 1];
    if (!r || !TERMINAL_RUN.has(r.status)) return;
    this.store.updateRun(run.id, { researcherAsk: null });
    run.researcherAsk = null;
    if (run.status === "stopping" || run.status === "finishing") return;
    const text = snap.items.filter((i) => i.role === "assistant" && i.runId === r.runId).map((i) => i.text).join("\n\n");
    const parsed = r.status === "completed" ? parseResearcherReply(text) : null;
    if (!parsed || !parsed.hypotheses.length) {
      if (ask.attempt + 1 < MAX_RESEARCHER_ATTEMPTS && r.status === "completed") {
        const retry = { ...ask, attempt: ask.attempt + 1, clientRequestId: `ar-${run.id}-ask-${randomUUID()}`, requestedAt: new Date().toISOString() };
        const res = await this.t3.send({
          threadId: run.researcherThreadId,
          message: "Team Room could not read hypotheses from your reply. Reply again with exactly one fenced ```json block in the format given, with the hypotheses in a \"hypotheses\" array.",
          mode: "queue",
          clientRequestId: retry.clientRequestId,
        });
        this.store.updateRun(run.id, { researcherAsk: { ...retry, runId: res.runId } });
        this.store.event(run.id, "research", "The researcher's reply had no readable hypotheses; asked again.");
        return;
      }
      this.setStatus(run, "needs_attention", r.status === "completed" ? "The researcher gave no usable hypotheses twice. Suggest one yourself, or Resume to ask again." : `The researcher's turn ended: ${r.status}.`);
      return;
    }
    const exps = this.store.experiments(run.id);
    const bySeq = (s: string | null) => (s ? exps.find((e) => `E${e.seq}` === s.trim().toUpperCase()) : undefined);
    for (const l of parsed.lessons) {
      const e = bySeq(l.experiment);
      if (e && e.kind === "experiment" && e.decision) this.store.updateExperiment(e.id, { lessons: l.lesson.trim().slice(0, 2000) });
    }
    const best = this.store.experiment(run.bestId!)!;
    const baseline = this.store.experiment(run.baselineId!)!;
    const allowedParents = STRATEGIES[run.strategy].parents({ run, experiments: exps, best, baseline, freeSlots: ask.wanted });
    const exhausted = new Map(exhaustedApproaches(exps).map((x) => [x.approach, x.reason]));
    for (const h of parsed.hypotheses.slice(0, ask.wanted)) {
      const asked = bySeq(h.parent);
      const parent = asked && allowedParents.some((p) => p.id === asked.id) ? asked : allowedParents[0];
      const e = this.store.addExperiment({
        runId: run.id,
        kind: "experiment",
        source: "researcher",
        title: h.title,
        hypothesis: h.hypothesis,
        rationale: h.mode ? `mode: ${h.mode}` : "",
        design: h.design,
        approach: h.approach,
        params: h.params,
        parentId: parent.id,
        status: "proposed",
      });
      const why = exhausted.get(normalizeApproach(h.approach));
      if (why) {
        this.store.updateExperiment(e.id, { status: "cancelled", decisionReason: `Skipped: the "${h.approach}" direction is closed (${why}).` });
        this.store.event(run.id, "skip", `Skipped E${e.seq}: direction "${h.approach}" is closed (${why}).`, e.id);
      } else this.store.event(run.id, "hypothesis", `E${e.seq} proposed (from E${parent.seq}): ${e.title}`, e.id);
    }
  }

  // ================================================================ implementers
  private pickImplementer(run: ResearchRun): AgentKind {
    const started = this.store.experiments(run.id, "kind='experiment' AND agent_kind IS NOT NULL").length;
    return run.roles.implementers[started % run.roles.implementers.length];
  }

  private async launchExperiment(run: ResearchRun, exp: Experiment) {
    const parent = this.store.experiment(exp.parentId!)!;
    const agent = this.pickImplementer(run);
    const model = run.models[agent]!;
    try {
      const wt = await createWorktree(run.repoPath, this.wtPath(run, `E${exp.seq}`), `${this.namespace(run)}E${exp.seq}`, parent.commitSha!);
      this.store.updateExperiment(exp.id, {
        status: "implementing",
        agentKind: agent,
        model: model.model,
        worktreePath: wt.path,
        branch: wt.branch,
        baseSha: parent.commitSha,
        startedAt: new Date().toISOString(),
      });
      const fresh = this.store.experiment(exp.id)!;
      await this.launchImplementer(run, fresh, parent);
      this.store.event(run.id, "launch", `E${exp.seq} started: ${AGENT_NAMES[agent]} implements "${exp.title}" in its own worktree (${wt.branch}).`, exp.id);
    } catch (err) {
      await this.decide(run, this.store.experiment(exp.id)!, "invalid", `Could not start: ${(err as Error).message}`, false);
    }
  }

  private async launchImplementer(run: ResearchRun, exp: Experiment, parent: Experiment) {
    const model = run.models[exp.agentKind!]!;
    try {
      const res = await this.t3.launchThread({
        projectId: run.projectId,
        title: `${run.title} — E${exp.seq}: ${exp.title}`.slice(0, 120),
        providerInstanceId: model.providerInstanceId,
        model: model.model,
        options: model.options,
        message: implementerPrompt(run, exp, parent),
        clientRequestId: `ar-${exp.id}-impl`,
        workspace: { kind: "existing_worktree", worktreePath: exp.worktreePath! },
        runtimeMode: run.permissionMode,
      });
      this.store.updateExperiment(exp.id, { threadId: res.threadId, threadLink: res.link, agentRunId: res.runId });
    } catch (err) {
      // A lost reply is retried next tick with the same clientRequestId (T3 de-duplicates); a refusal is final.
      const transient = !(err instanceof T3ToolError) || ["transport_error", "auth_expired"].includes(err.code);
      if (!transient) throw err;
      this.store.event(run.id, "warning", `Launching E${exp.seq}'s implementer did not confirm (${(err as Error).message}); retrying.`, exp.id);
    }
  }

  private async pollAgent(run: ResearchRun, exp: Experiment) {
    const reviewing = exp.status === "reviewing";
    const threadId = reviewing ? exp.reviewThreadId : exp.threadId;
    if (!threadId) {
      if (!reviewing && run.status !== "stopping") await this.launchImplementer(run, exp, this.store.experiment(exp.parentId!)!).catch(async (err) => this.decide(run, exp, "invalid", `Could not start: ${err.message}`, false));
      return;
    }
    const snap = await this.t3.readThread({ threadId, afterPosition: null });
    if (snap.hasPendingRequest !== exp.awaitingInput) {
      this.store.updateExperiment(exp.id, { awaitingInput: snap.hasPendingRequest });
      if (snap.hasPendingRequest) this.store.event(run.id, "approval", `E${exp.seq}: ${reviewing ? "the evaluator" : "the implementer"} is waiting for your approval in T3.`, exp.id);
    }
    const r = !reviewing && exp.agentRunId ? snap.runs.find((x) => x.runId === exp.agentRunId) : snap.runs[snap.runs.length - 1];
    if (!r || !TERMINAL_RUN.has(r.status)) return;
    const text = snap.items.filter((i) => i.role === "assistant" && i.runId === r.runId).map((i) => i.text).join("\n\n").trim();
    if (run.status === "stopping") {
      await this.cancel(run, exp, "Run stopped");
      return;
    }
    if (reviewing) return this.afterReview(run, exp, r.status === "completed" ? text : "");
    this.store.updateExperiment(exp.id, { report: text || null, awaitingInput: false });
    if (r.status !== "completed") return this.failOrRetry(run, exp, `The implementer's turn ended: ${r.status}.`);
    // Team Room commits the agent's work on the experiment branch, then checks it against the rules.
    const sha = await commitAll(exp.worktreePath!, `AutoResearch E${exp.seq}: ${exp.title}`);
    const files = await changedFiles(exp.worktreePath!, exp.baseSha!, sha);
    const diff = await diffText(exp.worktreePath!, exp.baseSha!, sha);
    this.store.updateExperiment(exp.id, { commitSha: sha, changedFiles: files, diff });
    if (!files.length) return this.decide(run, exp, "invalid", "The implementer made no changes.", false);
    const v = scopeViolations(files, run.allowedScope, run.eval.protectedPaths);
    if (v.protectedTouched.length || v.outOfScope.length) {
      const what = [
        v.protectedTouched.length ? `changed protected evaluation files (${v.protectedTouched.join(", ")})` : "",
        v.outOfScope.length ? `changed files outside the approved scope (${v.outOfScope.join(", ")})` : "",
      ].filter(Boolean).join(" and ");
      await this.decide(run, this.store.experiment(exp.id)!, "invalid", `Rejected: it ${what}.`, false);
      if (run.status === "running") this.setStatus(run, "paused", `E${exp.seq} ${what}. It was rejected and not evaluated. Look at it, then Resume.`);
      return;
    }
    if (run.eval.kind === "human") {
      this.store.updateExperiment(exp.id, { status: "awaiting_human" });
      this.store.event(run.id, "assisted", `E${exp.seq} is ready for your judgement against the criteria.`, exp.id);
      return;
    }
    this.store.updateExperiment(exp.id, { status: "eval_queued" });
    this.store.event(run.id, "commit", `E${exp.seq} committed ${sha.slice(0, 10)} (${files.length} file${files.length === 1 ? "" : "s"}); queued for evaluation.`, exp.id);
  }

  /** Bounded retries: send the problem back to the same implementer, or give up as invalid. */
  private async failOrRetry(run: ResearchRun, exp: Experiment, problem: string) {
    if (exp.retries < run.limits.maxRetries && exp.threadId && run.status !== "stopping") {
      const attempt = exp.retries + 1;
      const res = await this.t3.send({ threadId: exp.threadId, message: retryPrompt(exp, problem, attempt, run.limits.maxRetries, run.roles.agentCommands), mode: "queue", clientRequestId: `ar-${exp.id}-retry-${attempt}` });
      this.store.updateExperiment(exp.id, { status: "implementing", retries: attempt, agentRunId: res.runId, failureReason: problem.slice(0, 2000) });
      this.store.event(run.id, "retry", `E${exp.seq}: retry ${attempt}/${run.limits.maxRetries} — ${problem.split("\n")[0].slice(0, 200)}`, exp.id);
      return;
    }
    await this.decide(run, exp, "invalid", problem.split("\n")[0].slice(0, 500), false);
    this.store.updateExperiment(exp.id, { failureReason: problem.slice(0, 4000) });
  }

  // ================================================================ evaluation
  /** Start the next queued evaluation if none is running (machine-wide, one at a time). */
  kickEvaluations() {
    if (this.evaluating) return;
    const next = this.nextEvaluation();
    if (!next) return;
    this.evaluating = this.evaluateOne(next.run, next.exp)
      .catch((err) => console.error("[autoresearch] evaluation", err))
      .finally(() => {
        this.evaluating = null;
        this.onChange(next.run.id);
        this.kickEvaluations();
      });
  }

  /** Test and script helper: wait until no evaluation is queued or running. */
  async drainEvaluations() {
    for (let i = 0; i < 1000; i++) {
      this.kickEvaluations();
      if (!this.evaluating) return;
      await this.evaluating;
    }
  }

  private nextEvaluation(): { run: ResearchRun; exp: Experiment } | null {
    for (const run of this.store.runs()) {
      if (!["baseline", "running", "paused", "finishing", "stopping"].includes(run.status)) continue;
      const e = this.store.experiments(run.id, "status='eval_queued'")[0];
      if (e) return { run, exp: e };
    }
    return null;
  }

  private async evaluateOne(run: ResearchRun, exp: Experiment) {
    if (run.status === "stopping") {
      await this.withRun(run.id, () => this.cancel(run, exp, "Run stopped"));
      return;
    }
    this.store.updateExperiment(exp.id, { status: "evaluating" });
    this.onChange(run.id);
    const prior = this.store.evalsFor(exp.id).filter((s) => s.revision === exp.commitSha).length;
    const repeats = prior > 0 ? run.eval.repeats * 2 : run.eval.repeats; // a re-measurement gets twice the samples
    for (let i = 0; i < repeats; i++) {
      const out = await runEvaluation({ cwd: exp.worktreePath!, command: run.eval.command!, snapshotDir: this.snapshotDir(run), timeoutSec: run.eval.timeoutSec });
      this.store.addEval({ runId: run.id, experimentId: exp.id, attempt: prior + i + 1, revision: exp.commitSha, startedAt: new Date(Date.now() - out.durationMs).toISOString(), ...out });
      this.onChange(run.id);
      if (out.pass === false) break; // a failing check is not a measurement worth repeating
    }
    await this.withRun(run.id, () => this.afterEvaluation(run.id, exp.id));
  }

  private summaryOf(exp: Experiment): Summary {
    const samples = this.store.evalsFor(exp.id).filter((s) => s.revision === exp.commitSha);
    return summarize(samples);
  }

  private async afterEvaluation(runId: string, expId: string) {
    const run = this.run(runId);
    const exp = this.store.experiment(expId)!;
    if (exp.status !== "evaluating") return;
    if (run.status === "stopping") return this.cancel(run, exp, "Run stopped");
    const s = this.summaryOf(exp);
    const last = this.store.evalsFor(exp.id).at(-1);
    this.store.updateExperiment(exp.id, { metric: s.metric, metricSpread: s.spread, passed: s.passed, metrics: last?.metrics ?? {} });
    const measured = `${run.eval.metricName} ${fmt(s.metric)} (median of ${s.samples}, spread ${(s.spread * 100).toFixed(1)}%)`;

    if (exp.kind === "baseline") {
      const unmeasurable =
        run.eval.direction !== "pass_fail" && s.metric == null
          ? `The evaluation printed no numeric "${run.eval.metricName}", so this objective is not measurable as configured. Make the command print a JSON line like {"metric": 1.23, "pass": true}, or use assisted (human) evaluation.`
          : run.eval.direction !== "pass_fail" && !s.passed
            ? `The baseline fails its own evaluation (${s.error ?? "check failed"}). Fix the code or the evaluation so the starting point is valid, then Start again.`
            : null;
      if (unmeasurable) {
        this.store.updateExperiment(exp.id, { status: "done", decision: "invalid", decisionReason: unmeasurable, finishedAt: new Date().toISOString() });
        this.setStatus(run, "needs_attention", unmeasurable);
        return;
      }
      this.store.updateExperiment(exp.id, { status: "done", decision: "keep", decisionReason: `Baseline: ${measured}`, finishedAt: new Date().toISOString() });
      this.store.updateRun(run.id, { bestId: exp.id });
      run.bestId = exp.id;
      this.store.event(run.id, "baseline", `Baseline measured: ${measured}.`, exp.id);
      if (s.spread > run.eval.minImprovement)
        this.store.event(run.id, "noise", `The baseline varies by ${(s.spread * 100).toFixed(1)}% between runs, more than the ${Math.round(run.eval.minImprovement * 100)}% minimum. Smaller differences will be treated as noise.`, exp.id);
      if (run.status === "baseline") this.setStatus(run, "running", null);
      return;
    }

    if (!s.passed) {
      const last = this.store.evalsFor(exp.id).filter((x) => x.revision === exp.commitSha).at(-1);
      const detail = [s.error ?? "The evaluation failed.", last?.stderrTail ? `stderr:\n${last.stderrTail.slice(-3000)}` : "", last?.stdoutTail ? `stdout:\n${last.stdoutTail.slice(-1500)}` : ""].filter(Boolean).join("\n\n");
      // Wrong answers are a result, not a build error: no retry for a correctness failure.
      if (/wrong answer|incorrect|mismatch|assert/i.test(s.error ?? "")) return this.decide(run, exp, "invalid", `Correctness check failed: ${s.error}`, false);
      return this.failOrRetry(run, exp, `Evaluation failed for E${exp.seq}: ${detail}`);
    }
    const best = this.store.experiment(run.bestId!)!;
    const cmp = compare(run.eval.direction, s, { metric: best.metric, spread: best.metricSpread ?? 0, passed: best.passed ?? true, samples: 1, error: null }, run.eval.minImprovement);
    const rel = cmp.relative != null ? ` (${describeChange(run.eval.direction, cmp.relative)} vs E${best.seq}; threshold ${(cmp.threshold * 100).toFixed(1)}%)` : "";
    this.store.event(run.id, "measure", `E${exp.seq}: ${measured}${rel}.`, exp.id);
    if (cmp.verdict === "noise") {
      const samples = this.store.evalsFor(exp.id).filter((x) => x.revision === exp.commitSha).length;
      if (samples < run.eval.repeats * 2) {
        this.store.updateExperiment(exp.id, { status: "eval_queued" });
        this.store.event(run.id, "noise", `E${exp.seq} is ahead but within the noise; measuring again with more runs.`, exp.id);
        return;
      }
      return this.decide(run, exp, "inconclusive", `Ahead of E${best.seq} but within measurement noise${rel}.`, false);
    }
    if (cmp.verdict === "better") {
      if (run.roles.evaluator !== "off") return this.launchReview(run, exp, best, `${measured}${rel}`);
      return this.decide(run, exp, "keep", `Improves on E${best.seq}${rel}.`, true);
    }
    return this.decide(run, exp, "discard", cmp.verdict === "worse" ? `Worse than E${best.seq}${rel}.` : `No improvement over E${best.seq}${rel}.`, false);
  }

  // ================================================================ evaluator agent
  private async launchReview(run: ResearchRun, exp: Experiment, best: Experiment, metricLine: string) {
    const reviewer = run.roles.evaluator === "other" ? other(exp.agentKind ?? run.roles.researcher) : (run.roles.evaluator as AgentKind);
    const model = run.models[reviewer];
    if (!model) return this.decide(run, exp, "keep", `Improves on E${best.seq}: ${metricLine}. (No evaluator model configured; not reviewed.)`, true);
    this.store.updateExperiment(exp.id, { status: "reviewing" });
    try {
      const res = await this.t3.launchThread({
        projectId: run.projectId,
        title: `${run.title} — evaluate E${exp.seq}`.slice(0, 120),
        providerInstanceId: model.providerInstanceId,
        model: model.model,
        options: model.options,
        message: reviewerPrompt(run, exp, best, metricLine),
        clientRequestId: `ar-${exp.id}-review-${exp.commitSha?.slice(0, 12)}`,
        workspace: { kind: "existing_worktree", worktreePath: exp.worktreePath! },
        runtimeMode: run.permissionMode,
      });
      this.store.updateExperiment(exp.id, { reviewThreadId: res.threadId, reviewThreadLink: res.link });
      this.store.event(run.id, "review", `E${exp.seq} beats the best; ${AGENT_NAMES[reviewer]} (evaluator) is checking it is real and allowed.`, exp.id);
    } catch (err) {
      this.store.updateExperiment(exp.id, { status: "eval_queued" });
      this.setStatus(run, "needs_attention", `Could not start the evaluator for E${exp.seq}: ${(err as Error).message}`);
    }
  }

  private async afterReview(run: ResearchRun, exp: Experiment, text: string) {
    const verdict = parseReview(text);
    this.store.updateExperiment(exp.id, { review: text || null, reviewVerdict: verdict?.verdict ?? null, awaitingInput: false });
    const fresh = this.store.experiment(exp.id)!;
    if (!verdict) return this.decide(run, fresh, "inconclusive", "The evaluator agent gave no readable verdict, so the improvement was not accepted.", false);
    if (verdict.verdict === "invalid") return this.decide(run, fresh, "invalid", `Rejected by the evaluator: ${verdict.concerns.join("; ") || "no reason given"}`, false);
    const best = this.store.experiment(run.bestId!)!;
    return this.decide(run, fresh, "keep", `Improves on E${best.seq}; evaluator found it valid${verdict.concerns.length ? ` (notes: ${verdict.concerns.join("; ")})` : ""}.`, true);
  }

  // ================================================================ decisions
  private async decide(run: ResearchRun, exp: Experiment, decision: Decision, reason: string, candidateBest: boolean) {
    let finalDecision = decision;
    let finalReason = reason;
    if (candidateBest && decision === "keep") {
      // Other experiments may have raised the bar while this one was being checked.
      const best = this.store.experiment(this.run(run.id).bestId!)!;
      const beatsBest =
        run.eval.kind === "human" ||
        best.id === exp.parentId ||
        compare(run.eval.direction, this.summaryOf(exp), { metric: best.metric, spread: best.metricSpread ?? 0, passed: best.passed ?? true, samples: 1, error: null }, run.eval.minImprovement).verdict === "better";
      if (beatsBest) {
        this.store.updateRun(run.id, { bestId: exp.id });
        this.store.event(run.id, "best", `New best: E${exp.seq} (${run.eval.metricName} ${fmt(exp.metric ?? this.summaryOf(exp).metric)}).`, exp.id);
      } else if (best.id !== exp.id) {
        finalDecision = "discard";
        finalReason = `${reason} But E${best.seq}, finished meanwhile, is better still.`;
      }
    }
    this.store.updateExperiment(exp.id, { status: "done", decision: finalDecision, decisionReason: finalReason, finishedAt: new Date().toISOString(), awaitingInput: false });
    this.store.event(run.id, "decision", `E${exp.seq} ${finalDecision.toUpperCase()}: ${finalReason}`, exp.id);
    // The commit stays on the experiment's branch; the worktree is no longer needed.
    if (exp.worktreePath && fs.existsSync(exp.worktreePath)) await removeOwnedWorktree(run.repoPath, exp.worktreePath).catch(() => {});
  }

  private async cancel(run: ResearchRun, exp: Experiment, reason: string) {
    this.store.updateExperiment(exp.id, { status: "cancelled", decisionReason: reason, finishedAt: new Date().toISOString(), awaitingInput: false });
    if (exp.worktreePath && fs.existsSync(exp.worktreePath)) await removeOwnedWorktree(run.repoPath, exp.worktreePath).catch(() => {});
  }

  private async finishStopping(run: ResearchRun) {
    const exps = this.store.experiments(run.id);
    const waiting = exps.filter((e) => ["implementing", "reviewing", "evaluating"].includes(e.status));
    for (const e of waiting) if (e.status === "implementing" && !e.threadId) await this.cancel(run, e, "Run stopped");
    if (this.store.experiments(run.id).some((e) => ["implementing", "reviewing", "evaluating"].includes(e.status))) return;
    for (const e of this.store.experiments(run.id, "status='eval_queued'")) await this.cancel(run, e, "Run stopped");
    await this.cleanupWorktrees(run);
    this.setStatus(run, "stopped", "Stopped. Every agent of this run has stopped; history and branches are kept. Resume continues from the records.");
  }

  /** Remove every worktree this run created (branches, and so every commit, stay). */
  private async cleanupWorktrees(run: ResearchRun) {
    const dir = path.join(this.runDir(run), "wt");
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) await removeOwnedWorktree(run.repoPath, path.join(dir, name)).catch(() => {});
  }

  // ================================================================ view
  view(runId: string): ResearchView {
    const run = this.run(runId);
    const experiments = this.store.experiments(runId);
    const evals = this.store.evals(runId);
    const baseline = run.baselineId ? experiments.find((e) => e.id === run.baselineId) : null;
    const best = run.bestId ? experiments.find((e) => e.id === run.bestId) : null;
    const started = experiments.filter((e) => e.kind === "experiment" && e.startedAt).length;
    const elapsed = run.activeMs + (run.resumedAt && ["running", "finishing", "baseline"].includes(run.status) ? Date.now() - Date.parse(run.resumedAt) : 0);
    const activeAgents: ResearchView["summary"]["activeAgents"] = [];
    if (run.researcherAsk) activeAgents.push({ kind: run.roles.researcher, role: "Researcher", experimentSeq: null, threadLink: run.researcherThreadLink, awaitingInput: false });
    for (const e of experiments) {
      if (e.status === "implementing" && e.agentKind) activeAgents.push({ kind: e.agentKind, role: "Implementer", experimentSeq: e.seq, threadLink: e.threadLink, awaitingInput: e.awaitingInput });
      if (e.status === "reviewing" && e.agentKind)
        activeAgents.push({ kind: run.roles.evaluator === "other" ? other(e.agentKind) : (run.roles.evaluator as AgentKind), role: "Evaluator", experimentSeq: e.seq, threadLink: e.reviewThreadLink, awaitingInput: e.awaitingInput });
    }
    return {
      run,
      experiments,
      evals,
      events: this.store.events(runId),
      summary: {
        completed: experiments.filter((e) => e.kind === "experiment" && e.decision).length,
        kept: experiments.filter((e) => e.kind === "experiment" && e.decision === "keep").length,
        running: experiments.filter((e) => ACTIVE.includes(e.status)).length,
        activeAgents,
        baselineMetric: baseline?.metric ?? null,
        bestMetric: best?.metric ?? null,
        improvementPct: improvementPct(run.eval.direction, baseline?.metric ?? null, best?.metric ?? null),
        remaining: { experiments: Math.max(0, run.limits.maxExperiments - started), minutes: Math.max(0, Math.round((run.limits.maxMinutes * 60_000 - elapsed) / 60_000)) },
        spendUsd: null,
      },
    };
  }
}

/** "+12.3% better" for ordinary changes, "75× slower"-style factors for very large ones. */
function describeChange(direction: EvalConfig["direction"], relative: number) {
  // relative > 0 is better; translate back to the ratio of the raw metric values.
  const ratio = direction === "minimize" ? 1 - relative : 1 + relative;
  if (Math.abs(relative) < 2 || ratio <= 0) return `${relative > 0 ? "+" : ""}${(relative * 100).toFixed(1)}%`;
  const factor = ratio > 1 ? ratio : 1 / ratio;
  const bigger = ratio > 1;
  return `${factor.toFixed(factor < 10 ? 1 : 0)}× ${bigger ? "higher" : "lower"} (${relative > 0 ? "better" : "worse"})`;
}

function clampInt(v: unknown, min: number, max: number, label: string) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ResearchError(`${label} must be a whole number from ${min} to ${max}.`);
  return n;
}
function clampNum(v: unknown, min: number, max: number, label: string) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new ResearchError(`${label} must be between ${min} and ${max}.`);
  return n;
}
function validLimits(l: ResearchLimits): ResearchLimits {
  return {
    maxExperiments: clampInt(l.maxExperiments, 1, 500, "Maximum experiments"),
    maxMinutes: clampInt(l.maxMinutes, 1, 7 * 24 * 60, "Maximum duration (minutes)"),
    maxConcurrency: clampInt(l.maxConcurrency, 1, 8, "Maximum concurrent experiments"),
    maxRetries: clampInt(l.maxRetries, 0, 5, "Maximum retries"),
    stagnationLimit: clampInt(l.stagnationLimit, 1, 100, "Stagnation limit"),
    maxSpendUsd: l.maxSpendUsd == null || (l.maxSpendUsd as unknown) === "" ? null : clampNum(l.maxSpendUsd, 0, 1e6, "Spending limit"),
  };
}
