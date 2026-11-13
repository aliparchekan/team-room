// Experiment runner and evaluator. Team Room runs the evaluation itself, from a
// fresh copy of the protected evaluation files, so an experiment can neither
// edit nor skip its own acceptance checks. The judge compares repeated
// measurements and refuses to call noise an improvement.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Direction } from "../../shared/research.js";

const TAIL = 16_000;
const MAX_CAPTURE = 2 * 1024 * 1024;

export type EvalOutcome = {
  exitCode: number | null;
  metric: number | null;
  pass: boolean | null;
  metrics: Record<string, unknown>;
  error: string | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
};

/**
 * Run one evaluation in `cwd` (an experiment's checkout). $EVAL_DIR is a fresh
 * temporary copy of `snapshotDir`, deleted afterwards.
 */
export async function runEvaluation(input: { cwd: string; command: string; snapshotDir: string; timeoutSec: number }): Promise<EvalOutcome> {
  const evalDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-room-eval-"));
  fs.cpSync(input.snapshotDir, evalDir, { recursive: true });
  const started = Date.now();
  try {
    const { code, stdout, stderr, timedOut } = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
      const child = spawn("/bin/sh", ["-c", input.command], {
        cwd: input.cwd,
        detached: true, // own process group, so a timeout kills everything it started
        env: { ...process.env, EVAL_DIR: evalDir, TEAM_ROOM_AUTORESEARCH: "1", PYTHONDONTWRITEBYTECODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (b) => (out = (out + b).slice(-MAX_CAPTURE)));
      child.stderr.on("data", (b) => (err = (err + b).slice(-MAX_CAPTURE)));
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          /* already gone */
        }
      }, input.timeoutSec * 1000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout: out, stderr: err, timedOut });
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: null, stdout: out, stderr: `${err}\n${e.message}`, timedOut: false });
      });
    });
    const parsed = parseResult(stdout);
    const error = timedOut
      ? `Evaluation timed out after ${input.timeoutSec}s`
      : code !== 0
        ? (parsed.error ?? `Evaluation exited with code ${code}`)
        : parsed.error;
    return {
      exitCode: code,
      metric: parsed.metric,
      pass: timedOut || code !== 0 ? false : (parsed.pass ?? true),
      metrics: parsed.metrics,
      error,
      durationMs: Date.now() - started,
      stdoutTail: stdout.slice(-TAIL),
      stderrTail: stderr.slice(-TAIL),
    };
  } finally {
    fs.rmSync(evalDir, { recursive: true, force: true });
  }
}

/**
 * The evaluation reports its result as the last JSON object line on stdout:
 * {"metric": 1.23, "pass": true, "metrics": {...}, "error": "..."}; or a line "METRIC: 1.23".
 */
export function parseResult(stdout: string): { metric: number | null; pass: boolean | null; metrics: Record<string, unknown>; error: string | null } {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("{") && t.endsWith("}")) {
      try {
        const o = JSON.parse(t);
        const metric = typeof o.metric === "number" && Number.isFinite(o.metric) ? o.metric : null;
        return {
          metric,
          pass: typeof o.pass === "boolean" ? o.pass : null,
          metrics: o.metrics && typeof o.metrics === "object" ? o.metrics : {},
          error: typeof o.error === "string" ? o.error : null,
        };
      } catch {
        /* not JSON; keep looking */
      }
    }
    const m = /^METRIC\s*[:=]\s*(-?[\d.eE+-]+)\s*$/.exec(t);
    if (m && Number.isFinite(Number(m[1]))) return { metric: Number(m[1]), pass: null, metrics: {}, error: null };
  }
  return { metric: null, pass: null, metrics: {}, error: null };
}

// ---------------------------------------------------------------- judging
export type Summary = { metric: number | null; spread: number; passed: boolean; samples: number; error: string | null };

/** Median of the repeats, their relative spread ((max-min)/|median|), and whether every repeat passed. */
export function summarize(samples: Pick<EvalOutcome, "metric" | "pass" | "error">[]): Summary {
  const failed = samples.find((s) => s.pass === false);
  const values = samples.map((s) => s.metric).filter((m): m is number => m != null).sort((a, b) => a - b);
  const median = values.length ? (values.length % 2 ? values[(values.length - 1) / 2] : (values[values.length / 2 - 1] + values[values.length / 2]) / 2) : null;
  const spread = median && values.length > 1 ? (values[values.length - 1] - values[0]) / Math.abs(median) : 0;
  return { metric: median, spread, passed: !failed, samples: samples.length, error: failed?.error ?? null };
}

export type Verdict = "better" | "worse" | "same" | "noise";

/**
 * Compare a candidate with the current best. A change counts only if it beats
 * both the minimum improvement and the measured noise of either side.
 */
export function compare(direction: Direction, candidate: Summary, best: Summary, minImprovement: number): { verdict: Verdict; relative: number | null; threshold: number } {
  if (direction === "pass_fail") {
    if (candidate.passed && !best.passed) return { verdict: "better", relative: null, threshold: 0 };
    if (!candidate.passed && best.passed) return { verdict: "worse", relative: null, threshold: 0 };
    return { verdict: "same", relative: null, threshold: 0 };
  }
  if (candidate.metric == null || best.metric == null) return { verdict: "worse", relative: null, threshold: 0 };
  const base = Math.abs(best.metric) || 1e-12;
  const relative = direction === "minimize" ? (best.metric - candidate.metric) / base : (candidate.metric - best.metric) / base;
  const threshold = Math.max(minImprovement, candidate.spread, best.spread);
  if (relative > threshold) return { verdict: "better", relative, threshold };
  if (relative < -threshold) return { verdict: "worse", relative, threshold };
  return { verdict: relative > 0 ? "noise" : "same", relative, threshold };
}

/** Percentage improvement of `value` over `baseline` in the objective's direction. */
export function improvementPct(direction: Direction, baseline: number | null, value: number | null): number | null {
  if (direction === "pass_fail" || baseline == null || value == null || baseline === 0) return null;
  const r = direction === "minimize" ? (baseline - value) / Math.abs(baseline) : (value - baseline) / Math.abs(baseline);
  return Math.round(r * 1000) / 10;
}
