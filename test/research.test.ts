// AutoResearch end to end: a real git repository (the demo project), real
// worktrees, real Python evaluations. Only the agents are scripted: the
// "implementer" writes files into its experiment worktree, like a real agent would.
import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../server/store.js";
import { FakeT3Adapter } from "../server/t3/fakeAdapter.js";
import { ResearchStore } from "../server/research/store.js";
import { ResearchEngine } from "../server/research/engine.js";
import { markdownReport, experimentsCsv } from "../server/research/report.js";
import { compare, parseResult, summarize } from "../server/research/evaluator.js";
import { matchesAny, scopeViolations } from "../server/research/workspace.js";
import type { CreateResearchInput, Experiment } from "../shared/research.js";

const DEMO = path.resolve(__dirname, "../examples/autoresearch-demo");

// Scripted implementations of solver.py.
const HALF = `def is_prime(n):
    if n < 2:
        return False
    for d in range(2, n // 2 + 1):
        if n % d == 0:
            return False
    return True


def answer_queries(queries):
    return [sum(1 for k in range(n + 1) if is_prime(k)) for n in queries]
`;
const WRONG = `def answer_queries(queries):
    import math
    return [int(n / math.log(n)) if n > 2 else 0 for n in queries]
`;
const SIEVE = `def answer_queries(queries):
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

let tmp: string;
let repo: string;
let store: Store;
let t3: FakeT3Adapter;
let engine: ResearchEngine;

const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-test-"));
  repo = path.join(tmp, "demo");
  fs.cpSync(DEMO, repo, { recursive: true });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "baseline");
  store = new Store(":memory:");
  t3 = new FakeT3Adapter();
  t3.projects = [{ id: "p-demo", title: "Demo", workspaceRoot: repo }];
  engine = new ResearchEngine(new ResearchStore(store.db), t3, { dataDir: path.join(tmp, "data") });
});

const models = { claude: { providerInstanceId: "claudeAgent", model: "fixture-claude" }, codex: { providerInstanceId: "codex", model: "fixture-codex" } };

function input(over: Partial<CreateResearchInput> = {}): CreateResearchInput {
  return {
    title: "Faster primes",
    objective: "Make answer_queries faster while keeping every answer correct.",
    projectId: "p-demo",
    allowedScope: ["solver.py"],
    eval: { kind: "command", command: 'python3 "$EVAL_DIR/eval/evaluate.py"', direction: "minimize", criteria: "All answers must match the reference.", protectedPaths: ["eval/"], repeats: 3, minImprovement: 0.05 },
    strategy: "parallel",
    roles: { researcher: "claude", implementers: ["claude", "codex"], evaluator: "other" },
    models,
    limits: { maxExperiments: 6, maxConcurrency: 2, maxRetries: 1, stagnationLimit: 5, maxMinutes: 60 },
    ...over,
  };
}

const hyps = (...h: { title: string; approach: string; parent?: string }[]) =>
  "Here is my plan.\n```json\n" +
  JSON.stringify({ lessons: [], hypotheses: h.map((x) => ({ title: x.title, hypothesis: `${x.title} should be faster`, approach: x.approach, parent: x.parent ?? "E0", design: "edit solver.py", params: {} })) }) +
  "\n```";

const exp = (runId: string, seq: number) => engine.store.experiments(runId, "seq=?", seq)[0];
const run = (id: string) => engine.store.run(id)!;

/** Script an implementer: edit files in its worktree, then finish its T3 turn. */
function implement(e: Experiment, files: Record<string, string>) {
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(e.worktreePath!, f), body);
  t3.complete(e.threadId!, "## Changes\n- solver.py\n## Expected effect\nfaster");
}

async function settle() {
  await engine.tick();
  await engine.drainEvaluations();
  await engine.tick();
}

