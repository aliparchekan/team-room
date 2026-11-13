// The automatic, model-free digest of agent discussion.
import { describe, expect, it } from "vitest";
import { digest, stretches } from "../shared/digest.js";
import type { RoomMessage } from "../shared/types.js";

let seq = 0;
const msg = (author: RoomMessage["author"], body: string, kind: RoomMessage["kind"] = author === "human" ? "instruction" : "reply"): RoomMessage =>
  ({ id: `m${++seq}`, roomId: "r", seq, author, kind, recipients: ["all"], body, meta: {}, createdAt: "", deliveryState: null }) as unknown as RoomMessage;

describe("digest", () => {
  it("pulls decisions, disputes, blockers, questions for the human and next steps, attributed to their author", () => {
    seq = 0;
    const msgs = [
      msg("human", "How should we build it?"),
      msg("claude", "# Plan for the build\n\nWe agreed on the sieve approach.\n\n## Questions for you\n- Should we run Step 1 on this Mac or the server?\n\n## Next steps\n- I'll write the Dockerfile fragment."),
      msg("codex", "@claude, I disagree with running it on the Mac: the disk is too small.\n\nThe build failed with a full disk.\n\nCould you check the image size?"),
      msg("claude", "Fine, I'll check the image size next."),
    ];
    const d = digest(msgs, 2, 4);
    expect(d.replies).toEqual({ claude: 2, codex: 1 });
    expect(d.topics).toEqual(["Plan for the build"]);
    expect(d.lines.decided.map((l) => l.text)).toContain("We agreed on the sieve approach.");
    expect(d.lines.needsYou).toHaveLength(1);
    expect(d.lines.needsYou[0]).toMatchObject({ author: "claude", seq: 2, text: "Should we run Step 1 on this Mac or the server?", bullet: true, section: "Questions for you" });
    expect(d.lines.disputed[0]).toMatchObject({ author: "codex", seq: 3 });
    expect(d.lines.blocked.map((l) => l.text)).toContain("The build failed with a full disk.");
    expect(d.lines.next.map((l) => l.text)).toEqual(["I'll write the Dockerfile fragment.", "Fine, I'll check the image size next."]);
    // Codex asked Claude, not the human: "you" in a message to the other agent is not the human.
    expect(d.lines.needsYou.some((l) => l.text.includes("image size"))).toBe(false);
  });

  it("long topic headings do not classify everything under them", () => {
    seq = 0;
    const msgs = [msg("claude", "## Reply to Codex: agreed, with one change to how the env file is read\n\nThe file stays in /run/secrets."), msg("codex", "Sounds fine to me.")];
    expect(digest(msgs, 1, 2).lines.decided).toEqual([]);
  });

  it("finds stretches of agent discussion between the human's messages", () => {
    seq = 0;
    const msgs = [msg("human", "go"), msg("claude", "a"), msg("codex", "b"), msg("human", "more"), msg("claude", "only one"), msg("human", "again"), msg("codex", "c"), msg("claude", "d"), msg("claude", "s", "summary")];
    expect(stretches(msgs)).toEqual([
      { from: 2, to: 3 },
      { from: 7, to: 8 },
    ]);
  });
});

import { questionWithOptions } from "../shared/digest.js";

describe("answer options", () => {
  it("uses the agent's own [A | B] list, else Yes/No or the named alternatives, and nothing for open questions", () => {
    expect(questionWithOptions("Where should Step 1 run? [This Mac | The server | Both]")).toEqual({ question: "Where should Step 1 run?", options: ["This Mac", "The server", "Both"] });
    expect(questionWithOptions("The image is in /data. Should I delete it?").options).toEqual(["Yes", "No"]);
    expect(questionWithOptions("Should Step 1 run on this Mac or the server?").options).toEqual(["This Mac", "The server"]);
    expect(questionWithOptions("Do you want gVisor, Firecracker or plain runc?").options).toEqual(["gVisor", "Firecracker", "Plain runc"]);
    expect(questionWithOptions("What is the server's hostname or SSH alias?").options).toEqual([]);
    expect(questionWithOptions("Which model should the agent use?").options).toEqual([]);
  });
});
