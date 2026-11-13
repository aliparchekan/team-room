// Controller behavior against an in-memory T3 stand-in. These tests prove the
// room logic; they are not evidence that the live T3 integration works.
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { setLeadName } from "../shared/digest.js";

// Agents in these fixtures address the lead by name.
beforeAll(() => setLeadName("Ali"));
afterAll(() => setLeadName(null));
import { Store } from "../server/store.js";
import { RoomController } from "../server/controller.js";
import { FakeT3Adapter } from "../server/t3/fakeAdapter.js";
import { LocalWork } from "../server/local/work.js";
import { T3ToolError } from "../server/t3/connection.js";
import type { AgentKind } from "../shared/types.js";

const agents = [
  { providerInstanceId: "claudeAgent", model: "fixture-claude" },
  { providerInstanceId: "codex", model: "fixture-codex" },
];

let store: Store;
let t3: FakeT3Adapter;
let ctl: RoomController;

beforeEach(() => {
  store = new Store(":memory:");
  t3 = new FakeT3Adapter();
  ctl = new RoomController(store, t3);
});

async function newRoom(mode: "manual" | "auto" = "manual", turnLimit = 6) {
  return ctl.createRoom({ title: "Cache design", brief: "Design a cache.", projectId: "p1", projectTitle: "P", mode, turnLimit, agents });
}
const thread = (roomId: string, k: AgentKind) => store.participantByKind(roomId, k)!.threadId!;
const sentTo = (roomId: string, k: AgentKind) => t3.sendCalls.filter((s) => s.threadId === thread(roomId, k));

describe("setup", () => {
  it("creates one persistent T3 thread per agent and maps it", async () => {
    const room = await newRoom();
    const ps = store.participants(room.id);
    expect(ps.map((p) => p.kind).sort()).toEqual(["claude", "codex"]);
    expect(new Set(ps.map((p) => p.threadId)).size).toBe(2);
    expect(store.room(room.id)!.status).toBe("idle");
  });
});

describe("permissions", () => {
  it("starts agent threads in the room's permission mode, Supervised by default", async () => {
    const room = await newRoom();
    expect(store.room(room.id)!.permissionMode).toBe("approval-required");
    expect(t3.launchInputs.every((l) => l.runtimeMode === "approval-required")).toBe(true);
    t3.launchInputs = [];
    const r2 = await ctl.createRoom({ title: "x", brief: "y", projectId: null, projectTitle: null, mode: "manual", permissionMode: "auto-accept-edits", agents });
    expect(store.room(r2.id)!.permissionMode).toBe("auto-accept-edits");
    expect(t3.launchInputs.map((l) => l.runtimeMode)).toEqual(["auto-accept-edits", "auto-accept-edits"]);
  });

  it("refuses a mode above the access level T3 granted Team Room", async () => {
    t3.maxPermission = "approval-required";
    await expect(
      ctl.createRoom({ title: "x", brief: "y", projectId: null, projectTitle: null, mode: "manual", permissionMode: "full-access", agents }),
    ).rejects.toThrow(/up to Supervised/);
    expect(t3.launchInputs).toHaveLength(0);
  });
});

describe("routing", () => {
  it("@codex goes only to Codex and is recorded as a direct human instruction", async () => {
    const room = await newRoom();
    const msg = await ctl.postHumanMessage(room.id, { body: "@codex what do you think?" });
    expect(msg.recipients).toEqual(["codex"]);
    expect(sentTo(room.id, "codex")).toHaveLength(1);
    expect(sentTo(room.id, "claude")).toHaveLength(0);
    expect(sentTo(room.id, "codex")[0].message).toContain("Instruction from the human lead, addressed to you");
    expect(store.message(msg.id)!.deliveryState).toBe("delivered");
  });

  it("@all reaches both agents; a room note reaches nobody until the next turn", async () => {
    const room = await newRoom();
    await ctl.postHumanMessage(room.id, { body: "Keep it under 100 lines.", target: "room" });
    expect(t3.sendCalls).toHaveLength(0);
    await ctl.postHumanMessage(room.id, { body: "@all go" });
    expect(sentTo(room.id, "claude")).toHaveLength(1);
    expect(sentTo(room.id, "codex")).toHaveLength(1);
    // The earlier note travels with the next turn, labelled as a note.
    expect(sentTo(room.id, "claude")[0].message).toContain("Keep it under 100 lines.");
    expect(sentTo(room.id, "claude")[0].message).toContain("no reply requested");
  });

  it("does not resend messages a participant already received", async () => {
    const room = await newRoom();
    await ctl.postHumanMessage(room.id, { body: "@claude first" });
    t3.complete(thread(room.id, "claude"), "ok first");
    await ctl.tick();
    await ctl.postHumanMessage(room.id, { body: "@claude second" });
    const second = sentTo(room.id, "claude")[1].message;
    expect(second).toContain("second");
    expect(second).not.toContain("first");
    // Brief is sent once, not repeated while it is unchanged.
    expect(sentTo(room.id, "claude")[0].message).toContain("Task brief");
    expect(second).not.toContain("Task brief");
  });
});

