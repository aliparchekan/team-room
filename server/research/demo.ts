// The AutoResearch demo: set up its git repository, and scripted agents for
// fixture mode (TEAM_ROOM_FIXTURE=1) and tests. The scripted agents edit files
// in their experiment worktree like a real agent; everything else (git,
// evaluation, decisions) is the real engine.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT } from "../config.js";

export const DEMO_SOURCE = path.join(ROOT, "examples", "autoresearch-demo");

/** Copy the demo to `dir` and make it a one-commit git repository (no-op if it exists). */
export function ensureDemoRepo(dir: string): string {
  if (fs.existsSync(path.join(dir, ".git"))) return dir;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.cpSync(DEMO_SOURCE, dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".autoresearch-demo"), "Created by Team Room for the AutoResearch demo\n");
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("add", "-A");
  g("-c", "user.name=Team Room", "-c", "user.email=demo@team-room.local", "commit", "-q", "-m", "AutoResearch demo: slow prime-counting baseline");
  return dir;
}

const SQRT = `"""Prime counting: trial division only up to sqrt(k), odd divisors only."""


def is_prime(k):
    if k < 2:
        return False
    if k % 2 == 0:
        return k == 2
    d = 3
    while d * d <= k:
        if k % d == 0:
            return False
        d += 2
    return True


def answer_queries(queries):
    return [sum(1 for k in range(n + 1) if is_prime(k)) for n in queries]
`;

const ESTIMATE = `"""Prime counting by the prime number theorem: n / ln n."""
import math


def answer_queries(queries):
    return [int(n / math.log(n)) if n > 2 else (1 if n == 2 else 0) for n in queries]
`;

const SIEVE = `"""Prime counting: one sieve up to max(queries), then prefix counts."""


def answer_queries(queries):
    top = max(queries) if queries else 0
    flags = bytearray([1]) * (top + 1)
    flags[0:2] = bytearray(min(2, top + 1))
    for i in range(2, int(top ** 0.5) + 1):
        if flags[i]:
            flags[i * i :: i] = bytearray(len(flags[i * i :: i]))
    prefix, total = [], 0
    for f in flags:
        total += f
        prefix.append(total)
    return [prefix[q] for q in queries]
`;

const ODD_SIEVE = `"""Prime counting: odd-only sieve with prefix counts via itertools.accumulate."""
from itertools import accumulate


def answer_queries(queries):
    top = max(queries) if queries else 0
    if top < 2:
        return [0 for _ in queries]
    flags = bytearray([1]) * (top + 1)
    flags[0:2] = b"\\x00\\x00"
    flags[4::2] = bytearray(len(flags[4::2]))
    for i in range(3, int(top ** 0.5) + 1, 2):
        if flags[i]:
            flags[i * i :: 2 * i] = bytearray(len(flags[i * i :: 2 * i]))
    prefix = list(accumulate(flags))
    return [prefix[q] for q in queries]
`;

const MEMO = `"""Prime counting: memoize counts between queries (still trial division)."""
_cache = {}


def _is_prime(k):
    if k < 2:
        return False
    for d in range(2, k):
        if k % d == 0:
            return False
    return True


def answer_queries(queries):
    out = []
    for n in queries:
        if n not in _cache:
            _cache[n] = sum(1 for k in range(n + 1) if _is_prime(k))
        out.append(_cache[n])
    return out
`;

type Script = { title: string; approach: string; hypothesis: string; design: string; files: Record<string, string> };

