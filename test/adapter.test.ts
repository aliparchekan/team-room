// The live adapter's reading of T3 thread state, against a stand-in MCP connection.
import { describe, expect, it } from "vitest";
import { McpT3Adapter } from "../server/t3/adapter.js";

function adapterWith(activity: any[], status = "running") {
  const calls: any[] = [];
  const conn = {
    mcpUrl: "http://127.0.0.1:3773/mcp",
    state: { kind: "connected" },
    async call(tool: string, args: any) {
      calls.push({ tool, args });
      if (args.view === "activity") return { items: activity, recentRuns: [] };
      return {
        thread: { status, itemCount: 126, pendingRequestCount: 0 },
        recentRuns: [{ runId: "r8", ordinal: 8, status: status === "running" ? "running" : "completed" }],
        items: [],
        nextPosition: 126,
        hasMore: false,
      };
    },
  };
  return { adapter: new McpT3Adapter(conn as any), calls };
}

describe("approval detection", () => {
  it("reports an open approval_request from the activity timeline (T3 does not count it as a pending request)", async () => {
    const { adapter, calls } = adapterWith([
      { type: "approval_request", status: "completed", text: "docker ps" },
      { type: "command_execution", status: "running", text: "$ docker exec dd-cua ps" },
      { type: "approval_request", status: "pending", text: "docker exec dd-cua ps -eo pid,args" },
    ]);
    const snap = await adapter.readThread({ threadId: "t", afterPosition: null });
    expect(snap.hasPendingRequest).toBe(true);
    expect(snap.pendingDetail).toBe("Waiting for your approval in T3: docker exec dd-cua ps -eo pid,args");
    expect(calls.find((c) => c.args.view === "activity")!.args.afterPosition).toBe(114); // only the newest items
  });

  it("is not waiting when every approval is resolved, and does not look while the thread is idle", async () => {
    const resolved = adapterWith([{ type: "approval_request", status: "completed", text: "docker ps" }]);
    expect((await resolved.adapter.readThread({ threadId: "t", afterPosition: null })).hasPendingRequest).toBe(false);
    const idle = adapterWith([{ type: "approval_request", status: "pending", text: "stale" }], "idle");
    expect((await idle.adapter.readThread({ threadId: "t", afterPosition: null })).hasPendingRequest).toBe(false);
    expect(idle.calls.some((c) => c.args.view === "activity")).toBe(false);
  });
});