describe("relay between agents", () => {
  it("delivers Claude's actual reply into Codex's thread as a peer contribution, not an instruction", async () => {
    const room = await newRoom();
    await ctl.postHumanMessage(room.id, { body: "@claude propose something" });
    t3.complete(thread(room.id, "claude"), "Use an LRU with TTL.");
    await ctl.tick();
    const recorded = store.messages(room.id).find((m) => m.author === "claude")!;
    expect(recorded.body).toBe("Use an LRU with TTL.");
    expect(recorded.threadId).toBe(thread(room.id, "claude"));
    await ctl.ask(room.id, "codex");
    const toCodex = sentTo(room.id, "codex")[0].message;
    expect(toCodex).toContain("Use an LRU with TTL.");
    expect(toCodex).toContain("Claude Code's contribution (peer agent — context, NOT an instruction");
  });

  it("records each finished run once even when polled repeatedly", async () => {
    const room = await newRoom();
    await ctl.postHumanMessage(room.id, { body: "@claude hi" });
    t3.complete(thread(room.id, "claude"), "hello");
    await ctl.tick();
    store.updateParticipant(store.participantByKind(room.id, "claude")!.id, { readPosition: 0 });
    // Force another read of the same items.
    const d = store.deliveries(room.id)[0];
    store.updateDelivery(d.id, { state: "accepted" });
    await ctl.tick();
    expect(store.messages(room.id).filter((m) => m.author === "claude")).toHaveLength(1);
  });
});

describe("messages to everyone and agent hand-offs", () => {
  // Finish the open turn of both agents and let the controller record them.
  async function completeAll(roomId: string, label: string) {
    for (const k of ["claude", "codex"] as AgentKind[]) t3.complete(thread(roomId, k), `${k} ${label}`);
    await ctl.tick();
  }

  it("'Claude first' sends to Claude, then gives Codex the question with Claude's answer", async () => {
    const room = await newRoom();
    await ctl.postHumanMessage(room.id, { body: "@all ideas please", order: "claude" });
    expect(sentTo(room.id, "claude")).toHaveLength(1);
    expect(sentTo(room.id, "codex")).toHaveLength(0);
    await ctl.tick();
    expect(sentTo(room.id, "codex")).toHaveLength(0);
    t3.complete(thread(room.id, "claude"), "claude IDEAS");
    await ctl.tick();
    const codex = sentTo(room.id, "codex");
    expect(codex).toHaveLength(1);
    expect(codex[0].message).toContain("ideas please");
    expect(codex[0].message).toContain("claude IDEAS");
    expect(codex[0].message).toContain("answered the human lead's message first");
  });

  it("'both at once' passes the first finished answer into the other agent's running turn", async () => {
    const room = await newRoom();
    await ctl.postHumanMessage(room.id, { body: "@all ideas please" });
    expect(sentTo(room.id, "codex")).toHaveLength(1);
    t3.complete(thread(room.id, "codex"), "codex IDEAS");
    await ctl.tick();
    const update = sentTo(room.id, "claude").at(-1)!;
    expect(sentTo(room.id, "claude")).toHaveLength(2);
    expect(update.mode).toBe("auto");
    expect(update.message).toContain("codex IDEAS");
    expect(update.message).toContain("finished its answer to the same message first");
    // The second finisher does not bounce anything back.
    t3.complete(thread(room.id, "claude"), "claude IDEAS");
    await ctl.tick();
    expect(sentTo(room.id, "codex")).toHaveLength(1);
    expect(store.room(room.id)!.status).toBe("idle");
  });

  it("an agent's @mention of the other agent is handed over, up to the chain limit", async () => {
    const room = await newRoom();
    await ctl.postHumanMessage(room.id, { body: "@claude plan?" });
    let turn = 0;
    let author: AgentKind = "claude";
    // Each reply asks the other agent; the room hands over peerLimit (default 3) times, then waits.
    for (; turn < 5; turn++) {
      const peer: AgentKind = author === "claude" ? "codex" : "claude";
      t3.complete(thread(room.id, author), `${author} says @${peer} thoughts? (${turn})`);
      await ctl.tick();
      const last = t3.sendCalls.at(-1)!;
      if (last.threadId !== thread(room.id, peer)) break;
      expect(last.message).toContain(`addressed you directly above (@${peer})`);
      author = peer;
    }
    expect(turn).toBe(3);
    expect(store.deliveries(room.id, "purpose='peer_question'")).toHaveLength(3);
    expect(store.messages(room.id).at(-1)!.body).toMatch(/handed questions to each other 3 times/);
    // A new human message resets the chain.
    await ctl.postHumanMessage(room.id, { body: "@claude go on" });
    t3.complete(thread(room.id, "claude"), "@codex check this");
    await ctl.tick();
    expect(t3.sendCalls.at(-1)!.threadId).toBe(thread(room.id, "codex"));
  });

  it("uses the room's own hand-off limit, which can be changed or turned off", async () => {
    const room = await newRoom();
    expect(room.peerLimit).toBe(3);
    await expect(ctl.setPeerLimit(room.id, 21)).rejects.toThrow(/0–20/);
    await ctl.setPeerLimit(room.id, 1);
    await ctl.postHumanMessage(room.id, { body: "@claude plan?" });
    t3.complete(thread(room.id, "claude"), "@codex thoughts?");
    await ctl.tick();
    expect(sentTo(room.id, "codex")).toHaveLength(1);
    t3.complete(thread(room.id, "codex"), "@claude and you?");
    await ctl.tick();
    expect(sentTo(room.id, "claude")).toHaveLength(1);
    expect(store.messages(room.id).at(-1)!.body).toMatch(/1 time since your last message/);

    const off = await ctl.createRoom({ title: "Off", brief: "b", projectId: "p1", projectTitle: "P", mode: "manual", peerLimit: 0, agents });
    await ctl.postHumanMessage(off.id, { body: "@claude plan?" });
    t3.complete(thread(off.id, "claude"), "@codex thoughts?");
    await ctl.tick();
    expect(sentTo(off.id, "codex")).toHaveLength(0);
    expect(store.messages(off.id).at(-1)!.body).toMatch(/hand-offs between agents are off/);
  });

  it("keeps handing over @mentions after a plan is approved", async () => {
    const room = await newRoom();
    await ctl.approvePlan(room.id, { body: "Build the thing." });
    await ctl.postHumanMessage(room.id, { body: "@claude who does which part?" });
    t3.complete(thread(room.id, "claude"), "I'll take the connector. @codex does that split work?");
    await ctl.tick();
    const last = t3.sendCalls.at(-1)!;
    expect(last.threadId).toBe(thread(room.id, "codex"));
    expect(last.message).toContain("does that split work?");
  });

  it("a revised plan replaces the approved one when no task is running", async () => {
    const room = await newRoom();
    await ctl.approvePlan(room.id, { body: "Plan A" });
    await ctl.approvePlan(room.id, { body: "Plan B" });
    const plans = store.decisions(room.id).filter((d) => d.kind === "approved_plan");
    expect(plans.map((d) => [d.body, d.active])).toEqual([
      ["Plan A", false],
      ["Plan B", true],
    ]);
    expect(store.messages(room.id).at(-1)!.body).toMatch(/Revised plan approved/);
    await ctl.startImplementation(room.id, { implementer: "claude", title: "t", spec: "s" });
    await expect(ctl.approvePlan(room.id, { body: "Plan C" })).rejects.toThrow(/task is still running/);
  });

  it("hands over an @mention while the automatic round is paused for the human's message", async () => {
    const room = await newRoom("auto");
    await ctl.startAuto(room.id);
    // An earlier message pauses the round mid-proposal; the proposals then finish.
    await ctl.postHumanMessage(room.id, { body: "@claude keep it short" });
    await completeAll(room.id, "proposal");
    expect(store.room(room.id)!.status).toBe("paused");
    await ctl.postHumanMessage(room.id, { body: "@claude give your recommendations to codex" });
    t3.complete(thread(room.id, "claude"), "@codex here is my shortlist");
    await ctl.tick();
    const last = t3.sendCalls.at(-1)!;
    expect(last.threadId).toBe(thread(room.id, "codex"));
    expect(last.message).toContain("here is my shortlist");
  });

  it("holds a hand-off when the human pressed Pause, and says so", async () => {
    const room = await newRoom();
    await ctl.postHumanMessage(room.id, { body: "@claude plan?" });
    await ctl.pause(room.id);
    t3.complete(thread(room.id, "claude"), "@codex check this");
    await ctl.tick();
    expect(sentTo(room.id, "codex")).toHaveLength(0);
    expect(store.deliveries(room.id, "purpose='peer_question'")[0].state).toBe("held");
    expect(store.messages(room.id).at(-1)!.body).toMatch(/passed on when you resume/);
  });

  it("does not hand over @mentions made during the automatic round", async () => {
    const room = await newRoom("auto");
    await ctl.startAuto(room.id);
    for (const k of ["claude", "codex"] as AgentKind[]) t3.complete(thread(room.id, k), `${k} proposal, @${k === "claude" ? "codex" : "claude"} agree?`);
    await ctl.tick();
    expect(store.deliveries(room.id, "purpose='peer_question'")).toHaveLength(0);
  });
});