const SCRIPTS: Script[] = [
  { title: "Trial division up to sqrt(k)", approach: "trial division", hypothesis: "Most of the time goes to testing divisors above sqrt(k); stopping there and skipping even divisors should cut the work by orders of magnitude.", design: "Rewrite is_prime to test 2, then odd d while d*d <= k.", files: { "solver.py": SQRT } },
  { title: "Prime number theorem estimate", approach: "approximation", hypothesis: "n / ln n approximates the count and costs O(1) per query.", design: "Replace the counting loop with int(n / log n).", files: { "solver.py": ESTIMATE } },
  { title: "One sieve, prefix counts", approach: "sieve", hypothesis: "All queries share one range; a single sieve up to max(queries) plus prefix sums answers each query in O(1).", design: "Sieve once, accumulate, index per query.", files: { "solver.py": SIEVE } },
  { title: "Relax the correctness checker", approach: "evaluation shortcut", hypothesis: "The checker itself costs time.", design: "Edit eval/evaluate.py to skip the reference comparison.", files: { "eval/evaluate.py": 'import json\nprint(json.dumps({"metric": 0.0, "pass": True}))\n' } },
  { title: "Odd-only sieve", approach: "sieve tuning", hypothesis: "Halving the sieve work by striking only odd multiples and using accumulate should beat the plain sieve.", design: "Sieve odd numbers with step 2*i; prefix via itertools.accumulate.", files: { "solver.py": ODD_SIEVE } },
  { title: "Memoize counts between queries", approach: "caching", hypothesis: "Several queries repeat, so caching counts avoids recomputation.", design: "Cache answer per n in a module dict.", files: { "solver.py": MEMO } },
];

/** A scripted agent reply for an AutoResearch prompt, or null if the prompt is not one. */
export function scriptedResearchReply(prompt: string, worktreePath: string | null, round: { n: number }): string | null {
  if (prompt.includes("role: RESEARCHER") || prompt.includes("could not read hypotheses")) {
    const wanted = Number(/Give exactly (\d+) hypothes/.exec(prompt)?.[1] ?? "1");
    const best = /Current best (E\d+)/.exec(prompt)?.[1] ?? "E0";
    const lessonsFor = /lesson for each of these finished experiments: ([E\d, ]+)\./.exec(prompt)?.[1]?.split(",").map((s) => s.trim()) ?? [];
    const picks = Array.from({ length: wanted }, () => SCRIPTS[round.n++ % SCRIPTS.length]);
    return [
      `**[FIXTURE — scripted researcher]** Proposing ${wanted} experiment(s) from ${best}.`,
      "```json",
      JSON.stringify(
        {
          lessons: lessonsFor.map((e) => ({ experiment: e, lesson: `Recorded outcome of ${e}; see its measurement and decision.` })),
          hypotheses: picks.map((s) => ({ title: s.title, hypothesis: s.hypothesis, approach: s.approach, parent: best, design: s.design, params: {} })),
        },
        null,
        2,
      ),
      "```",
    ].join("\n");
  }
  if (prompt.includes("role: IMPLEMENTER") || prompt.includes("Team Room could not accept the last version")) {
    const title = /=== Experiment E\d+: (.+) ===/.exec(prompt)?.[1]?.trim() ?? "";
    const script = SCRIPTS.find((s) => s.title === title);
    if (script && worktreePath) for (const [f, body] of Object.entries(script.files)) fs.writeFileSync(path.join(worktreePath, f), body);
    return `**[FIXTURE — scripted implementer]**\n\n## Changes\n${script ? Object.keys(script.files).map((f) => `- ${f}`).join("\n") : "- none (unknown experiment)"}\n\n## Expected effect\n${script?.hypothesis ?? "—"}`;
  }
  if (prompt.includes("role: EVALUATOR")) {
    // The check a careful evaluator makes: state kept across calls lets a benchmark time a cache, not the algorithm.
    if (/^\+_?\w*cache\w* = /m.test(prompt))
      return '**[FIXTURE — scripted evaluator]** The diff adds module-level state that survives between calls, so repeated timing measures the cache.\n```json\n{"verdict": "invalid", "concerns": ["module-level cache persists across calls; measured speed-up is the cache, not the algorithm"]}\n```';
    return '**[FIXTURE — scripted evaluator]** Checked the diff: general algorithm, no special-casing of inputs.\n```json\n{"verdict": "valid", "concerns": []}\n```';
  }
  return null;
}
