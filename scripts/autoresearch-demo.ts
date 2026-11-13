// Set up the AutoResearch demo repository.
//
//   npx tsx scripts/autoresearch-demo.ts [--dir <path>] [--reset] [--register]
//
// Copies examples/autoresearch-demo to <dir> (default data/demo/autoresearch-demo),
// makes it a git repository with one commit, and with --register adds it to T3
// as a project (t3_project_create), so research runs can use it. T3 0.1.7 allows that
// only for full-access clients; otherwise add the folder in T3 yourself.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CALLBACK_URL, CREDENTIALS_FILE, DATA_DIR } from "../server/config.js";
import { ensureDemoRepo } from "../server/research/demo.js";
import { T3Connection, resolveT3McpUrl } from "../server/t3/connection.js";

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const dirArg = args.indexOf("--dir");
const dir = path.resolve(dirArg >= 0 ? args[dirArg + 1] : path.join(DATA_DIR, "demo", "autoresearch-demo"));
const head = () => execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

if (fs.existsSync(dir) && flag("--reset")) {
  // Only ever remove the demo copy this script created.
  if (!fs.existsSync(path.join(dir, ".autoresearch-demo"))) throw new Error(`${dir} was not created by this script; not removing it.`);
  fs.rmSync(dir, { recursive: true, force: true });
}
const existed = fs.existsSync(path.join(dir, ".git"));
ensureDemoRepo(dir);
console.log(`${existed ? "Using existing" : "Created"} ${dir} at ${head()}`);

if (flag("--register")) {
  const conn = new T3Connection(resolveT3McpUrl(), CREDENTIALS_FILE, CALLBACK_URL);
  const st = await conn.connect();
  if (st.kind !== "connected") throw new Error(`Team Room is not signed in to T3 (${st.kind}). Start Team Room and approve it first.`);
  const list: any = await conn.call("t3_project_list", { limit: 100 });
  const existing = (list.projects ?? []).find((p: any) => path.resolve(p.workspaceRoot) === dir);
  if (existing) console.log(`Already a T3 project: ${existing.title} (${existing.id})`);
  else {
    try {
      const p: any = await conn.call("t3_project_create", { title: "AutoResearch demo", workspaceRoot: dir });
      console.log(`Registered T3 project ${p.project?.id ?? p.projectId ?? JSON.stringify(p)}`);
    } catch (err) {
      // T3 0.1.7 lets only full-access clients create projects; Team Room usually runs Supervised.
      console.log(`T3 did not register it (${(err as Error).message}).\nAdd it yourself in T3: Add project → choose ${dir}`);
    }
  }
  await conn.close?.();
}
