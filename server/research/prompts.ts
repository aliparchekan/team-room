// Prompts for the agent roles, and parsers for their structured replies. The
// researcher's prompt is rebuilt from the database every round, so the
// research state never depends on what an agent remembers.
import type { Experiment, ResearchRun } from "../../shared/research.js";
import { AGENT_NAMES } from "../envelope.js";

const fmt = (n: number | null | undefined) => (n == null ? "—" : Number(n.toPrecision(6)).toString());

function objectiveBlock(run: ResearchRun) {
  const e = run.eval;
  return [
    "=== Research objective (from the human lead) ===",
    run.objective.trim(),
    "",
    "=== How results are judged ===",
    e.kind === "command"
      ? `Team Room runs \`${e.command}\` itself, ${e.repeats} time(s), from a protected copy of the evaluation files, and takes the median of "${e.metricName}". Direction: ${e.direction}. A change counts only if it beats the current best by more than ${Math.round(e.minImprovement * 100)}% and the measured noise. Failing correctness checks make an experiment invalid.`
      : "There is no automated evaluation. The human lead judges each experiment against the criteria below.",
    e.criteria.trim() ? `Criteria: ${e.criteria.trim()}` : "",
    "",
    "=== Rules for every experiment ===",
    `- Allowed to change: ${run.allowedScope.length ? run.allowedScope.join(", ") : "anything except the protected paths"}`,
    `- Protected (never modify, never read around): ${e.protectedPaths.length ? e.protectedPaths.join(", ") : "(none)"}`,
    "- An experiment that touches protected paths or files outside the allowed scope is rejected as invalid.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function historyTable(experiments: Experiment[]) {
  const rows = experiments.map((e) => {
    const parent = e.parentId ? experiments.find((p) => p.id === e.parentId) : null;
    const outcome = e.decision ? `${e.decision}${e.decisionReason ? ` — ${e.decisionReason}` : ""}` : e.status;
    return `E${e.seq} | parent ${parent ? `E${parent.seq}` : "—"} | ${e.approach || e.kind} | ${fmt(e.metric)} | ${outcome}${e.pinned ? " | PINNED" : ""}${e.rejected ? " | REJECTED DIRECTION" : ""}\n   hypothesis: ${e.hypothesis.replace(/\s+/g, " ").slice(0, 400)}${e.lessons ? `\n   lesson: ${e.lessons.replace(/\s+/g, " ").slice(0, 400)}` : ""}`;
  });
  return ["=== Experiment history (from Team Room's records) ===", "id | parent | approach | metric | outcome", ...rows].join("\n");
}

export function researcherPrompt(input: {
  run: ResearchRun;
  experiments: Experiment[];
  best: Experiment;
  baseline: Experiment;
  wanted: number;
  parents: Experiment[];
  guidance: string;
  exhausted: { approach: string; reason: string }[];
  needLessons: Experiment[];
  suggestions: string[];
}) {
  const { run, best, baseline } = input;
  return [
    `[Team Room AutoResearch "${run.title}" · role: RESEARCHER · you are ${AGENT_NAMES[run.roles.researcher]}]`,
    "",
    "You direct the research. You do not edit code: implementer agents carry out your experiments in their own isolated worktrees, and Team Room evaluates them. Your working directory is a read-only reference checkout of the current best solution; read it freely, but do not modify it.",
    run.roles.agentCommands ? "" : "Read files only; do not run shell commands (each one would wait for the human lead's approval).",
    "",
    objectiveBlock(run),
    "",
    `Baseline E${baseline.seq}: ${fmt(baseline.metric)}. Current best E${best.seq}: ${fmt(best.metric)}${best.id === baseline.id ? " (no improvement yet)" : ""}.`,
    "",
    historyTable(input.experiments),
    "",
    input.exhausted.length
      ? `=== Directions not to repeat ===\n${input.exhausted.map((x) => `- ${x.approach} (${x.reason})`).join("\n")}`
      : "",
    input.suggestions.length ? `=== Hypotheses suggested by the human lead (already queued; do not duplicate) ===\n${input.suggestions.map((s) => `- ${s}`).join("\n")}` : "",
    "",
    input.guidance,
    "",
    `You may build on: ${input.parents.map((p) => `E${p.seq}${p.id === best.id ? " (best)" : p.id === baseline.id ? " (baseline)" : ""}`).join(", ")}.`,
    "Use the evidence. Prefer a different approach over another small variation of an idea that already failed.",
    "",
    input.needLessons.length
      ? `Also write one evidence-based lesson for each of these finished experiments: ${input.needLessons.map((e) => `E${e.seq}`).join(", ")}. Say what the measurement shows, not what you hoped.`
      : "",
    "",
    `Reply with your reasoning in a few sentences, then exactly one fenced \`\`\`json block:`,
    "```json",
    JSON.stringify(
      {
        lessons: input.needLessons.length ? [{ experiment: `E${input.needLessons[0].seq}`, lesson: "…" }] : [],
        hypotheses: Array.from({ length: Math.max(1, input.wanted) }, () => ({
          title: "short name",
          hypothesis: "what you expect and why",
          approach: "approach family, 1-3 words",
          parent: `E${best.seq}`,
          design: "the concrete change the implementer should make, and how it tests the hypothesis",
          params: {},
        })),
      },
      null,
      2,
    ),
    "```",
    `Give exactly ${input.wanted} hypothes${input.wanted === 1 ? "is" : "es"}.`,
  ]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n");
}

export function implementerPrompt(run: ResearchRun, exp: Experiment, parent: Experiment) {
  return [
    `[Team Room AutoResearch "${run.title}" · role: IMPLEMENTER · experiment E${exp.seq} · you are ${exp.agentKind ? AGENT_NAMES[exp.agentKind] : "an agent"}]`,
    "",
    `Your working directory is an isolated git worktree for this experiment, checked out at E${parent.seq}${parent.commitSha ? ` (${parent.commitSha.slice(0, 10)})` : ""}. Nobody else writes here.`,
    "",
    objectiveBlock(run),
    "",
    `=== Experiment E${exp.seq}: ${exp.title} ===`,
    `Hypothesis: ${exp.hypothesis}`,
    exp.design ? `Design: ${exp.design}` : "",
    Object.keys(exp.params).length ? `Parameters: ${JSON.stringify(exp.params)}` : "",
    "",
    "Do this:",
    "- Make the smallest change that tests this hypothesis. Stay inside the allowed scope.",
    run.roles.agentCommands
      ? "- You may run the code and quick checks yourself, but Team Room's own evaluation is what counts; do not tune for it by special-casing its inputs."
      : "- Do not run shell commands or programs: read and edit files only (each command would wait for the human lead's approval). Team Room commits, runs the evaluation, and sends you any error to fix. Do not tune for the evaluation by special-casing its inputs.",
    "- Do not modify protected paths, do not commit, push or merge. Team Room commits your changes on this experiment's branch.",
    "- If the hypothesis cannot be tested within the rules, change nothing and say why.",
    "",
    "Finish with `## Changes` (files and what changed) and `## Expected effect`.",
  ]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n");
}

export function retryPrompt(exp: Experiment, problem: string, attempt: number, max: number, agentCommands = false) {
  return [
    `[Team Room AutoResearch · experiment E${exp.seq} · retry ${attempt} of ${max}]`,
    "",
    "Team Room could not accept the last version of this experiment:",
    "```",
    problem.slice(0, 6000),
    "```",
    `Fix the problem within the same hypothesis and the same rules (allowed scope, protected paths, no commits${agentCommands ? "" : ", no shell commands"}). If the hypothesis itself is the problem, revert your changes and say so.`,
    "Finish with `## Changes` and `## Expected effect`.",
  ].join("\n");
}

export function reviewerPrompt(run: ResearchRun, exp: Experiment, best: Experiment, metricLine: string) {
  return [
    `[Team Room AutoResearch "${run.title}" · role: EVALUATOR · reviewing E${exp.seq}${exp.agentKind ? ` by ${AGENT_NAMES[exp.agentKind]}` : ""}]`,
    "",
    "You are the independent evaluator. Your working directory is the experiment's worktree. Do NOT modify any files.",
    "",
    objectiveBlock(run),
    "",
    `=== Experiment E${exp.seq}: ${exp.title} ===`,
    `Hypothesis: ${exp.hypothesis}`,
    `Measured: ${metricLine} (current best E${best.seq}: ${fmt(best.metric)})`,
    "",
    "=== Diff against its parent ===",
    "```diff",
    (exp.diff ?? "").slice(0, 60_000),
    "```",
    "",
    `Check whether the improvement is real and allowed: correctness for inputs beyond the ones the evaluation uses, special-casing or caching of the evaluation's inputs, weakened checks, hidden behaviour changes, constraint violations. ${run.roles.agentCommands ? "Run read-only checks if useful." : "Review by reading the code and the diff; do not run commands (each one would wait for the human lead's approval)."}`,
    "",
    'Reply briefly, then exactly one fenced ```json block: {"verdict": "valid" | "invalid", "concerns": ["…"]}',
  ].join("\n");
}

// ---------------------------------------------------------------- parsing
export type ProposedHypothesis = { title: string; hypothesis: string; approach: string; parent: string | null; design: string; params: Record<string, unknown>; mode?: string };

function lastJsonBlock(text: string): any | null {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  for (const body of fences.reverse()) {
    try {
      return JSON.parse(body);
    } catch {
      /* try the next one */
    }
  }
  const start = text.lastIndexOf("{\n");
  if (start >= 0) {
    try {
      return JSON.parse(text.slice(start));
    } catch {
      /* no JSON */
    }
  }
  return null;
}

export function parseResearcherReply(text: string): { hypotheses: ProposedHypothesis[]; lessons: { experiment: string; lesson: string }[] } | null {
  const o = lastJsonBlock(text);
  if (!o || !Array.isArray(o.hypotheses)) return null;
  const hypotheses = o.hypotheses
    .filter((h: any) => h && typeof h.hypothesis === "string" && h.hypothesis.trim())
    .map((h: any) => ({
      title: String(h.title ?? h.hypothesis).slice(0, 120),
      hypothesis: String(h.hypothesis),
      approach: String(h.approach ?? "").slice(0, 60),
      parent: typeof h.parent === "string" ? h.parent : null,
      design: String(h.design ?? ""),
      params: h.params && typeof h.params === "object" ? h.params : {},
      mode: typeof h.mode === "string" ? h.mode : undefined,
    }));
  const lessons = Array.isArray(o.lessons)
    ? o.lessons.filter((l: any) => l && typeof l.experiment === "string" && typeof l.lesson === "string").map((l: any) => ({ experiment: l.experiment, lesson: l.lesson }))
    : [];
  return { hypotheses, lessons };
}

export function parseReview(text: string): { verdict: "valid" | "invalid"; concerns: string[] } | null {
  const o = lastJsonBlock(text);
  if (!o || (o.verdict !== "valid" && o.verdict !== "invalid")) return null;
  return { verdict: o.verdict, concerns: Array.isArray(o.concerns) ? o.concerns.map(String) : [] };
}