describe("bounded automatic mode", () => {
  async function completeBoth(roomId: string, text: (k: AgentKind) => string) {
    for (const k of ["claude", "codex"] as AgentKind[]) t3.complete(thread(roomId, k), text(k));
    await ctl.tick();
  }

  it("runs blind proposals, cross-critiques, responses, then pauses for the human", async () => {
    const room = await newRoom("auto");
    await ctl.startAuto(room.id);
    // Blind: each proposal request contains no peer proposal.
    expect(sentTo(room.id, "claude")[0].message).not.toContain("peer agent");
    expect(sentTo(room.id, "codex")[0].message).not.toContain("peer agent");
    await completeBoth(room.id, (k) => `${k} PROPOSAL`);
    // Critique step: each receives the other's real proposal.
    expect(sentTo(room.id, "codex")[1].message).toContain("claude PROPOSAL");
    expect(sentTo(room.id, "claude")[1].message).toContain("codex PROPOSAL");
    expect(sentTo(room.id, "codex")[1].message).not.toContain("codex PROPOSAL");
    await completeBoth(room.id, (k) => `${k} CRITIQUE`);
    expect(sentTo(room.id, "claude")[2].message).toContain("codex CRITIQUE");
    await completeBoth(room.id, (k) => `${k} RESPONSE\n## Agreements\n- LRU\n## Disagreements\n- TTL size\n## Questions for the lead\n- Budget?`);
    const r = store.room(room.id)!;
    expect(r.status).toBe("awaiting_decision");
    expect(r.turnsUsed).toBe(6);
    expect(t3.sendCalls).toHaveLength(6);
    const view = ctl.view(room.id);
    expect(view.summary!.proposals).toHaveLength(2);
    expect(view.summary!.sections[0].questions).toEqual(["Budget?"]);
    expect(store.messages(room.id).filter((m) => m.kind === "proposal")).toHaveLength(2);
  });

  it("enforces the turn limit", async () => {
    const room = await newRoom("auto", 4);
    await ctl.startAuto(room.id);
    await completeBoth(room.id, () => "p");
    await completeBoth(room.id, () => "c");
    const r = store.room(room.id)!;
    expect(r.status).toBe("awaiting_decision");
    expect(r.turnsUsed).toBe(4);
    expect(t3.sendCalls).toHaveLength(4);
    await ctl.continueDiscussion(room.id);
    expect(t3.sendCalls).toHaveLength(4);
    expect(store.room(room.id)!.statusDetail).toMatch(/Turn limit/);
  });

  it("human intervention pauses automatic advancement and is delivered first", async () => {
    const room = await newRoom("auto");
    await ctl.startAuto(room.id);
    await ctl.postHumanMessage(room.id, { body: "@codex prefer Redis" });
    expect(store.room(room.id)!.status).toBe("paused");
    // Delivered right away (steered into the running turn), not held.
    const codexSends = sentTo(room.id, "codex");
    expect(codexSends.at(-1)!.message).toContain("prefer Redis");
    expect(codexSends.at(-1)!.mode).toBe("auto");
    await completeBoth(room.id, (k) => `${k} PROPOSAL`);
    // No critique step scheduled while paused.
    expect(t3.sendCalls.filter((s) => s.message.includes("Critique"))).toHaveLength(0);
    await ctl.continueDiscussion(room.id);
    expect(t3.sendCalls.filter((s) => s.message.includes("Critique"))).toHaveLength(2);
  });

  it("keeps proposals blind even when a peer's earlier reply is already in the room", async () => {
    const room = await newRoom("auto");
    // The human asks everyone first, then starts the round before either reply lands.
    await ctl.postHumanMessage(room.id, { body: "@all look around first" });
    await ctl.startAuto(room.id);
    t3.complete(thread(room.id, "claude"), "claude SURVEY");
    await ctl.tick();
    t3.complete(thread(room.id, "claude"), "claude PROPOSAL");
    await ctl.tick();
    t3.complete(thread(room.id, "codex"), "codex SURVEY");
    await ctl.tick();
    const codexProposal = sentTo(room.id, "codex").at(-1)!.message;
    expect(codexProposal).toContain("initial proposal");
    expect(codexProposal).not.toContain("claude SURVEY");
    expect(codexProposal).not.toContain("claude PROPOSAL");
    // What was held back arrives with the critique turn.
    t3.complete(thread(room.id, "codex"), "codex PROPOSAL");
    await ctl.tick();
    const codexCritique = sentTo(room.id, "codex").at(-1)!.message;
    expect(codexCritique).toContain("Critique Claude Code's proposal");
    expect(codexCritique).toContain("claude PROPOSAL");
    // Claude's survey answered the same @all message, so it was passed into Codex's running reply instead.
    expect(sentTo(room.id, "codex").some((s) => s.message.includes("claude SURVEY") && s.message.includes("same message first"))).toBe(true);
  });

  it("repeats the proposal under critique when the critic already received it", async () => {
    const room = await newRoom("auto");
    await ctl.startAuto(room.id);
    await ctl.pause(room.id);
    await completeBoth(room.id, (k) => `${k} PROPOSAL`);
    // A manual question relays Claude's proposal to Codex before the critique step.
    await ctl.postHumanMessage(room.id, { body: "@codex thoughts?" });
    expect(sentTo(room.id, "codex").at(-1)!.message).toContain("claude PROPOSAL");
    t3.complete(thread(room.id, "codex"), "codex THOUGHTS");
    await ctl.tick();
    await ctl.continueDiscussion(room.id);
    const critique = sentTo(room.id, "codex").find((s) => s.message.includes("Critique Claude Code's proposal"))!.message;
    expect(critique).toContain("Proposals to critique");
    expect(critique).toContain("claude PROPOSAL");
  });

  it("a human message steered into a running turn asks the agent to finish that turn too", async () => {
    const room = await newRoom("auto");
    await ctl.startAuto(room.id);
    await ctl.postHumanMessage(room.id, { body: "@codex prefer Redis" });
    const steered = sentTo(room.id, "codex").at(-1)!.message;
    expect(steered).toContain("while you were working on your initial proposal");
    expect(steered).toContain("still finish that task");
  });

  it("asks agents to engage with the peer's contribution in ordinary replies", async () => {
    const room = await newRoom();
    await ctl.postHumanMessage(room.id, { body: "@claude idea?" });
    t3.complete(thread(room.id, "claude"), "claude IDEA");
    await ctl.tick();
    await ctl.postHumanMessage(room.id, { body: "@codex your view?" });
    const msg = sentTo(room.id, "codex").at(-1)!.message;
    expect(msg).toContain("claude IDEA");
    expect(msg).toContain("engage with it directly");
  });

  it("queues (and reports) a human message to a busy agent whose turn cannot be steered", async () => {
    const room = await newRoom("auto");
    await ctl.startAuto(room.id);
    // Make Codex's run not steerable: mark it queued-only.
    const th = t3.threads.get(thread(room.id, "codex"))!;
    th.runs[0].status = "starting";
    const msg = await ctl.postHumanMessage(room.id, { body: "@codex add metrics" });
    expect(store.message(msg.id)!.deliveryState).toBe("queued");
    expect(store.participantByKind(room.id, "codex")!.statusDetail).toMatch(/queued/i);
  });
});

