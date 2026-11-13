// AutoResearch mode: start research runs and watch agents run measured experiments.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PERMISSION_LABELS, PERMISSION_MODES } from "../../shared/types";
import type { AgentKind, PermissionMode, T3Status } from "../../shared/types";
import {
  RESEARCH_STRATEGIES,
  STRATEGY_LABELS,
  type CreateResearchInput,
  type Decision,
  type Direction,
  type Experiment,
  type ResearchRun,
  type ResearchRunListItem,
  type ResearchStrategyId,
  type ResearchView,
} from "../../shared/research";
import { api } from "./api";
import { Avatar, Icon, Md, PermissionSelect, T3ApprovalPanel, T3Link, ThinkingSelect, type Waiting } from "./ui";

type Run = (fn: () => Promise<unknown>) => Promise<void>;

const NAMES: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex" };
const AGENTS: AgentKind[] = ["claude", "codex"];

const RUN_STATUS: Record<ResearchRun["status"], string> = {
  draft: "Not started",
  baseline: "Measuring baseline",
  running: "Researching",
  paused: "Paused",
  finishing: "Finishing",
  stopping: "Stopping",
  stopped: "Stopped",
  completed: "Completed",
  needs_attention: "Needs attention",
};
const RUN_STATUS_CLASS: Record<ResearchRun["status"], string> = {
  draft: "s-idle",
  baseline: "s-running",
  running: "s-running",
  paused: "s-paused",
  finishing: "s-running",
  stopping: "s-stopping",
  stopped: "s-paused",
  completed: "s-idle",
  needs_attention: "s-needs_attention",
};

const EXP_STATUS: Record<Experiment["status"], string> = {
  proposed: "Queued",
  implementing: "Implementing",
  eval_queued: "Waiting to evaluate",
  evaluating: "Evaluating",
  reviewing: "Evaluator reviewing",
  awaiting_human: "Needs your judgement",
  done: "Done",
  cancelled: "Cancelled",
};

const DECISION_LABEL: Record<Decision, string> = { keep: "Kept", discard: "Discarded", invalid: "Invalid", inconclusive: "Inconclusive" };

const STRATEGY_HINT: Record<ResearchStrategyId, string> = {
  greedy: "One experiment at a time, each refining the current best.",
  parallel: "Fill every slot with competing hypotheses from different approach families.",
  explore_exploit: "Mostly refine the best, but keep about a third of the slots for new directions.",
  failure_driven: "Study what failed and test alternative explanations for it.",
};

/** What an experiment looks like on charts and lists: a shape first, colour second. */
type Mark = "keep" | "discard" | "invalid" | "inconclusive" | "running" | "queued" | "baseline" | "cancelled";
function markOf(e: Experiment): Mark {
  if (e.kind === "baseline") return "baseline";
  if (e.decision) return e.decision;
  if (e.status === "proposed") return "queued";
  if (e.status === "cancelled") return "cancelled";
  return "running";
}
const MARK_LABEL: Record<Mark, string> = {
  keep: "Kept",
  discard: "Discarded",
  invalid: "Invalid",
  inconclusive: "Inconclusive",
  running: "Running",
  queued: "Queued",
  baseline: "Baseline",
  cancelled: "Cancelled",
};

export function Glyph({ mark, size = 10 }: { mark: Mark; size?: number }) {
  const r = size / 2;
  return (
    <svg className={`glyph m-${mark}`} width={size + 2} height={size + 2} viewBox={`-1 -1 ${size + 2} ${size + 2}`} aria-hidden="true">
      <GlyphShape mark={mark} cx={r} cy={r} r={r} />
    </svg>
  );
}

function GlyphShape({ mark, cx, cy, r }: { mark: Mark; cx: number; cy: number; r: number }) {
  if (mark === "invalid" || mark === "cancelled")
    return <path className={`gm m-${mark}`} d={`M${cx - r * 0.8},${cy - r * 0.8}L${cx + r * 0.8},${cy + r * 0.8}M${cx + r * 0.8},${cy - r * 0.8}L${cx - r * 0.8},${cy + r * 0.8}`} />;
  if (mark === "inconclusive") return <path className={`gm m-${mark}`} d={`M${cx},${cy - r}L${cx + r},${cy}L${cx},${cy + r}L${cx - r},${cy}Z`} />;
  if (mark === "baseline") return <rect className={`gm m-${mark}`} x={cx - r * 0.85} y={cy - r * 0.85} width={r * 1.7} height={r * 1.7} rx={1.5} />;
  return <circle className={`gm m-${mark}`} cx={cx} cy={cy} r={mark === "discard" || mark === "queued" ? r - 1 : r} />;
}