describe("AutoResearch", () => {
  it("runs the full loop: baseline, parallel experiments, rejects invalid ones, keeps real improvements, survives stop and restart", async () => {
    const created = await engine.createRun(input());
    expect(created.status).toBe("draft");
    await engine.start(created.id);
    expect(run(created.id).status).toBe("baseline");
    await engine.drainEvaluations();

    // 1. Baseline: measured from the untouched commit, three runs, kept as the reference.
    let r = run(created.id);
    const base = exp(r.id, 0);
    expect(r.status).toBe("running");
    expect(base.decision).toBe("keep");
    expect(base.metric).toBeGreaterThan(0);
    expect(engine.store.evalsFor(base.id)).toHaveLength(3);
    expect(r.bestId).toBe(base.id);

    // 2. Researcher (a real T3 thread) is asked for 2 competing hypotheses, in the run's reference worktree.
    await engine.tick();
    r = run(r.id);
    expect(r.researcherAsk?.wanted).toBe(2);
    const researcherLaunch = t3.launchInputs.find((l) => l.clientRequestId === `ar-${r.id}-researcher`)!;
    expect(researcherLaunch.workspace).toEqual({ kind: "existing_worktree", worktreePath: r.referencePath });
    expect(researcherLaunch.message).toContain("Strategy: parallel exploration");
    t3.complete(r.researcherThreadId!, hyps({ title: "Trial division to n/2", approach: "trial division" }, { title: "Prime number theorem estimate", approach: "approximation" }));

    // 3. Both experiments start at once, each in its own worktree and branch, one per implementer agent.
    await engine.tick();
    let e1 = exp(r.id, 1);
    let e2 = exp(r.id, 2);
    expect([e1.status, e2.status]).toEqual(["implementing", "implementing"]);
    expect([e1.agentKind, e2.agentKind]).toEqual(["claude", "codex"]);
    expect(e1.worktreePath).not.toBe(e2.worktreePath);
    expect(fs.existsSync(path.join(e1.worktreePath!, "solver.py"))).toBe(true);
    expect(git("branch", "--list", `${engine.namespace(r)}*`)).toContain(`${engine.namespace(r)}E1`);

    implement(e1, { "solver.py": HALF });
    implement(e2, { "solver.py": WRONG });
    await settle();

    // 4. E2 is faster but wrong: the independent check rejects it. E1 beats the baseline and goes to the evaluator agent.
    e1 = exp(r.id, 1);
    e2 = exp(r.id, 2);
    expect(e2.decision).toBe("invalid");
    expect(e2.decisionReason).toMatch(/Correctness check failed/);
    expect(e1.status).toBe("reviewing");
    expect(e1.commitSha).toBeTruthy();
    expect(e1.changedFiles).toEqual(["solver.py"]);
    expect(e1.diff).toContain("n // 2 + 1");
    const reviewLaunch = t3.launchInputs.find((l) => l.clientRequestId.startsWith(`ar-${e1.id}-review`))!;
    expect(reviewLaunch.providerInstanceId).toBe("codex"); // the other agent reviews Claude's work
    t3.complete(e1.reviewThreadId!, 'Looks right.\n```json\n{"verdict": "valid", "concerns": []}\n```');
    await engine.tick();
    e1 = exp(r.id, 1);
    expect(e1.decision).toBe("keep");
    expect(run(r.id).bestId).toBe(e1.id);
    expect(e1.metric!).toBeLessThan(base.metric!);

    // 5. Next round: one experiment edits the protected evaluation, one is a real sieve. The tamperer is rejected
    //    unevaluated and the run pauses for the human, as an action outside the approved scope.
    //    Parallel exploration keeps slots full: the researcher was already asked for one hypothesis when E2 freed a slot.
    r = run(r.id);
    expect(r.researcherAsk?.wanted).toBe(1);
    const ask = t3.sendCalls.at(-1)!;
    expect(ask.threadId).toBe(r.researcherThreadId);
    expect(ask.message).toContain("E2 | parent E0 | approximation"); // history comes from the records
    expect(ask.message).toContain("evidence-based lesson"); // lessons for decided experiments
    const reply = (h: object) => "```json\n" + JSON.stringify({ lessons: [{ experiment: "E2", lesson: "The estimate is fast but wrong; correctness rules it out." }], hypotheses: [h] }) + "\n```";
    t3.complete(r.researcherThreadId!, reply({ title: "Relax the checker", hypothesis: "skip checks", approach: "evaluation shortcut", parent: "E1", design: "", params: {} }));
    await engine.tick(); // E3 starts; one slot is still free, so the researcher is asked again
    t3.complete(r.researcherThreadId!, reply({ title: "Sieve once with prefix counts", hypothesis: "one sieve answers all queries", approach: "sieve", parent: "E1", design: "", params: { limit: "max(queries)" } }));
    await engine.tick();
    expect(exp(r.id, 2).lessons).toMatch(/fast but wrong/);
    const e3 = exp(r.id, 3);
    const e4 = exp(r.id, 4);
    expect(e3.baseSha).toBe(e1.commitSha); // built on the kept experiment
    expect(e4.params).toEqual({ limit: "max(queries)" });
    implement(e3, { "eval/evaluate.py": "print('{\"metric\": 0.0, \"pass\": true}')\n" });
    implement(e4, { "solver.py": SIEVE });
    await engine.tick();
    expect(exp(r.id, 3).decision).toBe("invalid");
    expect(exp(r.id, 3).decisionReason).toMatch(/protected evaluation files \(eval\/evaluate.py\)/);
    expect(engine.store.evalsFor(e3.id)).toHaveLength(0); // never ran
    expect(run(r.id).status).toBe("paused");

    // While paused, work already underway still finishes (E4 is evaluated); nothing new starts.
    await engine.drainEvaluations();
    await engine.tick();
    expect(exp(r.id, 4).status).toBe("reviewing");
    t3.complete(exp(r.id, 4).reviewThreadId!, '```json\n{"verdict": "valid", "concerns": ["check memory for very large n"]}\n```');
    await engine.tick();
    expect(exp(r.id, 4).decision).toBe("keep");
    expect(run(r.id).bestId).toBe(e4.id);
    const askedBeforeResume = t3.sendCalls.filter((s) => s.threadId === r.researcherThreadId).length;
    await engine.tick();
    expect(t3.sendCalls.filter((s) => s.threadId === r.researcherThreadId)).toHaveLength(askedBeforeResume);

    // 6. Resume, then stop while new work is underway: agents are interrupted, owned worktrees removed, history kept.
    await engine.resume(r.id);
    await engine.tick();
    t3.complete(r.researcherThreadId!, hyps({ title: "Odd-only sieve", approach: "sieve tuning", parent: "E4" }));
    await engine.tick();
    const e5 = exp(r.id, 5);
    expect(e5.status).toBe("implementing");
    await engine.stop(r.id);
    expect(t3.interrupts).toContain(e5.threadId);
    t3.finishInterrupt(e5.threadId!);
    await engine.tick();
    r = run(r.id);
    expect(r.status).toBe("stopped");
    expect(exp(r.id, 5).status).toBe("cancelled");
    expect(fs.existsSync(e5.worktreePath!)).toBe(false);
    expect(git("branch", "--list", `${engine.namespace(r)}E4`)).toContain("E4"); // kept results stay on their branches

    // 7. "Restart": a new engine on the same database rebuilds the state from the records and resumes.
    const restarted = new ResearchEngine(new ResearchStore(store.db), t3, { dataDir: path.join(tmp, "data") });
    restarted.recoverOnStartup();
    const before = restarted.view(r.id);
    expect(before.experiments).toHaveLength(6);
    expect(before.run.bestId).toBe(e4.id);
    await restarted.resume(r.id);
    expect(fs.existsSync(run(r.id).referencePath!)).toBe(true);
    expect(git("-C", run(r.id).referencePath!, "rev-parse", "HEAD")).toBe(exp(r.id, 4).commitSha); // reference = best
    await restarted.stop(r.id);
    await restarted.tick();

    // 8. The user's own checkout was never touched.
    expect(git("status", "--porcelain")).toBe("");
    expect(fs.readFileSync(path.join(repo, "solver.py"), "utf8")).toContain("for d in range(2, n):");

    // 9. Report and CSV come from the records.
    const v = restarted.view(r.id);
    expect(v.summary.improvementPct!).toBeGreaterThan(50);
    const md = markdownReport(v);
    expect(md).toContain("Best reproducible result: E4");
    expect(md).toMatch(/E3 Relax the checker\*\* \(invalid\)/);
    expect(md).toContain("The estimate is fast but wrong");
    const csv = experimentsCsv(v);
    expect(csv.split("\n")[0]).toMatch(/^id,parent,kind/);
    expect(csv).toContain("E4,E1,experiment");
  }, 120_000);

  it("agents only read and edit files unless the run lets them run commands", async () => {
    for (const agentCommands of [false, true]) {
      const r = await engine.createRun(input({ strategy: "greedy", roles: { researcher: "claude", implementers: ["codex"], evaluator: "other", agentCommands } }));
      await engine.start(r.id);
      await engine.drainEvaluations();
      await engine.tick();
      t3.complete(run(r.id).researcherThreadId!, hyps({ title: "Sieve", approach: "sieve" }));
      await engine.tick();
      const prompt = t3.launchInputs.find((l) => l.clientRequestId === `ar-${exp(r.id, 1).id}-impl`)!.message!;
      if (agentCommands) expect(prompt).toContain("You may run the code");
      else expect(prompt).toContain("Do not run shell commands or programs");
      await engine.stop(r.id);
      t3.finishInterrupt(exp(r.id, 1).threadId!);
      await engine.tick();
    }
  });

  it("refuses to start autonomous research when the evaluation gives no metric", async () => {
    const r = await engine.createRun(input({ eval: { kind: "command", command: "echo checked", direction: "minimize", criteria: "", protectedPaths: [] } }));
    await engine.start(r.id);
    await engine.drainEvaluations();
    const after = run(r.id);
    expect(after.status).toBe("needs_attention");
    expect(after.statusDetail).toMatch(/not measurable/);
    expect(after.statusDetail).toMatch(/assisted/);
  });

  it("assisted research: experiments wait for the human's judgement", async () => {
    const r = await engine.createRun(input({ strategy: "greedy", eval: { kind: "human", direction: "maximize", criteria: "The README reads better.", protectedPaths: [] }, roles: { researcher: "codex", implementers: ["codex"], evaluator: "off" } }));
    await engine.start(r.id);
    expect(run(r.id).status).toBe("running");
    await engine.tick();
    t3.complete(run(r.id).researcherThreadId!, hyps({ title: "Shorter intro", approach: "editing" }));
    await engine.tick();
    const e1 = exp(r.id, 1);
    implement(e1, { "solver.py": `${fs.readFileSync(path.join(repo, "solver.py"), "utf8")}\n# clearer\n` });
    await engine.tick();
    expect(exp(r.id, 1).status).toBe("awaiting_human");
    await engine.humanDecide(r.id, e1.id, "keep", "clearer");
    expect(exp(r.id, 1).decision).toBe("keep");
    expect(run(r.id).bestId).toBe(e1.id);
  });

  it("retries a broken experiment once with the error, then gives up as invalid", async () => {
    const r = await engine.createRun(input({ strategy: "greedy", roles: { researcher: "claude", implementers: ["claude"], evaluator: "off" } }));
    await engine.start(r.id);
    await engine.drainEvaluations();
    await engine.tick();
    t3.complete(run(r.id).researcherThreadId!, hyps({ title: "Broken", approach: "x" }));
    await engine.tick();
    const e1 = exp(r.id, 1);
    implement(e1, { "solver.py": "def answer_queries(q):\n    return undefined_name\n" });
    await settle();
    expect(exp(r.id, 1).status).toBe("implementing");
    expect(exp(r.id, 1).retries).toBe(1);
    expect(t3.sendCalls.at(-1)!.message).toMatch(/retry 1 of 1[\s\S]*NameError/);
    implement(exp(r.id, 1), { "solver.py": "def answer_queries(q):\n    return undefined_again\n" });
    await settle();
    expect(exp(r.id, 1).decision).toBe("invalid");
  });

  it("the evaluator agent can reject an apparent improvement, which then is not kept", async () => {
    const r = await engine.createRun(input({ strategy: "greedy", roles: { researcher: "claude", implementers: ["claude"], evaluator: "codex" } }));
    await engine.start(r.id);
    await engine.drainEvaluations();
    await engine.tick();
    t3.complete(run(r.id).researcherThreadId!, hyps({ title: "Sieve", approach: "sieve" }));
    await engine.tick();
    implement(exp(r.id, 1), { "solver.py": SIEVE });
    await settle();
    const e1 = exp(r.id, 1);
    expect(e1.status).toBe("reviewing");
    t3.complete(e1.reviewThreadId!, '```json\n{"verdict": "invalid", "concerns": ["special-cases the benchmark inputs"]}\n```');
    await engine.tick();
    expect(exp(r.id, 1).decision).toBe("invalid");
    expect(exp(r.id, 1).decisionReason).toMatch(/Rejected by the evaluator: special-cases the benchmark inputs/);
    expect(run(r.id).bestId).toBe(exp(r.id, 0).id);
  });

  it("human controls: suggestions run first, rejecting a direction cancels its queued work", async () => {
    const r = await engine.createRun(input({ strategy: "greedy", limits: { maxConcurrency: 1, maxExperiments: 5 } }));
    await engine.start(r.id);
    await engine.drainEvaluations();
    await engine.suggest(r.id, { hypothesis: "Try a sieve" });
    await engine.tick();
    const e1 = exp(r.id, 1);
    expect(e1.source).toBe("human");
    expect(e1.status).toBe("implementing");
    await expect(engine.rejectDirection(r.id, exp(r.id, 0).id)).rejects.toThrow(/baseline/);
    await engine.updateLimits(r.id, { maxExperiments: 1 });
    expect(run(r.id).limits.maxExperiments).toBe(1);
  });
});

