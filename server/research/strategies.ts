// Exploration strategies. Each one decides how many hypotheses to ask for,
// which experiments new work may build on, and how the researcher is guided.
// Adding a strategy means adding one entry to STRATEGIES.
import type { Experiment, ResearchRun, ResearchStrategyId } from "../../shared/research.js";

export type StrategyContext = {
  run: ResearchRun;
  experiments: Experiment[];
  best: Experiment;
  baseline: Experiment;
  /** Experiment slots free right now (max concurrency minus active and already-proposed work). */
  freeSlots: number;
};

export interface ResearchStrategy {
  id: ResearchStrategyId;
  /** Hypotheses to request now; 0 waits for running work. */
  wanted(ctx: StrategyContext): number;
  /** Experiments a new hypothesis may start from (the first is the default). */
  parents(ctx: StrategyContext): Experiment[];
  guidance(ctx: StrategyContext, wanted: number): string;
}

const kept = (ctx: StrategyContext) => ctx.experiments.filter((e) => e.decision === "keep" && !e.rejected);
const failed = (ctx: StrategyContext) => ctx.experiments.filter((e) => e.decision && e.decision !== "keep");

export const STRATEGIES: Record<ResearchStrategyId, ResearchStrategy> = {
  greedy: {
    id: "greedy",
    wanted: (ctx) => Math.min(ctx.freeSlots, 1),
    parents: (ctx) => [ctx.best],
    guidance: () =>
      "Strategy: greedy improvement. Propose the single most promising refinement of the current best solution. Build on it; do not restart from scratch.",
  },
  parallel: {
    id: "parallel",
    wanted: (ctx) => ctx.freeSlots,
    parents: (ctx) => [ctx.best],
    guidance: (_ctx, n) =>
      `Strategy: parallel exploration. Propose ${n} competing hypotheses that will run at the same time. Each must use a different approach family, so the results tell the approaches apart.`,
  },
  explore_exploit: {
    id: "explore_exploit",
    wanted: (ctx) => ctx.freeSlots,
    parents: (ctx) => {
      const pinned = ctx.experiments.filter((e) => e.pinned && e.commitSha && !e.rejected);
      const others = kept(ctx).filter((e) => e.id !== ctx.best.id).slice(-3);
      return uniq([ctx.best, ...pinned, ...others, ctx.baseline]);
    },
    guidance: (ctx, n) => {
      const explore = Math.max(1, Math.round(n / 3));
      return `Strategy: explore / exploit. Of the ${n} hypotheses, about ${explore} should explore an approach family not tried yet (it may start from the baseline or another kept experiment); the rest should refine the current best (E${ctx.best.seq}). Mark each with "mode": "explore" or "exploit".`;
    },
  },
  failure_driven: {
    id: "failure_driven",
    wanted: (ctx) => Math.min(ctx.freeSlots, Math.max(1, Math.ceil(ctx.freeSlots / 2))),
    parents: (ctx) => [ctx.best],
    guidance: (ctx) => {
      const f = failed(ctx);
      return f.length
        ? `Strategy: failure-driven investigation. Start from the failed, invalid or inconclusive experiments (${f.map((e) => `E${e.seq}`).join(", ")}). For each hypothesis, name the failure it explains in "addresses", give an alternative explanation for why it failed, and test that explanation.`
        : "Strategy: failure-driven investigation. There are no failures yet, so propose a hypothesis that tests the riskiest assumption behind the current best solution.";
    },
  },
};

function uniq(list: Experiment[]) {
  const seen = new Set<string>();
  return list.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}

/**
 * Approach families not worth more attempts: rejected by the human, or tried
 * at least twice by the researcher without a single kept result.
 */
export function exhaustedApproaches(experiments: Experiment[]): { approach: string; reason: string }[] {
  const by = new Map<string, Experiment[]>();
  for (const e of experiments) {
    if (e.kind !== "experiment" || !e.approach) continue;
    const key = normalizeApproach(e.approach);
    by.set(key, [...(by.get(key) ?? []), e]);
  }
  const out: { approach: string; reason: string }[] = [];
  for (const [approach, list] of by) {
    if (list.some((e) => e.rejected)) out.push({ approach, reason: "rejected by the human lead" });
    else {
      const decided = list.filter((e) => e.decision);
      if (decided.length >= 2 && !decided.some((e) => e.decision === "keep")) out.push({ approach, reason: `${decided.length} attempts, none kept` });
    }
  }
  return out;
}

export function normalizeApproach(a: string) {
  return a.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
