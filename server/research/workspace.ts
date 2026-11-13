// Git isolation for AutoResearch. Every experiment gets its own worktree and
// branch under a run-owned namespace, created from a recorded commit. The
// user's own checkout is never written to; cleanup touches only paths and
// branches this run created.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_DIFF = 200_000;

export class GitError extends Error {}

const locks = new Map<string, Promise<unknown>>();

/** Serialize git operations per repository (worktree add/remove take repo-wide locks). */
function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(repo) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(repo, next.catch(() => {}));
  return next;
}

export function git(cwd: string, args: string[], opts: { maxBuffer?: number; allowFail?: boolean } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: opts.maxBuffer ?? 20 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) => {
      const code = err ? ((err as any).code ?? 1) : 0;
      if (err && !opts.allowFail) reject(new GitError(`git ${args.join(" ")} failed: ${String(stderr || err.message).trim()}`));
      else resolve({ stdout: String(stdout), stderr: String(stderr), code: typeof code === "number" ? code : 1 });
    });
  });
}

export async function repoRoot(dir: string): Promise<string> {
  const r = await git(dir, ["rev-parse", "--show-toplevel"], { allowFail: true });
  if (r.code !== 0) throw new GitError(`${dir} is not a git repository. AutoResearch needs one to isolate experiments in worktrees.`);
  return r.stdout.trim();
}

export async function resolveRef(repo: string, ref: string): Promise<string> {
  const r = await git(repo, ["rev-parse", "--verify", `${ref}^{commit}`], { allowFail: true });
  if (r.code !== 0) throw new GitError(`Cannot resolve "${ref}" to a commit in ${repo}.`);
  return r.stdout.trim();
}

/** Uncommitted changes in the user's checkout. They are not part of the baseline (and are never touched). */
export async function uncommitted(repo: string): Promise<string[]> {
  const r = await git(repo, ["status", "--porcelain"]);
  return r.stdout.split("\n").filter(Boolean).map((l) => l.slice(3));
}

export type Worktree = { path: string; branch: string; sha: string };

/** New worktree on a new run-owned branch, starting at `startSha`. */
export function createWorktree(repo: string, wtPath: string, branch: string, startSha: string): Promise<Worktree> {
  return withRepoLock(repo, async () => {
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    if (fs.existsSync(wtPath)) {
      // Recovery after a crash between "add" and recording it: reuse if it is ours and on the right branch.
      const head = await git(wtPath, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true });
      if (head.code === 0 && head.stdout.trim() === branch) return { path: wtPath, branch, sha: (await git(wtPath, ["rev-parse", "HEAD"])).stdout.trim() };
      throw new GitError(`${wtPath} already exists and is not this experiment's worktree.`);
    }
    const exists = (await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`], { allowFail: true })).code === 0;
    await git(repo, exists ? ["worktree", "add", wtPath, branch] : ["worktree", "add", "-b", branch, wtPath, startSha]);
    return { path: wtPath, branch, sha: (await git(wtPath, ["rev-parse", "HEAD"])).stdout.trim() };
  });
}

/** Commit everything the agent changed (Team Room's commit, on the experiment's own branch). Returns HEAD. */
export async function commitAll(wtPath: string, message: string): Promise<string> {
  await git(wtPath, ["add", "-A"]);
  const staged = await git(wtPath, ["diff", "--cached", "--quiet"], { allowFail: true });
  if (staged.code !== 0)
    await git(wtPath, ["-c", "user.name=Team Room AutoResearch", "-c", "user.email=autoresearch@team-room.local", "-c", "commit.gpgsign=false", "commit", "--no-verify", "-q", "-m", message]);
  return (await git(wtPath, ["rev-parse", "HEAD"])).stdout.trim();
}

export async function changedFiles(wtPath: string, from: string, to: string): Promise<string[]> {
  const r = await git(wtPath, ["diff", "--name-only", "--no-renames", from, to]);
  return r.stdout.split("\n").filter(Boolean);
}

export async function diffText(wtPath: string, from: string, to: string): Promise<string> {
  const r = await git(wtPath, ["diff", "--no-color", "--stat", "--patch", from, to]);
  return r.stdout.length > MAX_DIFF ? `${r.stdout.slice(0, MAX_DIFF)}\n… (diff truncated at ${MAX_DIFF} characters)` : r.stdout;
}

/** Discard any edits in a run-owned worktree and move it to `sha`. Never used on the user's checkout. */
export async function resetOwnedWorktree(wtPath: string, sha: string) {
  await git(wtPath, ["reset", "-q", "--hard", sha]);
  await git(wtPath, ["clean", "-q", "-fdx"]);
}

export function removeOwnedWorktree(repo: string, wtPath: string) {
  return withRepoLock(repo, async () => {
    const r = await git(repo, ["worktree", "remove", "--force", wtPath], { allowFail: true });
    if (r.code !== 0 && fs.existsSync(wtPath)) fs.rmSync(wtPath, { recursive: true, force: true });
    await git(repo, ["worktree", "prune"], { allowFail: true });
  });
}

export function deleteOwnedBranch(repo: string, branch: string, namespace: string) {
  if (!branch.startsWith(namespace)) throw new GitError(`Refusing to delete ${branch}: not owned by this run.`);
  return withRepoLock(repo, () => git(repo, ["branch", "-D", branch], { allowFail: true }));
}

/** Copy the protected evaluation files as they are at `sha` (never from a worktree an agent can edit). */
export async function snapshotPaths(repo: string, sha: string, paths: string[], dest: string): Promise<string[]> {
  fs.mkdirSync(dest, { recursive: true });
  const copied: string[] = [];
  for (const p of paths) {
    const list = await git(repo, ["ls-tree", "-r", "--name-only", sha, "--", p]);
    for (const file of list.stdout.split("\n").filter(Boolean)) {
      const blob = await new Promise<Buffer>((resolve, reject) =>
        execFile("git", ["show", `${sha}:${file}`], { cwd: repo, encoding: "buffer", maxBuffer: 50 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out))),
      );
      // $EVAL_DIR mirrors repo-relative paths: eval/evaluate.py -> $EVAL_DIR/eval/evaluate.py.
      const out = path.join(dest, file);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, blob);
      copied.push(file);
    }
  }
  return copied;
}

// ---------------------------------------------------------------- scope rules
function globToRegex(glob: string): RegExp {
  let g = glob.trim().replace(/^\.\//, "");
  if (g.endsWith("/")) g += "**";
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      re += ".*";
      i++;
      if (g[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    const clean = p.trim().replace(/^\.\//, "");
    if (!clean) return false;
    return globToRegex(clean).test(file) || file === clean || file.startsWith(`${clean.replace(/\/$/, "")}/`);
  });
}

/** Files that break the rules: protected paths, or anything outside the allowed scope. */
export function scopeViolations(files: string[], allowed: string[], protectedPaths: string[]) {
  return {
    protectedTouched: files.filter((f) => matchesAny(f, protectedPaths)),
    outOfScope: files.filter((f) => !matchesAny(f, protectedPaths) && allowed.length > 0 && !matchesAny(f, allowed)),
  };
}
