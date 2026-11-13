// Rooms with more than two agents, from any provider T3 has enabled.
import { beforeEach, describe, expect, it } from "vitest";
import { RoomController } from "../server/controller.js";
import { parseMentions } from "../server/envelope.js";
import { Store } from "../server/store.js";
import { FakeT3Adapter } from "../server/t3/fakeAdapter.js";
import { assignHandles, type AgentKind } from "../shared/types.js";

let store: Store;
let t3: FakeT3Adapter;
let ctl: RoomController;

beforeEach(() => {
  store = new Store(":memory:");
  t3 = new FakeT3Adapter();
  ctl = new RoomController(store, t3);
});

const three = [
  { providerInstanceId: "claudeAgent", model: "fixture-claude" },
  { providerInstanceId: "codex", model: "fixture-codex" },
  { providerInstanceId: "grok", model: "fixture-grok" },
];
const newRoom = (agents = three, mode: "manual" | "auto" = "manual", turnLimit = 12) =>
  ctl.createRoom({ title: "Trio", brief: "Design a cache.", projectId: "p1", projectTitle: "P", mode, turnLimit, agents });
const thread = (roomId: string, k: AgentKind) => store.participantByKind(roomId, k)!.threadId!;
const sentTo = (roomId: string, k: AgentKind) => t3.sendCalls.filter((s) => s.threadId === thread(roomId, k));

describe("handles", () => {
  it("names agents by provider, numbering a second agent of the same provider", () => {
    expect(
      assignHandles([
        { driver: "claudeAgent", displayName: "Claude" },
        { driver: "claudeAgent", displayName: "Claude" },
        { driver: "grok", displayName: "Grok" },
      ]),
    ).toEqual([
      { handle: "claude", name: "Claude Code" },
      { handle: "claude2", name: "Claude Code 2" },
      { handle: "grok", name: "Grok" },
    ]);
    // A handle already used in the room (also by an agent that left) is not reused.
    expect(assignHandles([{ driver: "codex", displayName: "Codex" }], ["codex"])).toEqual([{ handle: "codex2", name: "Codex 2" }]);
  });

  it("parses mentions of the room's own handles only", () => {
    expect(parseMentions("@grok and @claude2, see ali@example.com and @nobody", ["claude", "claude2", "grok"]).sort()).toEqual(["claude2", "grok"]);
    expect(parseMentions("@everyone", ["claude"])).toEqual(["all"]);
  });
});