const fmt = (n: number | null | undefined) => (n == null ? "—" : n !== 0 && (Math.abs(n) >= 1e6 || Math.abs(n) < 1e-6) ? n.toExponential(2) : Number(n.toPrecision(4)).toString());
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const minutes = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} min`);

function useHashResearch(): [string | null, (id: string | null) => void] {
  const read = () => (location.hash.startsWith("#research=") ? location.hash.slice(10) : null);
  const [id, setId] = useState<string | null>(read);
  useEffect(() => {
    const f = () => setId(read());
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  return [id, (v) => (location.hash = v ? `research=${v}` : "research")];
}

// ================================================================== mode shell
export function ResearchMode({ status, run, modeSwitch }: { status: T3Status | null; run: Run; modeSwitch: ReactNode }) {
  const [runs, setRuns] = useState<ResearchRunListItem[]>([]);
  const [id, setId] = useHashResearch();
  const [view, setView] = useState<ResearchView | null>(null);
  const [creating, setCreating] = useState(false);

  const loadRuns = useCallback(() => api.researchRuns().then(setRuns).catch(() => {}), []);
  const load = useCallback(() => {
    if (!id) return setView(null);
    api.research(id).then(setView).catch(() => setView(null));
  }, [id]);
  useEffect(() => {
    loadRuns();
  }, [loadRuns]);
  useEffect(() => {
    load();
  }, [load]);

  const idRef = useRef(id);
  idRef.current = id;
  useEffect(() => {
    const es = new EventSource("/api/events");
    let pending: number | null = null;
    es.onmessage = (ev) => {
      const e = JSON.parse(ev.data);
      if (e.type !== "research") return;
      // Evaluations emit bursts of changes; coalesce them.
      if (pending) return;
      pending = window.setTimeout(() => {
        pending = null;
        loadRuns();
        if (idRef.current) api.research(idRef.current).then(setView).catch(() => {});
      }, 250);
    };
    return () => es.close();
  }, [loadRuns]);
  // Elapsed time and remaining budget tick even when nothing else changes.
  useEffect(() => {
    if (!view || !["running", "baseline", "finishing"].includes(view.run.status)) return;
    const t = window.setInterval(load, 15_000);
    return () => window.clearInterval(t);
  }, [view?.run.status, load]);

  return (
    <>
      <aside className="sidebar">
        {modeSwitch}
        <button className="primary block" onClick={() => setCreating(true)} disabled={status?.connection.kind !== "connected"}>
          <Icon name="plus" /> New research run
        </button>
        <nav className="room-list">
          {runs.map((r) => (
            <button
              key={r.id}
              className={`room-item ${r.id === id && !creating ? "active" : ""}`}
              aria-current={r.id === id ? "page" : undefined}
              title={r.title}
              onClick={() => {
                setCreating(false);
                setId(r.id);
              }}
            >
              <span className="room-title">{r.title}</span>
              {r.waiting?.length ? (
                <span className="room-status s-approval" title={`${r.waiting.join(", ")} waiting for you in T3`}>
                  <i className="dot" />
                  Waiting for your approval
                </span>
              ) : (
                <span className={`room-status ${RUN_STATUS_CLASS[r.status]}`}>
                  <i className="dot" />
                  {RUN_STATUS[r.status]}
                </span>
              )}
            </button>
          ))}
          {!runs.length && <p className="muted small">No research runs yet.</p>}
        </nav>
      </aside>
      <main className="main">
        {creating && status ? (
          <NewResearch
            status={status}
            onCancel={() => setCreating(false)}
            onCreate={(b, startNow) =>
              run(async () => {
                const r = await api.createResearch(b);
                if (startNow) await api.researchAction(r.id, "start");
                setCreating(false);
                await loadRuns();
                setId(r.id);
              })
            }
          />
        ) : view ? (
          <Dashboard key={view.run.id} view={view} run={run} webOrigin={status?.webOrigin ?? null} onChanged={setView} />
        ) : (
          <ResearchEmpty />
        )}
      </main>
    </>
  );
}

function ResearchEmpty() {
  return (
    <div className="empty">
      <h2>Let agents run measured experiments</h2>
      <p className="muted">
        Give an objective and an evaluation. Team Room measures a baseline, then a researcher agent proposes hypotheses, implementer agents test each one
        in its own git worktree, Team Room evaluates every result itself, and an evaluator agent checks each apparent improvement. Only measured, valid
        improvements are kept.
      </p>
      <p className="muted">
        Try it on the bundled example: run <code>npx tsx scripts/autoresearch-demo.ts</code>, add the folder it prints to T3 as a project, then choose{" "}
        <b>New research run</b> → <b>Fill in the demo</b>.
      </p>
    </div>
  );
}

// ================================================================== new run
function lines(s: string) {
  return s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function NewResearch({ status, onCancel, onCreate }: { status: T3Status; onCancel: () => void; onCreate: (b: CreateResearchInput, startNow: boolean) => void }) {
  const provider = (driver: string) => status.providers.find((p) => p.driver === driver && p.available) ?? status.providers.find((p) => p.driver === driver);
  const initialModel = (k: AgentKind) => {
    const p = provider(k === "claude" ? "claudeAgent" : "codex");
    return { providerInstanceId: p?.instanceId ?? "", model: p?.defaultModel ?? "" };
  };
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [projectId, setProjectId] = useState(status.projects[0]?.id ?? "");
  const [baseRef, setBaseRef] = useState("HEAD");
  const [evalKind, setEvalKind] = useState<"command" | "human">("command");
  const [command, setCommand] = useState("");
  const [criteria, setCriteria] = useState("");
  const [direction, setDirection] = useState<Direction>("minimize");
  const [metricName, setMetricName] = useState("metric");
  const [repeats, setRepeats] = useState(3);
  const [minImprovement, setMinImprovement] = useState(2);
  const [timeoutSec, setTimeoutSec] = useState(300);
  const [protectedPaths, setProtectedPaths] = useState("");
  const [scope, setScope] = useState("");
  const [strategy, setStrategy] = useState<ResearchStrategyId>("explore_exploit");
  const [researcher, setResearcher] = useState<AgentKind>("claude");
  const [implementers, setImplementers] = useState<AgentKind[]>(["claude", "codex"]);
  const [evaluator, setEvaluator] = useState<AgentKind | "other" | "off">("other");
  const [agentCommands, setAgentCommands] = useState(false);
  const [models, setModels] = useState<Record<AgentKind, { providerInstanceId: string; model: string; options?: Record<string, string | boolean> }>>({
    claude: initialModel("claude"),
    codex: initialModel("codex"),
  });
  const cap = status.maxPermission;
  const allowed = (m: PermissionMode) => !cap || PERMISSION_MODES.indexOf(m) <= PERMISSION_MODES.indexOf(cap);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(cap && allowed("auto-accept-edits") ? "auto-accept-edits" : "approval-required");
  const [maxExperiments, setMaxExperiments] = useState(12);
  const [maxMinutes, setMaxMinutes] = useState(120);
  const [maxConcurrency, setMaxConcurrency] = useState(2);
  const [maxRetries, setMaxRetries] = useState(1);
  const [stagnationLimit, setStagnationLimit] = useState(6);

  const demo = status.projects.find((p) => /autoresearch-demo\/?$/.test(p.workspaceRoot));
  const fillDemo = () => {
    setTitle("Faster prime-counting queries");
    setObjective("Improve the performance of answer_queries in solver.py while preserving correctness. Find the fastest correct version.");
    if (demo) setProjectId(demo.id);
    setEvalKind("command");
    setCommand('python3 "$EVAL_DIR/eval/evaluate.py"');
    setCriteria("Every answer must match the independent reference in eval/evaluate.py. Lower median time is better.");
    setDirection("minimize");
    setMetricName("seconds");
    setRepeats(3);
    setMinImprovement(5);
    setProtectedPaths("eval/");
    setScope("solver.py, *.py");
    setStrategy("parallel");
    setMaxExperiments(6);
    setMaxMinutes(45);
    setMaxConcurrency(2);
  };

  const used = new Set<AgentKind>([researcher, ...implementers, ...(evaluator === "other" ? implementers.map((k) => (k === "claude" ? "codex" : "claude") as AgentKind) : evaluator === "off" ? [] : [evaluator])]);
  const ready = objective.trim() && projectId && implementers.length && (evalKind === "human" ? criteria.trim() : command.trim()) && [...used].every((k) => models[k].model);
  const body = (): CreateResearchInput => ({
    title,
    objective,
    projectId,
    baseRef,
    allowedScope: lines(scope),
    eval: { kind: evalKind, command, criteria, direction, metricName, repeats, minImprovement: minImprovement / 100, timeoutSec, protectedPaths: lines(protectedPaths) },
    strategy,
    roles: { researcher, implementers, evaluator, agentCommands },
    models: Object.fromEntries([...used].map((k) => [k, models[k]])),
    permissionMode,
    limits: { maxExperiments, maxMinutes, maxConcurrency, maxRetries, stagnationLimit, maxSpendUsd: null },
  });

  return (
    <form
      className="card new-room research-form"
      onSubmit={(e) => {
        e.preventDefault();
        onCreate(body(), true);
      }}
    >
      <div className="form-head">
        <h2>New research run</h2>
        <span className="spacer" />
        <button type="button" onClick={fillDemo} title={demo ? `Use ${demo.workspaceRoot}` : "Set up the demo with scripts/autoresearch-demo.ts and add it to T3 first"}>
          Fill in the demo
        </button>
      </div>
      <label>
        Research objective
        <textarea rows={3} required value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="e.g. Improve the performance of this Python implementation while preserving correctness." />
      </label>
      <div className="row">
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short name (optional)" />
        </label>
        <label>
          Repository (T3 project)
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} required>
            {!status.projects.length && <option value="">No T3 projects — add one in T3</option>}
            {status.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title} — {p.workspaceRoot}
              </option>
            ))}
          </select>
        </label>
        <label className="narrow">
          Baseline ref
          <input value={baseRef} onChange={(e) => setBaseRef(e.target.value)} />
        </label>
      </div>

      <fieldset className="picker">
        <legend>Evaluation</legend>
        <div className="seg" role="radiogroup" aria-label="Evaluation kind">
          <button type="button" role="radio" aria-checked={evalKind === "command"} className={evalKind === "command" ? "on" : ""} onClick={() => setEvalKind("command")}>
            Automated (evaluation command)
          </button>
          <button type="button" role="radio" aria-checked={evalKind === "human"} className={evalKind === "human" ? "on" : ""} onClick={() => setEvalKind("human")}>
            Assisted (you judge each result)
          </button>
        </div>
        {evalKind === "command" ? (
          <>
            <label>
              Evaluation command
              <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder='python3 "$EVAL_DIR/eval/evaluate.py"' className="mono" />
              <span className="muted small hint">
                Runs in each experiment's checkout. <code>$EVAL_DIR</code> is a fresh copy of the protected paths taken from the baseline commit, so experiments
                can't change the check. It must print a JSON line like <code>{'{"metric": 0.42, "pass": true}'}</code>; a failing <code>pass</code> or exit
                code makes the experiment invalid. Team Room measures the baseline first and stops if the result isn't measurable.
              </span>
            </label>
            <div className="row">
              <label>
                Protected paths
                <input value={protectedPaths} onChange={(e) => setProtectedPaths(e.target.value)} placeholder="eval/, tests/" />
              </label>
              <label>
                Direction
                <select value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
                  <option value="minimize">Minimize</option>
                  <option value="maximize">Maximize</option>
                  <option value="pass_fail">Pass / fail</option>
                </select>
              </label>
              <label className="narrow">
                Metric name
                <input value={metricName} onChange={(e) => setMetricName(e.target.value)} />
              </label>
            </div>
            <div className="row">
              <label>
                Runs per evaluation
                <input type="number" min={1} max={20} value={repeats} onChange={(e) => setRepeats(Number(e.target.value))} />
              </label>
              <label>
                Minimum improvement (%)
                <input type="number" min={0} max={1000} step={0.5} value={minImprovement} onChange={(e) => setMinImprovement(Number(e.target.value))} />
              </label>
              <label>
                Evaluation timeout (s)
                <input type="number" min={5} max={7200} value={timeoutSec} onChange={(e) => setTimeoutSec(Number(e.target.value))} />
              </label>
            </div>
          </>
        ) : (
          <label>
            Direction
            <select value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
              <option value="maximize">Better is what meets the criteria best</option>
              <option value="pass_fail">Pass / fail against the criteria</option>
            </select>
          </label>
        )}
        <label>
          Acceptance criteria {evalKind === "human" ? "(you judge against these)" : "(shown to every agent)"}
          <textarea rows={2} value={criteria} onChange={(e) => setCriteria(e.target.value)} placeholder="What must stay true, and what counts as better" />
        </label>
      </fieldset>

      <label>
        Allowed modification scope
        <input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="src/, *.py (empty = anything except protected paths)" className="mono" />
      </label>

      <fieldset className="picker">
        <legend>Agents</legend>
        <div className="row">
          <label>
            Researcher
            <select value={researcher} onChange={(e) => setResearcher(e.target.value as AgentKind)}>
              {AGENTS.map((k) => (
                <option key={k} value={k}>
                  {NAMES[k]}
                </option>
              ))}
            </select>
          </label>
          <div className="checks">
            <span>Implementers</span>
            {AGENTS.map((k) => (
              <label key={k} className="inline">
                <input type="checkbox" checked={implementers.includes(k)} onChange={(e) => setImplementers(e.target.checked ? [...implementers, k].sort() : implementers.filter((x) => x !== k))} />
                {NAMES[k]}
              </label>
            ))}
          </div>
          <label>
            Evaluator
            <select value={evaluator} onChange={(e) => setEvaluator(e.target.value as any)}>
              <option value="other">The other agent (cross-check)</option>
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
              <option value="off">Off (measurement only)</option>
            </select>
          </label>
        </div>
        <div className="row">
          {AGENTS.filter((k) => used.has(k)).map((k) => {
            const p = status.providers.find((x) => x.instanceId === models[k].providerInstanceId);
            return (
              <label key={k}>
                {NAMES[k]} model
                <select value={models[k].model} onChange={(e) => setModels({ ...models, [k]: { ...models[k], model: e.target.value, options: {} } })}>
                  {(p?.models ?? []).map((m) => (
                    <option key={m.slug} value={m.slug}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <ThinkingSelect
                  compact
                  providers={status.providers}
                  providerInstanceId={models[k].providerInstanceId}
                  model={models[k].model}
                  options={models[k].options ?? {}}
                  onChange={(o) => setModels({ ...models, [k]: { ...models[k], options: o } })}
                />
              </label>
            );
          })}
          <label>
            Agent permissions
            <PermissionSelect value={permissionMode} onChange={setPermissionMode} cap={cap} />
          </label>
        </div>
        <label className="inline check-line">
          <input type="checkbox" checked={agentCommands} onChange={(e) => setAgentCommands(e.target.checked)} />
          Let agents run commands
        </label>
        <span className="muted small">
          {agentCommands
            ? "Agents may run code and checks themselves. Below Full access, every command waits for your approval in the dashboard."
            : "Agents only read and edit files; Team Room runs the evaluation and sends errors back. With Auto-accept edits this needs no approvals."}
        </span>
      </fieldset>

      <div className="row">
        <label>
          Strategy
          <select value={strategy} onChange={(e) => setStrategy(e.target.value as ResearchStrategyId)}>
            {RESEARCH_STRATEGIES.map((s) => (
              <option key={s} value={s}>
                {STRATEGY_LABELS[s]}
              </option>
            ))}
          </select>
          <span className="muted small hint">{STRATEGY_HINT[strategy]}</span>
        </label>
      </div>

      <fieldset className="picker">
        <legend>Limits</legend>
        <div className="row limits-row">
          <label>
            Max experiments
            <input type="number" min={1} max={500} value={maxExperiments} onChange={(e) => setMaxExperiments(Number(e.target.value))} />
          </label>
          <label>
            Max duration (min)
            <input type="number" min={1} value={maxMinutes} onChange={(e) => setMaxMinutes(Number(e.target.value))} />
          </label>
          <label>
            At a time
            <input type="number" min={1} max={8} value={maxConcurrency} onChange={(e) => setMaxConcurrency(Number(e.target.value))} />
          </label>
          <label>
            Retries
            <input type="number" min={0} max={5} value={maxRetries} onChange={(e) => setMaxRetries(Number(e.target.value))} />
          </label>
          <label>
            Stop after no gain in
            <input type="number" min={1} max={100} value={stagnationLimit} onChange={(e) => setStagnationLimit(Number(e.target.value))} />
          </label>
          <label>
            Spending cap
            <input disabled value="" placeholder="not reported" />
          </label>
        </div>
        <span className="muted small">T3 0.1.7 does not report usage costs, so a spending cap cannot be enforced; experiment, time and concurrency limits are.</span>
      </fieldset>

      <div className="actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" disabled={!ready} onClick={() => onCreate(body(), false)}>
          Save as draft
        </button>
        <button className="primary" type="submit" disabled={!ready}>
          Create and start
        </button>
      </div>
    </form>
  );
}

// ================================================================== dashboard
function Dashboard({ view, run, webOrigin, onChanged }: { view: ResearchView; run: Run; webOrigin: string | null; onChanged: (v: ResearchView) => void }) {
  const { run: r, experiments, summary } = view;
  const [tab, setTab] = useState<"experiments" | "activity" | "report">("experiments");
  const [selected, setSelected] = useState<string | null>(null);
  const [compare, setCompare] = useState<string[]>([]);
  const [reviewing, setReviewing] = useState<Waiting | null>(null);
  const act = (fn: () => Promise<ResearchView>) => run(async () => onChanged(await fn()));
  const sel = selected ? experiments.find((e) => e.id === selected) ?? null : null;
  const waiting: Waiting[] = summary.activeAgents
    .filter((a) => a.awaitingInput)
    .map((a) => ({ id: `${a.role}-${a.experimentSeq}`, name: `${NAMES[a.kind]} (${a.role.toLowerCase()}${a.experimentSeq != null ? `, E${a.experimentSeq}` : ""})`, link: a.threadLink, threadId: null }));
  const stillWaiting = reviewing ? waiting.some((w) => w.id === reviewing.id) : false;

  return (
    <div className="room research">
      <section className="center">
        <div className="room-header">
          <div className="title-row">
            <h1>{r.title}</h1>
            {waiting.length ? (
              <span className="status-pill s-approval" title={`Run status: ${RUN_STATUS[r.status]}`}>
                <i className="dot" />
                Waiting for your approval
              </span>
            ) : (
              <span className={`status-pill ${RUN_STATUS_CLASS[r.status]}`}>
                <i className="dot" />
                {RUN_STATUS[r.status]}
              </span>
            )}
            <span className="spacer" />
            <RunControls view={view} act={act} />
          </div>
          <div className="room-meta">
            <span>{r.projectTitle ?? r.repoPath}</span>
            <span>{STRATEGY_LABELS[r.strategy]}</span>
            <span>{r.eval.kind === "command" ? `${r.eval.direction === "pass_fail" ? "Pass/fail" : r.eval.direction === "minimize" ? "Minimize" : "Maximize"} ${r.eval.metricName}` : "Assisted evaluation"}</span>
            <span>{PERMISSION_LABELS[r.permissionMode]}</span>
          </div>
          {r.statusDetail && <div className={`status-detail ${RUN_STATUS_CLASS[r.status]}`}>{r.statusDetail}</div>}
        </div>
        {waiting.length > 0 && (
          <div className="approval-banner" role="status">
            <span>
              <b>{waiting.map((w) => w.name).join(", ")}</b> {waiting.length === 1 ? "is" : "are"} waiting for your approval in T3.
            </span>
            <div className="approval-links">
              {waiting.map((w) =>
                w.link ? (
                  <span key={w.id} className="approval-pair">
                    <T3Link className="button primary" link={w.link}>
                      Open {w.name} in T3 <Icon name="external" />
                    </T3Link>
                    {webOrigin && (
                      <button onClick={() => setReviewing(w)} title="Show T3's approval screen inside Team Room">
                        Review here
                      </button>
                    )}
                  </span>
                ) : null,
              )}
            </div>
          </div>
        )}
        <div className="research-scroll">
          <Overview view={view} />
          <div className="tabs" role="tablist">
            {(["experiments", "activity", "report"] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
                {t === "experiments" ? `Experiments (${experiments.filter((e) => e.kind === "experiment").length})` : t === "activity" ? "Activity" : "Report"}
              </button>
            ))}
          </div>
          {tab === "experiments" && (
            <>
              <div className="viz-grid">
                <section className="viz-card">
                  <h3>Experiment graph</h3>
                  <ExperimentGraph view={view} selected={selected} onSelect={setSelected} />
                </section>
                <section className="viz-card">
                  <h3>
                    {r.eval.metricName} over time <span className="muted">· {r.eval.direction === "minimize" ? "lower is better" : r.eval.direction === "maximize" ? "higher is better" : "pass / fail"}</span>
                  </h3>
                  <PerformanceChart view={view} selected={selected} onSelect={setSelected} />
                </section>
              </div>
              {compare.length >= 2 && <Comparison view={view} ids={compare} onClear={() => setCompare([])} />}
              <ExperimentTable view={view} selected={selected} onSelect={setSelected} compare={compare} setCompare={setCompare} />
            </>
          )}
          {tab === "activity" && <Activity view={view} onSelect={setSelected} />}
          {tab === "report" && <Report view={view} />}
        </div>
      </section>
      <aside className="panel">
        <AgentsCard view={view} />
        <BudgetCard view={view} act={act} />
        <SuggestCard view={view} act={act} />
      </aside>
      {sel && <ExperimentDrawer view={view} exp={sel} onClose={() => setSelected(null)} act={act} onSelect={setSelected} />}
      {reviewing && webOrigin && <T3ApprovalPanel item={reviewing} webOrigin={webOrigin} resolved={!stillWaiting} onClose={() => setReviewing(null)} />}
    </div>
  );
}

function RunControls({ view, act }: { view: ResearchView; act: (fn: () => Promise<ResearchView>) => void }) {
  const r = view.run;
  const s = r.status;
  const id = r.id;
  const baselineOk = view.experiments.some((e) => e.id === r.baselineId && e.decision === "keep");
  return (
    <div className="btn-row">
      {(s === "draft" || (s === "needs_attention" && !baselineOk)) && (
        <button className="primary" onClick={() => act(() => api.researchAction(id, "start"))}>
          {s === "draft" ? "Start" : "Measure baseline again"}
        </button>
      )}
      {["running", "baseline", "finishing"].includes(s) && <button onClick={() => act(() => api.researchAction(id, "pause"))}>Pause</button>}
      {(s === "paused" || (s === "needs_attention" && baselineOk) || ((s === "stopped" || s === "completed") && baselineOk)) && (
        <button className="primary" onClick={() => act(() => api.researchAction(id, "resume"))}>
          {s === "stopped" || s === "completed" ? "Resume research" : "Resume"}
        </button>
      )}
      {!["draft", "stopped", "completed", "stopping"].includes(s) && (
        <button className="danger" onClick={() => confirm("Stop this run? Agents are interrupted and unfinished experiments are cancelled. History and results are kept.") && act(() => api.researchAction(id, "stop"))}>
          Stop
        </button>
      )}
    </div>
  );
}

function Overview({ view }: { view: ResearchView }) {
  const { run: r, summary: s, experiments } = view;
  const best = experiments.find((e) => e.id === r.bestId);
  const elapsed = r.activeMs + (r.resumedAt && ["running", "finishing", "baseline"].includes(r.status) ? Date.now() - Date.parse(r.resumedAt) : 0);
  return (
    <section className="overview">
      <p className="objective">{r.objective}</p>
      <div className="stats">
        <div className="stat stat-best">
          <span className="stat-label">Best result</span>
          <span className="stat-value">{r.eval.kind === "human" ? (best && best.kind === "experiment" ? `E${best.seq}` : "—") : fmt(s.bestMetric)}</span>
          <span className="stat-sub">
            {best ? (best.kind === "baseline" ? "the baseline, so far" : `E${best.seq} · ${best.title}`) : "not measured yet"}
            {s.improvementPct != null && s.improvementPct !== 0 && <b className={s.improvementPct > 0 ? "up" : "down"}> · {s.improvementPct > 0 ? `${s.improvementPct}% better` : `${-s.improvementPct}% worse`}</b>}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Baseline</span>
          <span className="stat-value">{fmt(s.baselineMetric)}</span>
          <span className="stat-sub">{r.baseSha ? `${r.baseRef} · ${r.baseSha.slice(0, 8)}` : r.baseRef}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Experiments</span>
          <span className="stat-value">
            {s.completed}
            <span className="of"> / {r.limits.maxExperiments}</span>
          </span>
          <span className="stat-sub">
            {s.kept} kept · {s.running} running
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Remaining</span>
          <span className="stat-value">{s.remaining.experiments}</span>
          <span className="stat-sub">
            experiments · {s.remaining.minutes} min left · {minutes(elapsed)} used
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Active agents</span>
          <span className="stat-agents">
            {s.activeAgents.length ? (
              s.activeAgents.map((a, i) => (
                <span key={i} className="agent-chip" title={`${NAMES[a.kind]} — ${a.role}${a.experimentSeq != null ? ` for E${a.experimentSeq}` : ""}`}>
                  <Avatar who={a.kind} />
                  <span>
                    {a.role}
                    {a.experimentSeq != null ? ` E${a.experimentSeq}` : ""}
                  </span>
                </span>
              ))
            ) : (
              <span className="muted">none</span>
            )}
          </span>
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ graph
function ExperimentGraph({ view, selected, onSelect }: { view: ResearchView; selected: string | null; onSelect: (id: string) => void }) {
  const { experiments, run: r } = view;
  const nodes = experiments.filter((e) => e.kind === "baseline" ? e.id === r.baselineId : e.startedAt || e.status === "proposed");
  // Pre-order rows, depth columns: siblings (competing branches) share a column.
  const kids = new Map<string | null, Experiment[]>();
  for (const e of nodes) kids.set(e.parentId, [...(kids.get(e.parentId) ?? []), e]);
  const placed: { e: Experiment; depth: number; row: number }[] = [];
  const visit = (e: Experiment, depth: number) => {
    placed.push({ e, depth, row: placed.length });
    for (const c of kids.get(e.id) ?? []) visit(c, depth + 1);
  };
  const root = nodes.find((e) => e.id === r.baselineId);
  if (!root) return <p className="muted small pad">The graph appears once the baseline is measured.</p>;
  visit(root, 0);
  // Indented tree: each node has its own row, children step right by COL.
  const COL = 30;
  const ROW = 32;
  const W = 168;
  const H = 26;
  const pos = new Map(placed.map((p) => [p.e.id, { x: 8 + p.depth * COL, y: 8 + p.row * ROW }]));
  const width = 16 + Math.max(...placed.map((p) => p.depth)) * COL + W;
  const height = 16 + placed.length * ROW - (ROW - H);
  return (
    <div className="graph-wrap">
      <svg className="exp-graph" width={width} height={height} role="group" aria-label="Experiment graph">
        {placed
          .filter((p) => p.e.parentId && pos.has(p.e.parentId))
          .map((p) => {
            const a = pos.get(p.e.parentId!)!;
            const b = pos.get(p.e.id)!;
            const x1 = a.x + 14;
            const y1 = a.y + H;
            return <path key={`edge-${p.e.id}`} className={`edge ${p.e.decision === "keep" ? "edge-keep" : ""}`} d={`M${x1},${y1} V${b.y + H / 2 - 6} Q${x1},${b.y + H / 2} ${x1 + 6},${b.y + H / 2} H${b.x}`} />;
          })}
        {placed.map(({ e }) => {
          const p = pos.get(e.id)!;
          const m = markOf(e);
          const isBest = e.id === r.bestId;
          return (
            <g
              key={e.id}
              className={`node m-${m} ${isBest ? "best" : ""} ${selected === e.id ? "selected" : ""} ${e.rejected ? "rejected" : ""}`}
              transform={`translate(${p.x},${p.y})`}
              tabIndex={0}
              role="button"
              aria-label={`E${e.seq} ${e.title}: ${MARK_LABEL[m]}${isBest ? ", current best" : ""}`}
              onClick={() => onSelect(e.id)}
              onKeyDown={(ev) => (ev.key === "Enter" || ev.key === " ") && onSelect(e.id)}
            >
              <title>{`E${e.seq} ${e.title}\n${MARK_LABEL[m]}${e.metric != null ? ` · ${fmt(e.metric)}` : ""}${e.decisionReason ? `\n${e.decisionReason}` : ""}`}</title>
              <rect className="node-box" width={W} height={H} rx={6} />
              <GlyphShape mark={m} cx={13} cy={H / 2} r={4.5} />
              <text x={24} y={H / 2 + 4} className="node-id">
                E{e.seq}
              </text>
              <text x={48} y={H / 2 + 4} className="node-text">
                {e.kind === "baseline" ? "baseline" : clip(e.title, 17)}
              </text>
              {e.pinned && <circle className="pin-dot" cx={W - 6} cy={6} r={3} />}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ------------------------------------------------------------------ chart
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(480);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) => setW(Math.max(260, Math.floor(entry.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceTicks(lo: number, hi: number, n = 5) {
  const span = hi - lo || Math.abs(hi) || 1;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

function PerformanceChart({ view, selected, onSelect }: { view: ResearchView; selected: string | null; onSelect: (id: string) => void }) {
  const { run: r, experiments } = view;
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const t0 = Date.parse(r.startedAt ?? r.createdAt);
  const pts = experiments
    .filter((e) => e.finishedAt && (e.decision || e.kind === "baseline") && e.status !== "cancelled")
    .map((e) => ({ e, t: (Date.parse(e.finishedAt!) - t0) / 60_000, v: e.metric }))
    .sort((a, b) => a.t - b.t);
  const measured = pts.filter((p) => p.v != null && p.e.decision !== "invalid") as { e: Experiment; t: number; v: number }[];
  const unmeasured = pts.filter((p) => p.v == null || p.e.decision === "invalid");
  if (r.eval.kind === "human" || !measured.length)
    return (
      <div ref={ref} className="chart-empty muted small">
        {r.eval.kind === "human" ? "Assisted runs have no numeric metric to plot; see the table." : "Results appear here as experiments are evaluated."}
      </div>
    );
  const better = (a: number, b: number) => (r.eval.direction === "maximize" ? a > b : a < b);
  // Best so far: the baseline, then every kept result that beat it.
  const steps: { t: number; v: number }[] = [];
  for (const p of measured) if ((p.e.kind === "baseline" || p.e.decision === "keep") && (!steps.length || better(p.v, steps[steps.length - 1].v))) steps.push({ t: p.t, v: p.v });
  const nowT = Math.max(...pts.map((p) => p.t), (Date.now() - t0) / 60_000 * (["running", "finishing"].includes(r.status) ? 1 : 0));
  const values = measured.map((p) => p.v);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const useLog = lo > 0 && hi / lo > 20;
  const PAD = { l: 56, r: 14, t: 10, b: 30 };
  const stripH = unmeasured.length ? 30 : 0;
  const H = 230;
  const plotH = H - PAD.t - PAD.b - stripH;
  const x = (t: number) => PAD.l + (t / (nowT || 1)) * (width - PAD.l - PAD.r);
  let y: (v: number) => number;
  let ticks: number[];
  if (useLog) {
    const a = Math.floor(Math.log10(lo));
    const b = Math.ceil(Math.log10(hi));
    y = (v) => PAD.t + (1 - (Math.log10(v) - a) / (b - a || 1)) * plotH;
    ticks = [];
    for (let k = a; k <= b; k++) ticks.push(10 ** k);
  } else {
    const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.1 || 1;
    const dlo = Math.max(r.eval.direction === "minimize" ? 0 : -Infinity, lo - pad);
    const dhi = hi + pad;
    y = (v) => PAD.t + (1 - (v - dlo) / (dhi - dlo || 1)) * plotH;
    ticks = niceTicks(dlo, dhi, 4);
  }
  const xticks = niceTicks(0, nowT || 1, Math.max(2, Math.floor(width / 110)));
  const path = steps.length
    ? steps.map((s, i) => `${i === 0 ? "M" : `H${x(s.t)} V`}${i === 0 ? `${x(s.t)},${y(s.v)}` : y(s.v)}`).join(" ") + ` H${x(nowT)}`
    : "";
  const baseline = measured.find((p) => p.e.kind === "baseline");
  const hov = hover ? pts.find((p) => p.e.id === hover) : null;
  const hx = hov ? x(hov.t) : 0;
  const hy = hov ? (hov.v != null && hov.e.decision !== "invalid" ? y(hov.v) : H - PAD.b - stripH / 2 + 4) : 0;
  const legend: Mark[] = ["baseline", "keep", "discard", "inconclusive", "invalid"];
  return (
    <div ref={ref} className="chart">
      <div className="legend" aria-hidden="true">
        <span>
          <svg width="18" height="10">
            <path d="M1,8 H8 V2 H17" className="best-line" />
          </svg>
          Best so far
        </span>
        {legend.map((m) => (
          <span key={m}>
            <Glyph mark={m} /> {MARK_LABEL[m]}
          </span>
        ))}
        {useLog && <span className="legend-note">log scale</span>}
      </div>
      <svg width={width} height={H} role="img" aria-label={`${r.eval.metricName} of each experiment over time, with the best result so far. The experiment table lists the same values.`}>
        {ticks.map((v) => (
          <g key={`y${v}`}>
            <line className="grid" x1={PAD.l} x2={width - PAD.r} y1={y(v)} y2={y(v)} />
            <text className="tick" x={PAD.l - 6} y={y(v) + 4} textAnchor="end">
              {fmt(v)}
            </text>
          </g>
        ))}
        {xticks.map((t) => (
          <text key={`x${t}`} className="tick" x={x(t)} y={H - 8} textAnchor="middle">
            {t === 0 ? "0" : `${t}m`}
          </text>
        ))}
        {baseline && <line className="baseline-ref" x1={PAD.l} x2={width - PAD.r} y1={y(baseline.v)} y2={y(baseline.v)} />}
        {unmeasured.length > 0 && (
          <>
            <line className="grid" x1={PAD.l} x2={width - PAD.r} y1={H - PAD.b - stripH + 2} y2={H - PAD.b - stripH + 2} />
            <text className="tick" x={PAD.l - 6} y={H - PAD.b - stripH / 2 + 8} textAnchor="end">
              invalid
            </text>
          </>
        )}
        <path className="best-line" d={path} />
        {pts.map((p) => {
          const m = markOf(p.e);
          const px = x(p.t);
          const py = p.v != null && p.e.decision !== "invalid" ? y(p.v) : H - PAD.b - stripH / 2 + 4;
          return (
            <g
              key={p.e.id}
              className={`pt ${selected === p.e.id ? "selected" : ""}`}
              onMouseEnter={() => setHover(p.e.id)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onSelect(p.e.id)}
            >
              <circle cx={px} cy={py} r={12} className="hit" />
              <circle cx={px} cy={py} r={7} className="ring" />
              <GlyphShape mark={m} cx={px} cy={py} r={5} />
            </g>
          );
        })}
      </svg>
      {hov && (
        <div className="tooltip" style={{ left: Math.min(hx + 12, width - 200), top: Math.max(0, hy - 20) + 28 }}>
          <b>E{hov.e.seq}</b> {hov.e.kind === "baseline" ? "Baseline" : hov.e.title}
          <div>
            {r.eval.metricName}: <b>{fmt(hov.v)}</b> · {MARK_LABEL[markOf(hov.e)]}
          </div>
          <div className="muted">{hov.t.toFixed(1)} min in</div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ table & comparison
type SortKey = "seq" | "metric" | "decision" | "agent" | "finished";

function ExperimentTable({ view, selected, onSelect, compare, setCompare }: { view: ResearchView; selected: string | null; onSelect: (id: string) => void; compare: string[]; setCompare: (ids: string[]) => void }) {
  const { experiments, run: r } = view;
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "seq", dir: -1 });
  const base = experiments.find((e) => e.id === r.baselineId);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = experiments.filter((e) => !needle || `e${e.seq} ${e.title} ${e.hypothesis} ${e.approach} ${e.decisionReason ?? ""}`.toLowerCase().includes(needle));
    const val = (e: Experiment): string | number => {
      if (sort.key === "metric") return e.metric ?? (sort.dir === 1 ? Infinity : -Infinity);
      if (sort.key === "decision") return e.decision ?? e.status;
      if (sort.key === "agent") return e.agentKind ?? "";
      if (sort.key === "finished") return e.finishedAt ?? "";
      return e.seq;
    };
    return [...list].sort((a, b) => (val(a) < val(b) ? -sort.dir : val(a) > val(b) ? sort.dir : 0));
  }, [experiments, q, sort]);
  const head = (key: SortKey, label: string, cls = "") => (
    <th className={cls} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button className="th-sort" onClick={() => setSort({ key, dir: sort.key === key ? ((-sort.dir) as 1 | -1) : 1 })}>
        {label}
        {sort.key === key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );
  const delta = (e: Experiment) => {
    if (e.metric == null || base?.metric == null || e.kind === "baseline" || r.eval.direction === "pass_fail") return null;
    const rel = r.eval.direction === "minimize" ? (base.metric - e.metric) / base.metric : (e.metric - base.metric) / base.metric;
    return Math.round(rel * 1000) / 10;
  };
  return (
    <section className="viz-card table-card">
      <div className="table-head">
        <h3>History</h3>
        <span className="spacer" />
        <input className="search" type="search" placeholder="Search hypotheses, approaches, reasons" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search experiments" />
      </div>
      <div className="table-scroll">
        <table className="exp-table">
          <thead>
            <tr>
              <th className="cmp" title="Select to compare">
                <span className="sr-only">Compare</span>
              </th>
              {head("seq", "Exp")}
              <th>Hypothesis</th>
              {head("agent", "Agent")}
              {head("metric", r.eval.metricName, "num")}
              <th className="num">vs baseline</th>
              {head("decision", "Outcome")}
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => {
              const d = delta(e);
              const m = markOf(e);
              return (
                <tr key={e.id} className={`${selected === e.id ? "selected" : ""} ${e.id === r.bestId ? "best-row" : ""}`} onClick={() => onSelect(e.id)}>
                  <td className="cmp" onClick={(ev) => ev.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Compare E${e.seq}`}
                      checked={compare.includes(e.id)}
                      onChange={(ev) => setCompare(ev.target.checked ? [...compare, e.id] : compare.filter((x) => x !== e.id))}
                    />
                  </td>
                  <td className="num-id">
                    E{e.seq}
                    {e.pinned && <span className="pin-tag">pinned</span>}
                  </td>
                  <td className="hyp">
                    <span className="hyp-title">
                      {e.title}
                      {e.id === r.bestId && <span className="best-tag">best</span>}
                    </span>
                    <span className="muted small">
                      {e.approach && `${e.approach} · `}
                      {e.parentId ? `from E${experiments.find((p) => p.id === e.parentId)?.seq}` : "start"}
                      {e.kind === "experiment" && e.source === "human" ? " · your suggestion" : ""}
                    </span>
                  </td>
                  <td>{e.agentKind ? <Avatar who={e.agentKind} /> : <span className="muted">—</span>}</td>
                  <td className="num">{fmt(e.metric)}</td>
                  <td className={`num ${d != null && d > 0 ? "up" : d != null && d < 0 ? "down" : ""}`}>{d == null ? "—" : `${d > 0 ? "+" : ""}${d}%`}</td>
                  <td>
                    <span className="outcome">
                      <Glyph mark={m} /> {e.decision ? DECISION_LABEL[e.decision] : EXP_STATUS[e.status]}
                    </span>
                    {e.awaitingInput && <span className="chip small s-needs_attention">approval</span>}
                  </td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr>
                <td colSpan={7} className="muted small pad">
                  {q ? "Nothing matches." : "No experiments yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Comparison({ view, ids, onClear }: { view: ResearchView; ids: string[]; onClear: () => void }) {
  const exps = ids.map((id) => view.experiments.find((e) => e.id === id)).filter(Boolean) as Experiment[];
  const keys = [...new Set(exps.flatMap((e) => Object.keys(e.metrics)))];
  const row = (label: string, f: (e: Experiment) => ReactNode) => (
    <tr>
      <th>{label}</th>
      {exps.map((e) => (
        <td key={e.id}>{f(e)}</td>
      ))}
    </tr>
  );
  return (
    <section className="viz-card">
      <div className="table-head">
        <h3>Comparing {exps.map((e) => `E${e.seq}`).join(", ")}</h3>
        <span className="spacer" />
        <button className="link small" onClick={onClear}>
          Clear
        </button>
      </div>
      <div className="table-scroll">
        <table className="exp-table compare">
          <tbody>
            {row("Hypothesis", (e) => e.title)}
            {row(view.run.eval.metricName, (e) => <b className="num">{fmt(e.metric)}</b>)}
            {row("Spread between runs", (e) => (e.metricSpread != null ? `${(e.metricSpread * 100).toFixed(1)}%` : "—"))}
            {row("Checks passed", (e) => (e.passed == null ? "—" : e.passed ? "yes" : "no"))}
            {keys.map((k) => row(k, (e) => String(e.metrics[k] ?? "—")))}
            {row("Outcome", (e) => (e.decision ? DECISION_LABEL[e.decision] : EXP_STATUS[e.status]))}
            {row("Changed files", (e) => e.changedFiles.join(", ") || "—")}
            {row("Agent", (e) => (e.agentKind ? NAMES[e.agentKind] : "—"))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ activity & report
function Activity({ view, onSelect }: { view: ResearchView; onSelect: (id: string) => void }) {
  const events = [...view.events].reverse();
  return (
    <section className="viz-card">
      <ol className="activity">
        {events.map((ev) => {
          const e = ev.experimentId ? view.experiments.find((x) => x.id === ev.experimentId) : null;
          return (
            <li key={ev.id} className={`ev ev-${ev.kind}`}>
              <time className="num">{new Date(ev.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
              <span>
                {ev.message}
                {e && (
                  <button className="link small" onClick={() => onSelect(e.id)}>
                    {" "}
                    Open E{e.seq}
                  </button>
                )}
              </span>
            </li>
          );
        })}
        {!events.length && <li className="muted small">Nothing yet.</li>}
      </ol>
    </section>
  );
}

function Report({ view }: { view: ResearchView }) {
  const [text, setText] = useState<string | null>(null);
  const stamp = view.experiments.map((e) => `${e.id}:${e.updatedAt}`).join("|") + view.run.status;
  useEffect(() => {
    api.researchReport(view.run.id).then(setText).catch((e) => setText(`Could not build the report: ${e.message}`));
  }, [view.run.id, stamp]);
  return (
    <section className="viz-card report">
      <div className="table-head">
        <h3>Research report</h3>
        <span className="spacer" />
        <a className="button" href={`/api/research/${view.run.id}/report.md?download=1`}>
          Download Markdown
        </a>
        <a className="button" href={`/api/research/${view.run.id}/experiments.csv`}>
          Download CSV
        </a>
      </div>
      <p className="muted small">Built from Team Room's experiment records and measurements, not written by a model.</p>
      {text == null ? <p className="muted">Building…</p> : <Md text={text} />}
    </section>
  );
}

// ------------------------------------------------------------------ side panel
function AgentsCard({ view }: { view: ResearchView }) {
  const r = view.run;
  const roles: { kind: AgentKind | null; role: string; note: string }[] = [
    { kind: r.roles.researcher, role: "Researcher", note: "proposes hypotheses from the evidence" },
    ...r.roles.implementers.map((k) => ({ kind: k, role: "Implementer", note: "changes code in an experiment worktree" })),
    { kind: r.roles.evaluator === "other" || r.roles.evaluator === "off" ? null : r.roles.evaluator, role: "Evaluator", note: r.roles.evaluator === "off" ? "off: measurement decides alone" : r.roles.evaluator === "other" ? "the other agent cross-checks each improvement" : "checks each improvement" },
  ];
  return (
    <section className="card">
      <h3>Roles</h3>
      {roles.map((x, i) => (
        <div key={i} className="participant">
          {x.kind ? <Avatar who={x.kind} /> : <span className="avatar a-none">⇄</span>}
          <div className="p-info">
            <div className="p-row">
              <span className="p-name">{x.role}</span>
              <span className="muted small">{x.kind ? NAMES[x.kind] : r.roles.evaluator === "off" ? "—" : "cross-check"}</span>
            </div>
            <div className="muted small">{x.note}</div>
          </div>
        </div>
      ))}
      <div className="participant">
        <span className="avatar a-none">TR</span>
        <div className="p-info">
          <div className="p-row">
            <span className="p-name">Orchestrator</span>
            <span className="muted small">Team Room</span>
          </div>
          <div className="muted small">schedules, isolates, evaluates, keeps the best. Deterministic, so it resumes from the records.</div>
        </div>
      </div>
      {r.researcherThreadLink && (
        <T3Link className="small" link={r.researcherThreadLink}>
          Researcher thread in T3 <Icon name="external" />
        </T3Link>
      )}
    </section>
  );
}

function BudgetCard({ view, act }: { view: ResearchView; act: (fn: () => Promise<ResearchView>) => void }) {
  const l = view.run.limits;
  const [form, setForm] = useState(l);
  useEffect(() => setForm(view.run.limits), [JSON.stringify(view.run.limits)]);
  const changed = JSON.stringify(form) !== JSON.stringify(l);
  const field = (key: keyof typeof l, label: string, min: number, max: number) => (
    <>
      <label htmlFor={`lim-${key}`}>{label}</label>
      <input id={`lim-${key}`} type="number" min={min} max={max} value={(form[key] as number) ?? ""} onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })} />
    </>
  );
  return (
    <section className="card">
      <h3>Budget and limits</h3>
      <div className="limits limits-2">
        {field("maxExperiments", "Max experiments", 1, 500)}
        {field("maxMinutes", "Max minutes", 1, 10080)}
        {field("maxConcurrency", "At a time", 1, 8)}
        {field("maxRetries", "Retries", 0, 5)}
        {field("stagnationLimit", "Stop after no gain in", 1, 100)}
      </div>
      <p className="muted small">Spending: not reported by T3 0.1.7, so no cost cap.</p>
      <button disabled={!changed} onClick={() => act(() => api.researchLimits(view.run.id, form))}>
        Save limits
      </button>
    </section>
  );
}

function SuggestCard({ view, act }: { view: ResearchView; act: (fn: () => Promise<ResearchView>) => void }) {
  const [text, setText] = useState("");
  const [parent, setParent] = useState("");
  const parents = view.experiments.filter((e) => e.commitSha && (e.kind === "baseline" ? e.id === view.run.baselineId : e.decision === "keep"));
  const disabled = !view.run.bestId || ["stopped", "completed", "stopping", "draft"].includes(view.run.status);
  return (
    <section className="card">
      <h3>Suggest a hypothesis</h3>
      <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Cache counts between queries" disabled={disabled} aria-label="Hypothesis" />
      <div className="pin-add">
        <select value={parent} onChange={(e) => setParent(e.target.value)} disabled={disabled} aria-label="Build on">
          <option value="">From the current best</option>
          {parents.map((p) => (
            <option key={p.id} value={p.seq}>
              From E{p.seq} {p.kind === "baseline" ? "(baseline)" : ""}
            </option>
          ))}
        </select>
        <button
          disabled={disabled || !text.trim()}
          onClick={() => {
            act(() => api.researchSuggest(view.run.id, { hypothesis: text, parentSeq: parent === "" ? null : Number(parent) }));
            setText("");
          }}
        >
          Suggest
        </button>
      </div>
      <p className="muted small">Your suggestions run before the researcher's.</p>
    </section>
  );
}

// ------------------------------------------------------------------ experiment detail
function ExperimentDrawer({ view, exp: e, onClose, act, onSelect }: { view: ResearchView; exp: Experiment; onClose: () => void; act: (fn: () => Promise<ResearchView>) => void; onSelect: (id: string) => void }) {
  const [tab, setTab] = useState<"details" | "diff" | "evaluation" | "agents">("details");
  const [note, setNote] = useState("");
  const r = view.run;
  const parent = e.parentId ? view.experiments.find((p) => p.id === e.parentId) : null;
  const children = view.experiments.filter((c) => c.parentId === e.id);
  const samples = view.evals.filter((s) => s.experimentId === e.id);
  const m = markOf(e);
  useEffect(() => {
    const f = (ev: KeyboardEvent) => ev.key === "Escape" && onClose();
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [onClose]);
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-label={`Experiment E${e.seq}`} onClick={(ev) => ev.stopPropagation()}>
        <header className="drawer-head">
          <div>
            <div className="drawer-kicker">
              <Glyph mark={m} size={11} /> E{e.seq} · {e.decision ? DECISION_LABEL[e.decision] : EXP_STATUS[e.status]}
              {e.id === r.bestId && <span className="best-tag">best</span>}
            </div>
            <h2>{e.title}</h2>
          </div>
          <span className="spacer" />
          <button onClick={onClose} aria-label="Close">
            Close
          </button>
        </header>
        <div className="tabs" role="tablist">
          {(["details", "diff", "evaluation", "agents"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {t === "details" ? "Details" : t === "diff" ? `Diff${e.changedFiles.length ? ` (${e.changedFiles.length})` : ""}` : t === "evaluation" ? `Evaluation (${samples.length})` : "Agent reports"}
            </button>
          ))}
        </div>
        <div className="drawer-body">
          {tab === "details" && (
            <>
              {e.decisionReason && <p className={`decision-reason m-${m}`}>{e.decisionReason}</p>}
              <dl className="facts">
                <dt>Hypothesis</dt>
                <dd>{e.hypothesis}</dd>
                {e.design && (
                  <>
                    <dt>Design</dt>
                    <dd>{e.design}</dd>
                  </>
                )}
                {e.approach && (
                  <>
                    <dt>Approach</dt>
                    <dd>{e.approach}</dd>
                  </>
                )}
                <dt>Built on</dt>
                <dd>
                  {parent ? (
                    <button className="link" onClick={() => onSelect(parent.id)}>
                      E{parent.seq} {parent.kind === "baseline" ? "(baseline)" : parent.title}
                    </button>
                  ) : (
                    "—"
                  )}
                  {children.length > 0 && (
                    <span className="muted">
                      {" "}
                      · led to{" "}
                      {children.map((c, i) => (
                        <button key={c.id} className="link" onClick={() => onSelect(c.id)}>
                          {i ? ", " : ""}E{c.seq}
                        </button>
                      ))}
                    </span>
                  )}
                </dd>
                <dt>{r.eval.metricName}</dt>
                <dd className="num">
                  {fmt(e.metric)}
                  {e.metricSpread != null && <span className="muted"> · runs vary by {(e.metricSpread * 100).toFixed(1)}%</span>}
                </dd>
                {Object.keys(e.metrics).length > 0 && (
                  <>
                    <dt>Other metrics</dt>
                    <dd className="mono small">{Object.entries(e.metrics).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join("  ")}</dd>
                  </>
                )}
                {Object.keys(e.params).length > 0 && (
                  <>
                    <dt>Parameters</dt>
                    <dd className="mono small">{JSON.stringify(e.params)}</dd>
                  </>
                )}
                <dt>Agent</dt>
                <dd>
                  {e.agentKind ? `${NAMES[e.agentKind]} · ${e.model}` : e.source === "human" ? "suggested by you" : "—"}
                  {e.retries > 0 && <span className="muted"> · {e.retries} retr{e.retries === 1 ? "y" : "ies"}</span>}
                </dd>
                <dt>Revision</dt>
                <dd className="mono small">
                  {e.branch ?? "—"}
                  {e.commitSha && ` @ ${e.commitSha.slice(0, 12)}`}
                  {e.baseSha && e.kind === "experiment" && <span className="muted"> (from {e.baseSha.slice(0, 8)})</span>}
                </dd>
                <dt>Time</dt>
                <dd className="small">
                  {e.startedAt ? new Date(e.startedAt).toLocaleString() : "not started"}
                  {e.finishedAt && ` → ${new Date(e.finishedAt).toLocaleTimeString()}`}
                </dd>
                {e.lessons && (
                  <>
                    <dt>Lesson</dt>
                    <dd>{e.lessons}</dd>
                  </>
                )}
                {e.failureReason && (
                  <>
                    <dt>Failure</dt>
                    <dd>
                      <pre className="log">{e.failureReason}</pre>
                    </dd>
                  </>
                )}
              </dl>
              {e.status === "awaiting_human" && (
                <div className="judge">
                  <h3>Your judgement</h3>
                  <p className="muted small">Criteria: {r.eval.criteria}</p>
                  <textarea rows={2} value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="Why (recorded with the decision)" />
                  <div className="btn-row">
                    <button className="primary" onClick={() => act(() => api.researchDecide(r.id, e.id, "keep", note))}>
                      Keep
                    </button>
                    <button onClick={() => act(() => api.researchDecide(r.id, e.id, "discard", note))}>Discard</button>
                    <button onClick={() => act(() => api.researchDecide(r.id, e.id, "inconclusive", note))}>Inconclusive</button>
                    <button className="danger" onClick={() => act(() => api.researchDecide(r.id, e.id, "invalid", note))}>
                      Invalid
                    </button>
                  </div>
                </div>
              )}
              <div className="btn-row drawer-actions">
                <button onClick={() => act(() => api.researchPin(r.id, e.id, !e.pinned))}>{e.pinned ? "Unpin" : "Pin as promising"}</button>
                {e.kind === "experiment" && !e.rejected && e.id !== r.bestId && (
                  <button className="danger" onClick={() => confirm(`Reject the direction of E${e.seq}? Queued experiments that build on it or share its approach are cancelled, and the researcher is told not to pursue it.`) && act(() => api.researchReject(r.id, e.id))}>
                    Reject this direction
                  </button>
                )}
                {e.rejected && <span className="muted small">Direction rejected by you.</span>}
              </div>
            </>
          )}
          {tab === "diff" && (e.diff ? <DiffView diff={e.diff} /> : <p className="muted">No diff yet{e.kind === "baseline" ? ": the baseline is the starting code." : "."}</p>)}
          {tab === "evaluation" &&
            (samples.length ? (
              <>
                <table className="exp-table">
                  <thead>
                    <tr>
                      <th>Run</th>
                      <th className="num">{r.eval.metricName}</th>
                      <th>Checks</th>
                      <th className="num">Took</th>
                      <th>Revision</th>
                    </tr>
                  </thead>
                  <tbody>
                    {samples.map((s) => (
                      <tr key={s.id}>
                        <td>#{s.attempt}</td>
                        <td className="num">{fmt(s.metric)}</td>
                        <td>{s.pass === false ? <span className="down">failed{s.error ? `: ${s.error}` : ""}</span> : "passed"}</td>
                        <td className="num">{(s.durationMs / 1000).toFixed(2)}s</td>
                        <td className="mono small">{s.revision?.slice(0, 8)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <h4>Last run output</h4>
                <pre className="log">{samples.at(-1)!.stdoutTail || "(no stdout)"}</pre>
                {samples.at(-1)!.stderrTail && (
                  <>
                    <h4>stderr</h4>
                    <pre className="log">{samples.at(-1)!.stderrTail}</pre>
                  </>
                )}
                <p className="muted small">Command: <code>{r.eval.command}</code>, run by Team Room from protected copies of {r.eval.protectedPaths.join(", ") || "(no protected paths)"}.</p>
              </>
            ) : (
              <p className="muted">Not evaluated{e.decision === "invalid" ? ": rejected before evaluation." : " yet."}</p>
            ))}
          {tab === "agents" && (
            <>
              <h4>Implementer <T3Link className="small" link={e.threadLink}>thread in T3 <Icon name="external" /></T3Link></h4>
              {e.report ? <Md text={e.report} /> : <p className="muted">No report yet.</p>}
              <h4>Evaluator <T3Link className="small" link={e.reviewThreadLink}>thread in T3 <Icon name="external" /></T3Link></h4>
              {e.review ? <Md text={e.review} /> : <p className="muted">{r.roles.evaluator === "off" ? "The evaluator role is off for this run." : "Only experiments that beat the best are reviewed."}</p>}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="diff" aria-label="Diff">
      {diff.split("\n").map((l, i) => (
        <span key={i} className={l.startsWith("+++") || l.startsWith("---") ? "d-file" : l.startsWith("+") ? "d-add" : l.startsWith("-") ? "d-del" : l.startsWith("@@") ? "d-hunk" : ""}>
          {l}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}
