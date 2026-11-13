// Work done with the local model (Ollama), against a stand-in client.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setLeadName } from "../shared/digest.js";

// Agents in these fixtures address the lead by name.
beforeAll(() => setLeadName("Ali"));
afterAll(() => setLeadName(null));
import { Store } from "../server/store.js";
import { LocalWork } from "../server/local/work.js";

function setup(reply: (system: string, user: string) => string, available = true) {
  const store = new Store(":memory:");
  const calls: { system: string; user: string }[] = [];
  const ollama = {
    status: async () => (available ? { available: true, model: "llama3.1:8b", detail: null } : { available: false, model: null, detail: "Ollama is not running" }),
    chat: async (i: { system: string; user: string }) => {
      calls.push(i);
      return reply(i.system, i.user);
    },
  };
  const room = store.createRoom({ title: "R", brief: "b", projectId: null, projectTitle: null, mode: "manual", turnLimit: 6, permissionMode: "approval-required", peerLimit: 3, live: false });
  const local = new LocalWork(store, ollama as any);
  const add = (author: "human" | "claude" | "codex", body: string) => store.addMessage({ roomId: room.id, author, kind: author === "human" ? "instruction" : "reply", recipients: ["all"], body });
  return { store, local, room, add, calls };
}

describe("local model work", () => {
  it("has the local model rewrite only the asking sentences meant for the human, never adding any", async () => {
    const { store, local, room, add, calls } = setup(() =>
      JSON.stringify({ items: [{ n: 1, question: "What is the server's hostname?" }, { n: 2, question: "An invented extra?" }, { n: 1, question: "a statement" }] }),
    );
    add("human", "go");
    const m = add("claude", "## On the server\n\nThe one thing we need from you: the server's hostname.\n\n@codex please rerun the storage check.\n\nOnce A3 is in, rerun C1.");
    local.onAgentMessage(room.id, m);
    await local.drain();
    expect(calls[0].user).toContain("1. The one thing we need from you: the server's hostname.");
    expect(calls[0].user).not.toContain("storage check"); // the @codex paragraph and what follows it
    expect(calls[0].user).not.toContain("rerun C1");
    // Only one candidate sentence, so at most one question; the "item 2" the model made up is dropped.
    expect(store.questions(room.id).map((q) => q.text)).toEqual(["What is the server's hostname?"]);
    expect(store.message(m.id)!.meta.questionsScanned).toBe("local:llama3.1:8b");
    // Scanned once only.
    local.onAgentMessage(room.id, store.message(m.id)!);
    await local.drain();
    expect(calls).toHaveLength(1);
  });

  it("treats a paragraph that mentions the other agent in its opening words as addressed to that agent", async () => {
    const { store, local, room, add, calls } = setup(() => JSON.stringify({ items: [{ n: 1, question: "Which runtime should I use?" }] }));
    add("human", "go");
    const m = add("claude", "Agreed, @codex. I'll repeat the checks under whichever runtime you choose. Which one?");
    local.onAgentMessage(room.id, m);
    await local.drain();
    expect(calls).toHaveLength(0);
    expect(store.questions(room.id)).toHaveLength(0);
  });

  it("keeps the options an agent lists, and takes the model's for other choices", async () => {
    const { store, local, room, add } = setup(() =>
      JSON.stringify({
        items: [
          { n: 1, question: "Where should Step 1 run?", options: ["Mac", "Server"] },
          { n: 2, question: "Which runtime should we use?", options: ["gVisor", "Firecracker"] },
        ],
      }),
    );
    add("human", "go");
    const m = add("claude", "## Questions for you\n- Where should Step 1 run? [This Mac | The server]\n- Which runtime should we use, gVisor or Firecracker?");
    local.onAgentMessage(room.id, m);
    await local.drain();
    expect(store.questions(room.id).map((q) => [q.text, q.options])).toEqual([
      ["Where should Step 1 run?", ["This Mac", "The server"]],
      // Listed questions are kept in the agent's words, with the choices it lists in brackets.
      ["Which runtime should we use, gVisor or Firecracker?", []],
    ]);
  });

  it("treats a step that waits on the human as a question, even without a question mark", async () => {
    const { store, local, room, add, calls } = setup(() => JSON.stringify({ items: [{ n: 1, question: "Should Codex send the administrator request, and to whom?" }] }));
    add("human", "go");
    const m = add("codex", "Agreed. I'll consolidate them into one administrator request. Sending it requires Ali's explicit instruction and a recipient.");
    local.onAgentMessage(room.id, m);
    await local.drain();
    expect(calls).toHaveLength(1);
    expect(store.questions(room.id).map((q) => q.text)).toEqual(["Should Codex send the administrator request, and to whom?"]);
  });

  it("does not run the model on a message that asks the human nothing", async () => {
    const { store, local, room, add, calls } = setup(() => JSON.stringify({ items: [{ n: 1, question: "Is the release cleared for deployment?" }] }));
    add("human", "go");
    const m = add("codex", "I'll continue the storage investigation.\n\n**Summary for the lead:** C1 now includes the full-adapter experiments.");
    local.onAgentMessage(room.id, m);
    await local.drain();
    expect(calls).toHaveLength(0);
    expect(store.questions(room.id)).toHaveLength(0);
  });

  it("falls back to the rules when Ollama is unavailable or replies with nonsense", async () => {
    const off = setup(() => "", false);
    off.add("human", "go");
    const a = off.add("claude", "The image is built. Should Step 1 run on this Mac?");
    off.local.onAgentMessage(off.room.id, a);
    await off.local.drain();
    expect(off.store.questions(off.room.id).map((q) => q.text)).toEqual(["Should Step 1 run on this Mac?"]);
    expect(off.store.message(a.id)!.meta.questionsScanned).toBe("rules");

    const bad = setup(() => "not json");
    bad.add("human", "go");
    const b = bad.add("claude", "The image is built. Should Step 1 run on this Mac?");
    bad.local.onAgentMessage(bad.room.id, b);
    await bad.local.drain();
    expect(bad.store.questions(bad.room.id)).toHaveLength(1);
    expect(bad.store.message(b.id)!.meta.questionsScanned).toBe("rules");
  });

  it("summarizes the newest stretch once the agents are idle, and on request", async () => {
    const { local, room, add, calls } = setup((system) => (system.includes("summarize part of a team chat") ? "They agreed on the sieve.\n\n**Agreed**\n- sieve (both)" : JSON.stringify({ items: [] })));
    add("human", "go");
    add("claude", "I propose a sieve.");
    add("codex", "Agreed, a sieve.");
    await local.tick();
    await local.drain();
    const d = local.digests(room.id);
    expect(d).toEqual([expect.objectContaining({ from: 2, to: 3, status: "done", model: "llama3.1:8b", body: expect.stringContaining("agreed on the sieve") })]);
    expect(calls.find((c) => c.system.includes("summarize part"))!.user).toContain("#3 Codex:\nAgreed, a sieve.");
    // No second summary of the same stretch.
    await local.tick();
    await local.drain();
    expect(calls.filter((c) => c.system.includes("summarize part"))).toHaveLength(1);
  });

  it("picks up summaries a previous server left queued", async () => {
    const { store, room, add } = setup(() => "Summary.");
    add("human", "go");
    add("claude", "a");
    add("codex", "b");
    store.db.prepare("INSERT INTO local_digests (room_id,from_seq,to_seq,model,status,updated_at) VALUES (?,?,?,?,?,?)").run(room.id, 2, 3, "llama3.1:8b", "queued", new Date().toISOString());
    const restarted = new LocalWork(store, { status: async () => ({ available: true, model: "llama3.1:8b", detail: null }), chat: async () => "Summary." } as any);
    await restarted.tick();
    await restarted.drain();
    expect(restarted.digests(room.id)[0]).toMatchObject({ status: "done", body: "Summary." });
  });
});