describe("pause vs stop", () => {
  it("pause stops scheduling but lets running turns finish and records them", async () => {
    const room = await newRoom("auto");
    await ctl.startAuto(room.id);
    await ctl.pause(room.id);
    expect(t3.interrupts).toHaveLength(0);
    for (const k of ["claude", "codex"] as AgentKind[]) t3.complete(thread(room.id, k), `${k} P`);
    await ctl.tick();
    expect(store.messages(room.id).filter((m) => m.kind === "proposal")).toHaveLength(2);
    expect(t3.sendCalls).toHaveLength(2);
    expect(store.room(room.id)!.status).toBe("paused");
  });

  it("stop requests interruption and only reports stopped once T3 shows it", async () => {
    const room = await newRoom("auto");
    await ctl.startAuto(room.id);
    await ctl.stop(room.id);
    expect(t3.interrupts.sort()).toEqual([thread(room.id, "claude"), thread(room.id, "codex")].sort());
    expect(store.room(room.id)!.status).toBe("stopping");
    await ctl.tick();
    expect(store.room(room.id)!.status).toBe("stopping"); // still running in T3
    t3.finishInterrupt(thread(room.id, "claude"));
    t3.finishInterrupt(thread(room.id, "codex"));
    await ctl.tick();
    expect(store.room(room.id)!.status).toBe("paused");
    expect(store.participantByKind(room.id, "claude")!.status).toBe("stopped");
    expect(t3.sendCalls).toHaveLength(2);
  });
});