describe("a room of three", () => {
  it("creates a thread per agent with each provider, and refuses a provider T3 has not enabled", async () => {
    const room = await newRoom();
    expect(store.participants(room.id).map((p) => [p.kind, p.name, p.providerInstanceId])).toEqual([
      ["claude", "Claude Code", "claudeAgent"],
      ["codex", "Codex", "codex"],
      ["grok", "Grok (fixture)", "grok"],
    ]);
    expect(t3.launchInputs.map((l) => l.providerInstanceId)).toEqual(["claudeAgent", "codex", "grok"]);
    await expect(newRoom([...three, { providerInstanceId: "cursor", model: "x" }])).rejects.toThrow(/Cursor \(fixture\) is not available in T3: Provider instance is disabled/);
    await expect(newRoom(three.slice(0, 1))).rejects.toThrow(/2–6 agents/);
  });

  it("two agents of the same provider get their own handles and threads", async () => {
    const room = await newRoom([three[0], three[0]]);
    expect(store.participants(room.id).map((p) => p.kind)).toEqual(["claude", "claude2"]);
    await ctl.postHumanMessage(room.id, { body: "@claude2 your view?" });
    expect(sentTo(room.id, "claude2")).toHaveLength(1);
    expect(sentTo(room.id, "claude")).toHaveLength(0);
  });

  it("tells each agent who is in the room and how to reach them", async () => {
    const room = await newRoom();
    await ctl.postHumanMessage(room.id, { body: "@grok hello" });
    const env = sentTo(room.id, "grok")[0].message;
    expect(env).toContain("you are Grok (fixture) (@grok)");
    expect(env).toContain("one of 3 AI engineers in a room led by a human: Claude Code (@claude), Codex (@codex) and Grok (fixture) (@grok)");
    expect(env).toContain("write their handle (for example @claude)");
  });

  it("@all reaches every agent; one agent first, then the others build on its answer", async () => {
    const room = await newRoom();
    await ctl.postHumanMessage(room.id, { body: "Plan it.", target: "all", order: "codex" });
    expect(sentTo(room.id, "codex")).toHaveLength(1);
    expect(sentTo(room.id, "claude")).toHaveLength(0);
    expect(sentTo(room.id, "grok")).toHaveLength(0);
    t3.complete(thread(room.id, "codex"), "Codex: use a ring buffer.");
    await ctl.tick();
    for (const k of ["claude", "grok"]) {
      const env = sentTo(room.id, k)[0].message;
      expect(env).toContain("Codex answered the human lead's message first");
      expect(env).toContain("use a ring buffer");
    }
  });

  it("an automatic round: each step runs for all three, and critiques wait for every proposal", async () => {
    const room = await newRoom(three, "auto");
    await ctl.startAuto(room.id);
    for (const k of ["claude", "codex", "grok"]) expect(sentTo(room.id, k)).toHaveLength(1);
    t3.complete(thread(room.id, "claude"), "Claude's proposal.");
    t3.complete(thread(room.id, "codex"), "Codex's proposal.");
    await ctl.tick();
    // Grok's proposal is still out: nobody critiques yet.
    expect(sentTo(room.id, "claude")).toHaveLength(1);
    t3.complete(thread(room.id, "grok"), "Grok's proposal.");
    await ctl.tick();
    const critique = sentTo(room.id, "claude")[1].message;
    expect(critique).toContain("Critique the other proposals");
    expect(critique).toContain("from Codex and Grok (fixture)");
    expect(critique).toContain("Codex's proposal.");
    expect(critique).toContain("Grok's proposal.");
    expect(store.room(room.id)!.turnsUsed).toBe(6);
  });

  it("an agent's @mention hands the question to that agent only, and @all to every other agent", async () => {
    const room = await newRoom();
    await ctl.postHumanMessage(room.id, { body: "@claude look into it" });
    t3.complete(thread(room.id, "claude"), "@grok can you check the eviction policy?");
    await ctl.tick();
    expect(sentTo(room.id, "grok")).toHaveLength(1);
    expect(sentTo(room.id, "codex")).toHaveLength(0);
    expect(sentTo(room.id, "grok")[0].message).toContain("Claude Code addressed you directly above (@grok)");

    t3.complete(thread(room.id, "grok"), "Checked. @all thoughts on TTL?");
    await ctl.tick();
    expect(sentTo(room.id, "codex")).toHaveLength(1);
    expect(sentTo(room.id, "claude")).toHaveLength(2);
  });
});

describe("tasks with three agents", () => {
  it("solo: the human picks the reviewer", async () => {
    const room = await newRoom();
    await ctl.approvePlan(room.id, { body: "Plan" });
    await expect(ctl.startImplementation(room.id, { implementer: "claude", reviewer: "claude", title: "t", spec: "s", baseRef: "main" })).rejects.toThrow(/other than the implementer/);
    await ctl.startImplementation(room.id, { implementer: "claude", reviewer: "grok", title: "t", spec: "s", baseRef: "main" });
    const impl = store.tasks(room.id)[0];
    t3.complete(impl.threadId!, "Done.");
    await ctl.tick();
    const review = store.tasks(room.id).find((t) => t.kind === "review")!;
    expect(review.ownerKind).toBe("grok");
    expect(t3.threads.get(review.threadId!)!.runs[0].prompt).toContain("you are Grok (fixture)");
  });

  it("joint in parallel: every agent with a part builds it, and each part is reviewed by the next one", async () => {
    const room = await newRoom();
    await ctl.approvePlan(room.id, { body: "Split plan." });
    await ctl.startImplementation(room.id, { implementer: "claude", title: "W", spec: "", strategy: "parallel", parts: { claude: "API", codex: "storage", grok: "tests" }, baseRef: "main" });
    const impls = store.tasks(room.id);
    expect(impls.map((t) => [t.ownerKind, t.reviewerKind, t.status])).toEqual([
      ["claude", "codex", "working"],
      ["codex", "grok", "working"],
      ["grok", "claude", "working"],
    ]);
    const prompt = t3.threads.get(impls[0].threadId!)!.runs[0].prompt;
    expect(prompt).toContain("Codex and Grok (fixture) are building their parts at the same time");
    expect(prompt).toContain("=== Grok (fixture)'s part");
    for (const t of impls) t3.complete(t.threadId!, `${t.ownerKind} done.`);
    await ctl.tick();
    const reviews = store.tasks(room.id).filter((t) => t.kind === "review");
    expect(reviews.map((r) => [store.task(r.parentTaskId!)!.ownerKind, r.ownerKind])).toEqual([
      ["claude", "codex"],
      ["codex", "grok"],
      ["grok", "claude"],
    ]);
  });

  it("joint taking turns with two of three agents: the third sits out", async () => {
    const room = await newRoom();
    await ctl.approvePlan(room.id, { body: "Split plan." });
    await ctl.startImplementation(room.id, { implementer: "grok", first: "grok", title: "W", spec: "", strategy: "turns", parts: { claude: "", codex: "storage", grok: "API" }, baseRef: "main" });
    const impls = store.tasks(room.id);
    expect(impls.map((t) => [t.ownerKind, t.part, t.status])).toEqual([
      ["grok", 0, "working"],
      ["codex", 1, "queued"],
    ]);
  });
});