describe("questions without the local model", () => {
  it("takes only what the agent listed under 'Questions for you', not status lines that mention the human", async () => {
    const { store, local, room, add } = setup(() => "", false);
    add("human", "go");
    const m = add(
      "claude",
      "Understood, Ali: I'll keep going on everything that doesn't need you.\n\nDocker is waiting on an admin prompt.\n\n## Status\nWaiting for the lead: the physical session.\n\n" +
        "## Questions for you\n- Docker Desktop is showing an admin password prompt on your screen. Can you approve it? [I approved it | Leave Docker off]\n- Browser viewing remains unverified.",
    );
    local.onAgentMessage(room.id, m);
    await local.drain();
    expect(store.questions(room.id).map((q) => [q.text, q.options])).toEqual([
      ["Docker Desktop is showing an admin password prompt on your screen. Can you approve it?", ["I approved it", "Leave Docker off"]],
    ]);
  });

  it("without that section, keeps only sentences that ask, trimmed to the question", async () => {
    const { store, local, room, add } = setup(() => "", false);
    add("human", "go");
    const m = add(
      "claude",
      "Here's the work that doesn't need you.\n\nThe unattended work is done on my side. Waiting for the lead:\n\nSpend so far: a handful of calls. The evidence is in my scratchpad. Shall I try 1 + 2 with Flash Lite first?",
    );
    local.onAgentMessage(room.id, m);
    await local.drain();
    expect(store.questions(room.id).map((q) => q.text)).toEqual(["Shall I try 1 + 2 with Flash Lite first?"]);
  });

  it("an agent asking the same thing again replaces its open question", async () => {
    const { store, local, room, add } = setup(() => "", false);
    add("human", "go");
    local.onAgentMessage(room.id, add("claude", "## Questions for you\n- Docker Desktop is showing an admin password prompt on your screen. Can you approve it?"));
    await local.drain();
    local.onAgentMessage(room.id, add("claude", "## Questions for you\n- Docker Desktop is waiting on an admin password prompt on your screen. Can you approve it when you're back?"));
    await local.drain();
    expect(store.questions(room.id).map((q) => [q.seq, q.status])).toEqual([
      [2, "expired"],
      [3, "open"],
    ]);
  });
});

describe("questions the agent lists", () => {
  it("are taken as written, steps included, even when the local model would drop them", async () => {
    const { store, local, room, add, calls } = setup(() => JSON.stringify({ items: [{ n: 1, question: null }] }));
    add("human", "go");
    const m = add(
      "codex",
      "I've armed a five-minute watcher.\n\n## Questions for you\n\n- Look inside Safari's **Example Domain** window, wait for the yellow outline, then blink twice while keeping your gaze there. Does the outline turn green? [Green | Yellow only | No outline]\n\nThe watcher requests only one image.",
    );
    local.onAgentMessage(room.id, m);
    await local.drain();
    expect(calls).toHaveLength(0);
    expect(store.questions(room.id).map((q) => [q.text, q.options])).toEqual([
      [
        "Look inside Safari's Example Domain window, wait for the yellow outline, then blink twice while keeping your gaze there. Does the outline turn green?",
        ["Green", "Yellow only", "No outline"],
      ],
    ]);
    expect(store.message(m.id)!.meta.questionsScanned).toBe("listed");
  });
});