describe("restart recovery and duplicate delivery", () => {
  it("a crash mid-send becomes uncertain, pauses, and reconciles with the same request id", async () => {
    const room = await newRoom();
    t3.failNextSend = new T3ToolError("t3_thread_send", "transport_error", "socket hang up");
    await ctl.postHumanMessage(room.id, { body: "@claude hello" });
    const d = store.deliveries(room.id)[0];
    expect(d.state).toBe("uncertain");
    expect(store.room(room.id)!.status).toBe("needs_attention");
    expect(t3.sendCalls).toHaveLength(1);
    // A fresh controller (restart) on the same database does not resend on its own.
    const ctl2 = new RoomController(store, t3);
    await ctl2.recoverOnStartup();
    await ctl2.tick();
    expect(t3.sendCalls).toHaveLength(1);
    await ctl2.resume(room.id);
    expect(t3.sendCalls).toHaveLength(2);
    expect(t3.sendCalls[1].clientRequestId).toBe(d.id);
    expect(store.delivery(d.id)!.state).toBe("accepted");
  });

  it("restart does not duplicate participants, deliveries, or recorded replies", async () => {
    const room = await newRoom("auto");
    await ctl.startAuto(room.id);
    store.updateDelivery(store.deliveries(room.id)[0].id, { state: "sending" }); // crashed here
    const ctl2 = new RoomController(store, t3);
    await ctl2.recoverOnStartup();
    expect(store.room(room.id)!.status).toBe("needs_attention");
    await ctl2.resume(room.id); // replays with the same id: fake returns prior result
    expect(t3.threads.size).toBe(2);
    expect(store.participants(room.id)).toHaveLength(2);
    for (const k of ["claude", "codex"] as AgentKind[]) t3.complete(thread(room.id, k), `${k} P`);
    await ctl2.tick();
    await ctl2.tick();
    expect(store.messages(room.id).filter((m) => m.kind === "proposal")).toHaveLength(2);
    // Replay hit T3's idempotency (same clientRequestId), no third proposal run.
    expect(new Set(t3.sendCalls.map((s) => s.clientRequestId)).size).toBe(t3.sends.size);
  });

  it("relaunching setup reuses the same launch request id", async () => {
    const room = await newRoom();
    const p = store.participantByKind(room.id, "claude")!;
    store.updateParticipant(p.id, { threadId: null });
    store.updateRoom(room.id, { status: "setting_up" });
    await ctl.tick();
    expect(store.participantByKind(room.id, "claude")!.threadId).toBe(p.threadId);
    expect(t3.threads.size).toBe(2);
  });
});