describe("adding and removing agents", () => {
  it("a new agent joins with the room's record and introduces itself; its reply is posted to the room", async () => {
    const room = await newRoom(three.slice(0, 2));
    await ctl.postHumanMessage(room.id, { body: "@claude what is the plan?" });
    t3.complete(thread(room.id, "claude"), "We will use an LRU cache.");
    await ctl.tick();
    await ctl.addAgent(room.id, { providerInstanceId: "grok", model: "fixture-grok" });
    const grok = store.participantByKind(room.id, "grok")!;
    const prompt = t3.launchInputs.at(-1)!.message!;
    expect(prompt).toContain("The human lead added you to a Team Room discussion that is already under way");
    expect(prompt).toContain("We will use an LRU cache.");
    expect(prompt).toContain("one of 3 AI engineers");
    t3.complete(grok.threadId!, "Hi, I have the context.");
    await ctl.tick();
    expect(store.messages(room.id).at(-1)).toMatchObject({ author: "grok", body: "Hi, I have the context." });
    // Its later turns only carry what it has not seen.
    await ctl.postHumanMessage(room.id, { body: "@grok thoughts?" });
    expect(sentTo(room.id, "grok")[0].message).not.toContain("We will use an LRU cache.");
  });

  it("a removed agent gets no more turns, keeps its messages, and its handle is not reused", async () => {
    const room = await newRoom();
    await ctl.postHumanMessage(room.id, { body: "@grok hi" });
    t3.complete(thread(room.id, "grok"), "Grok here.");
    await ctl.tick();
    await ctl.removeAgent(room.id, "grok");
    expect(store.participants(room.id).map((p) => p.kind)).toEqual(["claude", "codex"]);
    expect(ctl.view(room.id).formerParticipants.map((p) => p.kind)).toEqual(["grok"]);
    expect(t3.renames.at(-1)!.title).toMatch(/Grok \(fixture\) \(left the room\)/);
    const before = t3.sendCalls.length;
    await ctl.postHumanMessage(room.id, { body: "@all next" });
    expect(t3.sendCalls.length - before).toBe(2);
    expect(store.messages(room.id).some((m) => m.author === "grok")).toBe(true);
    await ctl.addAgent(room.id, { providerInstanceId: "grok", model: "fixture-grok" });
    expect(store.participants(room.id).map((p) => p.kind)).toEqual(["claude", "codex", "grok2"]);
  });
});

describe("the lead's name", () => {
  it("counts a question addressed to the lead by name only once that name is set", async () => {
    const { askCandidates, setLeadName } = await import("../shared/digest.js");
    const text = "Sending it requires Sam's explicit instruction and a recipient.";
    expect(askCandidates(text)).toHaveLength(0);
    setLeadName("Sam");
    try {
      expect(askCandidates(text)).toHaveLength(1);
      expect(askCandidates("## Questions for Sam\n- Ship it today?").map((c) => c.listed)).toEqual([true]);
    } finally {
      setLeadName(null);
    }
    // "the lead" works with or without a name.
    expect(askCandidates("Sending it requires the lead's explicit instruction.")).toHaveLength(1);
  });
});