describe("evaluator and scope rules", () => {
  it("parses results and refuses to call noise an improvement", () => {
    expect(parseResult('log\n{"metric": 1.5, "pass": true, "metrics": {"a": 1}}\n')).toMatchObject({ metric: 1.5, pass: true, metrics: { a: 1 } });
    expect(parseResult("METRIC: 2.5\n").metric).toBe(2.5);
    const s = (vals: number[]) => summarize(vals.map((m) => ({ metric: m, pass: true, error: null })));
    expect(compare("minimize", s([0.9, 0.95, 1.0]), s([1.0, 1.02, 1.01]), 0.02).verdict).toBe("noise"); // 6% better, 11% spread
    expect(compare("minimize", s([0.5, 0.5, 0.51]), s([1.0, 1.01, 1.0]), 0.02).verdict).toBe("better");
    expect(compare("maximize", s([0.5]), s([1.0]), 0.02).verdict).toBe("worse");
    expect(compare("pass_fail", { ...s([1]), passed: true }, { ...s([1]), passed: false }, 0).verdict).toBe("better");
  });

  it("matches scope patterns", () => {
    expect(matchesAny("src/a/b.py", ["src/"])).toBe(true);
    expect(matchesAny("src/a/b.py", ["src/**/*.py"])).toBe(true);
    expect(matchesAny("solver.py", ["*.py"])).toBe(true);
    expect(matchesAny("lib/solver.py", ["*.py"])).toBe(false);
    expect(scopeViolations(["solver.py", "eval/x.py", "README.md"], ["*.py"], ["eval/"])).toEqual({ protectedTouched: ["eval/x.py"], outOfScope: ["README.md"] });
  });
});