describe("approval into execution", () => {
  it("discussion does not authorize implementation; approval does, then review comes back", async () => {
    const room = await newRoom();
    await expect(ctl.startImplementation(room.id, { implementer: "claude", title: "Build", spec: "do it" })).rejects.toThrow(/Approve a plan/);
    await ctl.approvePlan(room.id, { body: "Use LRU." });
    const r = store.room(room.id)!;
    expect(r.phase).toBe("execution");
    expect(store.decisions(room.id).some((d) => d.kind === "approved_plan" && d.body === "Use LRU.")).toBe(true);

    await ctl.startImplementation(room.id, { implementer: "claude", title: "Build cache", spec: "Implement LRU", baseRef: "main" });
    const impl = store.tasks(room.id)[0];
    expect(impl.status).toBe("working");
    const assigned = store.messages(room.id).find((m) => m.meta.taskId === impl.id)!;
    expect(assigned.deliveryState).toBe("delivered"); // T3 accepted the launch
    const implThread = t3.threads.get(impl.threadId!)!;
    expect(implThread.runs[0].prompt).toContain("Use LRU."); // approved plan travels with the task
    expect(implThread.worktreePath).toBeTruthy();
    // Single writer: a second task is refused while one runs.
    await expect(ctl.startImplementation(room.id, { implementer: "codex", title: "x", spec: "y" })).rejects.toThrow(/One writer/);

    t3.complete(impl.threadId!, "Done.\n## Verification\n- npm test: 3 passed");
    await ctl.tick();
    const tasks = store.tasks(room.id);
    expect(tasks[0].status).toBe("completed");
    const review = tasks.find((t) => t.kind === "review")!;
    expect(review.ownerKind).toBe("codex");
    expect(t3.threads.get(review.threadId!)!.worktreePath).toBe(implThread.worktreePath);
    const report = store.messages(room.id).find((m) => m.kind === "implementation_report")!;
    expect(report.meta.verification).toContain("3 passed");

    t3.complete(review.threadId!, "## Verdict\napprove");
    await ctl.tick();
    expect(store.room(room.id)!.status).toBe("review_ready");
    expect(store.messages(room.id).some((m) => m.kind === "review" && m.author === "codex")).toBe(true);
  });

  const parts = { claude: "Build the connector", codex: "Build the image" };

  it("joint, taking turns: second part starts in the first part's worktree, then each reviews the other's part", async () => {
    const room = await newRoom();
    await ctl.approvePlan(room.id, { body: "Split plan." });
    await expect(
      ctl.startImplementation(room.id, { implementer: "codex", title: "Workspace", spec: "", strategy: "turns", parts: { claude: "x" } }),
    ).rejects.toThrow(/part for at least two agents/);
    await ctl.startImplementation(room.id, { implementer: "codex", first: "codex", title: "Workspace", spec: "", strategy: "turns", parts, baseRef: "main" });
    let [first, second] = store.tasks(room.id);
    expect([first.ownerKind, first.status, second.ownerKind, second.status]).toEqual(["codex", "working", "claude", "queued"]);
    const firstPrompt = t3.threads.get(first.threadId!)!.runs[0].prompt;
    expect(firstPrompt).toContain("You go first");
    expect(firstPrompt).toContain("Build the connector"); // knows the partner's part, as context

    t3.complete(first.threadId!, "Image built.\n## Verification\n- docker build ok");
    await ctl.tick();
    second = store.task(second.id)!;
    expect(second.status).toBe("working");
    first = store.task(first.id)!;
    expect(t3.threads.get(second.threadId!)!.worktreePath).toBe(first.worktreePath); // same worktree, one writer at a time
    expect(t3.threads.get(second.threadId!)!.runs[0].prompt).toContain("Image built.");
    expect(store.tasks(room.id).filter((t) => t.kind === "review")).toHaveLength(0);

    t3.complete(second.threadId!, "Connector built.");
    await ctl.tick();
    const reviews = store.tasks(room.id).filter((t) => t.kind === "review");
    expect(reviews.map((r) => [r.ownerKind, store.task(r.parentTaskId!)!.ownerKind]).sort()).toEqual([
      ["claude", "codex"],
      ["codex", "claude"],
    ]);
    t3.complete(reviews[0].threadId!, "## Verdict\napprove");
    await ctl.tick();
    expect(store.room(room.id)!.status).toBe("executing"); // the other review is still running
    t3.complete(reviews[1].threadId!, "## Verdict\nrequest changes");
    await ctl.tick();
    expect(store.room(room.id)!.status).toBe("review_ready");

    // Changes go to one part; that part alone is reviewed again.
    await ctl.requestChanges(room.id, "fix it", second.id);
    expect(t3.sendCalls.at(-1)!.threadId).toBe(second.threadId);
    t3.complete(second.threadId!, "Fixed.");
    await ctl.tick();
    const again = store.tasks(room.id).filter((t) => t.kind === "review");
    expect(again).toHaveLength(3);
    expect(store.task(again[2].parentTaskId!)!.id).toBe(second.id);
  });

  it("joint, taking turns: a failed first part stops the second from starting", async () => {
    const room = await newRoom();
    await ctl.approvePlan(room.id, { body: "Split plan." });
    await ctl.startImplementation(room.id, { implementer: "claude", title: "W", spec: "", strategy: "turns", parts, baseRef: "main" });
    const [first, second] = store.tasks(room.id);
    t3.complete(first.threadId!, "broke", undefined, "failed");
    await ctl.tick();
    expect(store.task(second.id)!.status).toBe("stopped");
    expect(store.room(room.id)!.status).toBe("needs_attention");
  });

  it("joint, in parallel: both start at once in separate worktrees, and each part is reviewed by the other agent", async () => {
    const room = await newRoom();
    await ctl.approvePlan(room.id, { body: "Split plan." });
    await ctl.startImplementation(room.id, { implementer: "claude", title: "W", spec: "", strategy: "parallel", parts, baseRef: "main" });
    const impls = store.tasks(room.id);
    expect(impls.map((t) => t.status)).toEqual(["working", "working"]);
    const [a, b] = impls.map((t) => t3.threads.get(t.threadId!)!.worktreePath);
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
    expect(t3.threads.get(impls[0].threadId!)!.runs[0].prompt).toContain("at the same time, each in a separate workspace");

    t3.complete(impls[0].threadId!, "Part A done.");
    await ctl.tick();
    const review = store.tasks(room.id).find((t) => t.kind === "review")!;
    expect(review.ownerKind).toBe("codex");
    expect(t3.threads.get(review.threadId!)!.worktreePath).toBe(a);
  });

  it("a room can raise agent permissions for the threads it starts from now on, within T3's cap", async () => {
    const room = await newRoom();
    expect(room.permissionMode).toBe("approval-required");
    await expect(ctl.setPermissionMode(room.id, "full-access")).rejects.toThrow(/up to Auto-accept edits/);
    await ctl.setPermissionMode(room.id, "auto-accept-edits");
    expect(store.messages(room.id).at(-1)!.body).toMatch(/discussion threads keep Supervised/);
    await ctl.approvePlan(room.id, { body: "Plan" });
    await ctl.startImplementation(room.id, { implementer: "codex", title: "t", spec: "s", baseRef: "main" });
    expect(t3.launchInputs.at(-1)!.runtimeMode).toBe("auto-accept-edits");
  });

  it("moves an agent to a new thread with new permissions, carrying the record and its handoff note", async () => {
    const room = await newRoom();
    await ctl.postHumanMessage(room.id, { body: "@codex check the Dockerfile" });
    t3.complete(thread(room.id, "codex"), "The base image lacks AT-SPI.");
    await ctl.tick();
    const oldThread = thread(room.id, "codex");
    await expect(ctl.transferAgents(room.id, { mode: "full-access", agents: ["codex"], handoff: true })).rejects.toThrow(/up to Auto-accept edits/);

    await ctl.transferAgents(room.id, { mode: "auto-accept-edits", agents: ["codex"], handoff: true });
    const ask = t3.sendCalls.at(-1)!;
    expect(ask.threadId).toBe(oldThread);
    expect(ask.message).toContain("Write a handoff note");
    expect(store.participantByKind(room.id, "codex")!.transfer?.mode).toBe("auto-accept-edits");
    expect(store.room(room.id)!.permissionMode).toBe("auto-accept-edits");

    t3.complete(oldThread, "## Handoff\n- Read harness/Dockerfile: no gir1.2-atspi-2.0.\n- Next: add it and rebuild.");
    await ctl.tick();
    const codex = store.participantByKind(room.id, "codex")!;
    expect(codex.threadId).not.toBe(oldThread);
    expect(codex.transfer).toBeNull();
    expect(codex.threadMode).toBe("auto-accept-edits");
    expect(codex.previousThreads).toEqual([expect.objectContaining({ threadId: oldThread, mode: "approval-required" })]);
    expect(t3.renames).toEqual([{ threadId: oldThread, title: "Cache design — Codex (earlier thread, ended)" }]); // not confused with the new one in T3
    const launch = t3.launchInputs.at(-1)!;
    expect(launch.runtimeMode).toBe("auto-accept-edits");
    expect(launch.message).toContain("no gir1.2-atspi-2.0"); // its own handoff note
    expect(launch.message).toContain("Design a cache."); // the brief
    expect(launch.message).toContain("The base image lacks AT-SPI."); // the transcript
    expect(store.messages(room.id).some((m) => m.kind === "handoff" && m.author === "codex")).toBe(true);

    // Its acknowledgement is posted to the room, and later messages go to the new thread only.
    t3.complete(codex.threadId!, "Caught up. Next: add AT-SPI to the image.");
    await ctl.tick();
    expect(store.messages(room.id).filter((m) => m.author === "codex").at(-1)!.body).toContain("Caught up");
    await ctl.postHumanMessage(room.id, { body: "@codex go ahead" });
    expect(t3.sendCalls.at(-1)!.threadId).toBe(codex.threadId);
    // Claude was not moved.
    expect(store.participantByKind(room.id, "claude")!.previousThreads).toHaveLength(0);
  });

  it("collects the agents' questions for the human, and answers them in one message per send", async () => {
    // Without a local model the rules find the questions.
    const local = new LocalWork(store, { status: async () => ({ available: false, model: null, detail: "off" }) } as any);
    ctl.onAgentMessage = (roomId, m) => local.onAgentMessage(roomId, m);
    const room = await newRoom();
    await ctl.postHumanMessage(room.id, { body: "@all plan it" });
    t3.complete(thread(room.id, "claude"), "## Questions for you\n- Should Step 1 run on this Mac or the server?\n- Which model should the agent use?");
    t3.complete(thread(room.id, "codex"), "@claude, could you check the image size?\n\nAli, do you want Docker limited to 2 CPUs?");
    await ctl.tick();
    await local.drain();
    let open = store.questions(room.id, "status='open'");
    expect(open.map((q) => [q.author, q.text])).toEqual([
      ["claude", "Should Step 1 run on this Mac or the server?"],
      ["claude", "Which model should the agent use?"],
      ["codex", "Ali, do you want Docker limited to 2 CPUs?"],
    ]); // Codex's question to Claude is not one for the human
    const [mac, model, cpus] = open;
    await ctl.dismissQuestion(room.id, model.id);
    const sendsBefore = t3.sendCalls.length;
    const answered = await ctl.answerQuestions(room.id, [
      { id: mac.id, text: "Run it on this Mac." },
      { id: cpus.id, text: "Yes, 2 CPUs." },
    ]);
    expect(answered.recipients).toEqual(["all"]);
    expect(answered.body).toContain("> Claude Code asked (#");
    expect(answered.body).toContain("Run it on this Mac.");
    expect(answered.body).toContain("**For Codex**");
    expect(t3.sendCalls.length - sendsBefore).toBeLessThanOrEqual(2); // one message, one turn per agent
    open = store.questions(room.id, "status='open'");
    expect(open).toHaveLength(0);
    expect(store.questions(room.id, "status='answered'").map((q) => q.answerSeq)).toEqual([answered.seq, answered.seq]);
    await expect(ctl.answerQuestions(room.id, [{ id: mac.id, text: "again" }])).rejects.toThrow(/at least one open question/);
  });

  it("keeps questions recent: answering some leaves the rest open, writing in the room closes older ones", async () => {
    const local = new LocalWork(store, { status: async () => ({ available: false, model: null, detail: "off" }) } as any);
    ctl.onAgentMessage = (roomId, m) => local.onAgentMessage(roomId, m);
    const room = await newRoom();
    await ctl.postHumanMessage(room.id, { body: "@claude plan it" });
    t3.complete(thread(room.id, "claude"), "## Questions for you\n- Mac or server?\n- Which model should the agent use?");
    await ctl.tick();
    await local.drain();
    const [where, model] = store.questions(room.id, "status='open'");
    await ctl.answerQuestions(room.id, [{ id: where.id, text: "The Mac." }]);
    expect(store.questions(room.id, "status='open'").map((q) => q.id)).toEqual([model.id]); // skipped one stays
    await ctl.postHumanMessage(room.id, { body: "@claude let's move on to the viewer" });
    expect(store.questions(room.id, "status='open'")).toHaveLength(0);
    expect(store.questions(room.id, "id=?", model.id)[0].status).toBe("expired");
    expect(ctl.view(room.id).questions.map((q) => q.status)).toEqual(["answered"]); // expired ones are not listed
  });

  it("an agent summary goes to the human only, is not a discussion turn, and starts no hand-offs", async () => {
    const room = await newRoom();
    await ctl.postHumanMessage(room.id, { body: "@all thoughts?" });
    t3.complete(thread(room.id, "claude"), "Claude's view.");
    t3.complete(thread(room.id, "codex"), "Codex's view.");
    await ctl.tick();
    // Let any follow-up turn (a peer update) finish, so the agent is free for the summary.
    for (const k of ["claude", "codex"] as AgentKind[]) t3.complete(thread(room.id, k), "Noted.");
    await ctl.tick();
    const msgs = store.messages(room.id);
    const from = msgs.find((m) => m.author === "human")!.seq + 1;
    const to = msgs.filter((m) => m.author !== "system").at(-1)!.seq;
    const lastAgent = msgs.filter((m) => m.author === "claude" || m.author === "codex").at(-1)!.author as AgentKind;
    await ctl.summarize(room.id, { from, to });
    await ctl.tick();
    const ask = t3.sendCalls.find((s) => s.message.includes("summary request"))!;
    expect(ask.threadId).toBe(thread(room.id, lastAgent));
    expect(ask.message).toContain("Claude's view.");
    expect(ask.message).toContain("Codex's view.");
    const turnsBefore = store.room(room.id)!.turnsUsed;
    t3.complete(thread(room.id, lastAgent), "## Agreed or decided\n- both views noted\n@claude @codex please continue");
    await ctl.tick();
    const summary = store.messages(room.id).find((m) => m.kind === "summary")!;
    expect(summary.recipients).toEqual(["human"]);
    expect(summary.meta.range).toEqual([from, to]);
    expect(store.room(room.id)!.turnsUsed).toBe(turnsBefore);
    expect(store.deliveries(room.id, "purpose='peer_question'")).toHaveLength(0); // its @mentions are not handed over
  });

  it("changes an agent's thinking level on its running thread and keeps it for new threads", async () => {
    const room = await ctl.createRoom({
      title: "T",
      brief: "b",
      projectId: "p1",
      projectTitle: "P",
      mode: "manual",
      agents: [{ providerInstanceId: "claudeAgent", model: "fixture-claude", options: { effort: "high" } }, { providerInstanceId: "codex", model: "fixture-codex" }],
    });
    expect(t3.launchInputs.find((l) => l.providerInstanceId === "claudeAgent")!.options).toEqual({ effort: "high" });
    await expect(ctl.setAgentOptions(room.id, "codex", { reasoningEffort: "extreme" })).rejects.toThrow(/one of low, medium, high/);
    await ctl.setAgentOptions(room.id, "codex", { reasoningEffort: "high" });
    expect(t3.configures.at(-1)).toEqual({ threadId: thread(room.id, "codex"), model: "fixture-codex", options: { reasoningEffort: "high" } });
    expect(store.participantByKind(room.id, "codex")!.options).toEqual({ reasoningEffort: "high" });
    expect(store.messages(room.id).at(-1)!.body).toMatch(/Codex: thinking high\. Applies from its next turn/);
    await ctl.transferAgents(room.id, { mode: "auto-accept-edits", agents: ["codex"], handoff: false });
    expect(t3.launchInputs.at(-1)!.options).toEqual({ reasoningEffort: "high" }); // a new thread keeps the setting
  });

  it("switches an agent's model on its running thread, keeping settings the new model offers", async () => {
    const room = await ctl.createRoom({
      title: "T",
      brief: "b",
      projectId: "p1",
      projectTitle: "P",
      mode: "manual",
      agents: [{ providerInstanceId: "claudeAgent", model: "fixture-claude", options: { effort: "high" } }, { providerInstanceId: "codex", model: "fixture-codex" }],
    });
    const provider = (t3.status().providers as any[]).find((p) => p.instanceId === "claudeAgent");
    provider.models.push({ slug: "fixture-claude-2", name: "Fixture 2", options: [{ id: "effort", values: ["low", "max"], default: "low" }] });
    await expect(ctl.setAgentModel(room.id, "claude", "no-such-model")).rejects.toThrow(/has no model/);
    await ctl.setAgentModel(room.id, "claude", "fixture-claude-2");
    expect(t3.configures.at(-1)).toEqual({ threadId: thread(room.id, "claude"), model: "fixture-claude-2", options: {} }); // "high" isn't offered
    const claude = store.participantByKind(room.id, "claude")!;
    expect([claude.model, claude.options]).toEqual(["fixture-claude-2", {}]);
    expect(store.messages(room.id).at(-1)!.body).toMatch(/now uses Fixture 2 \(its thinking level reset to the model's default\)/);
    provider.models.pop();
  });

  it("moving without a handoff note launches right away, and stops a busy agent first", async () => {
    const room = await newRoom();
    await ctl.postHumanMessage(room.id, { body: "@claude long task" });
    const old = thread(room.id, "claude");
    await ctl.transferAgents(room.id, { mode: "auto-accept-edits", agents: ["claude"], handoff: false });
    expect(t3.interrupts).toContain(old);
    const claude = store.participantByKind(room.id, "claude")!;
    expect(claude.threadId).not.toBe(old);
    expect(t3.launchInputs.at(-1)!.message).toContain("(none: you were moved without one)");
  });

  it("joint work in a project needs its own worktree, not the project checkout", async () => {
    const room = await newRoom();
    await ctl.approvePlan(room.id, { body: "Split plan." });
    await expect(ctl.startImplementation(room.id, { implementer: "claude", title: "W", spec: "", strategy: "parallel", parts })).rejects.toThrow(/needs a worktree/);
  });
});
