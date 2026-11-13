// Integration spike: sign in to T3's MCP endpoint, list the live tools and
// their schemas, and read projects/providers. Writes data/t3-tools.json.
//   npm run spike
import http from "node:http";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { T3Connection, resolveT3McpUrl } from "../server/t3/connection.js";
import { DATA_DIR, CREDENTIALS_FILE, CALLBACK_URL, PORT } from "../server/config.js";

const conn = new T3Connection(resolveT3McpUrl(), CREDENTIALS_FILE, CALLBACK_URL);
console.log("MCP URL:", conn.mcpUrl);

let state = await conn.connect();
if (state.kind === "needs_auth") {
  console.log("\nApprove Team Room in T3 (opening browser):\n", state.authorizationUrl, "\n");
  const code = await new Promise<string>((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", CALLBACK_URL);
      if (u.pathname !== "/oauth/callback") return res.end();
      const c = u.searchParams.get("code");
      res.end(c ? "Team Room is connected to T3. You can close this tab." : `Sign-in failed: ${u.searchParams.get("error")}`);
      srv.close();
      c ? resolve(c) : reject(new Error(u.searchParams.get("error") ?? "no code"));
    });
    srv.listen(PORT, "127.0.0.1");
    if (state.kind === "needs_auth" && state.authorizationUrl) execFile("open", [state.authorizationUrl]);
  });
  state = await conn.finishAuth(code);
}
console.log("state:", state);
if (state.kind !== "connected") process.exit(1);

const tools = await conn.listTools();
fs.writeFileSync(`${DATA_DIR}/t3-tools.json`, JSON.stringify(tools, null, 2));
console.log(`${tools.length} tools:`, tools.map((t) => t.name).join(", "));

for (const [name, args] of [
  ["t3_project_list", {}],
  ["orchestrator_capabilities", {}],
] as const) {
  try {
    const r = await conn.call(name, args);
    fs.writeFileSync(`${DATA_DIR}/spike-${name}.json`, JSON.stringify(r, null, 2));
    console.log(`\n== ${name}\n`, JSON.stringify(r, null, 2).slice(0, 4000));
  } catch (e: any) {
    console.log(`\n== ${name} FAILED`, e.code, e.message);
  }
}
await conn.close();
