// Background work done without Claude or Codex: finding the questions the agents
// ask the human, and summarizing stretches of discussion. Uses the local model
// when Ollama is available, rule-based results otherwise. One job at a time, so
// the Mac only ever runs one local-model task; questions go before summaries.
import type { AgentKind, RoomMessage } from "../../shared/types.js";
import { ENDS_AS_QUESTION, askCandidates, questionWithOptions, sameQuestion, stretches } from "../../shared/digest.js";
import { AGENT_NAMES } from "../envelope.js";
import type { Store } from "../store.js";
import type { OllamaClient } from "./ollama.js";

export type LocalDigest = { roomId: string; from: number; to: number; model: string; status: "queued" | "running" | "done" | "failed"; body: string | null; error: string | null; updatedAt: string };

type Job = { kind: "questions"; roomId: string; messageId: string } | { kind: "digest"; roomId: string; from: number; to: number };

const questionSystem = (lead: string) => `In a team chat led by a human, ${lead}, several AI engineers (such as Claude Code and Codex) write messages. You get numbered sentences from one engineer's message, each with the sentence before it for context.

For each numbered sentence, decide whether it asks ${lead.toUpperCase()} to answer, decide, approve, choose or provide something, including a step that waits on ${lead}'s instruction or approval. If it does, rewrite it as one short, self-contained question to ${lead} that ends with a question mark and keeps the key options or details. If it does not (it is a statement, a plan, a status line, or meant for another engineer), use null.

If the question has set choices (named alternatives, or a yes/no decision), also give 2 to 4 short answer options; for an open question give []. Keep options the sentence lists, like "[This Mac | The server]".

Reply with JSON only: {"items": [{"n": 1, "question": "..." or null, "options": ["...", "..."]}, ...]} with one item per numbered sentence.`;

const digestSystem = (lead: string) => `You summarize part of a team chat for its human lead, ${lead}. The AI engineers named in the messages below wrote them.

Use only facts stated in the messages. Start with one plain sentence saying what the stretch was about (no heading). Then use these bold labels, each followed by 1-3 short bullets:
**Agreed** · **Disputed** · **Blocked** · **Needs ${lead}** · **Next**
Leave a label out entirely when nothing applies; never write "None". End each bullet with the engineer's name in brackets, like (Codex), or (all) when they agree. At most 150 words in total.`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS local_digests (
  room_id TEXT NOT NULL,
  from_seq INTEGER NOT NULL,
  to_seq INTEGER NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  body TEXT,
  error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (room_id, from_seq, to_seq)
);`;

const TRANSCRIPT_BUDGET = 40_000;
/** Questions are only looked for in messages this recent. */
const RECENT_MS = 48 * 3600_000;
const now = () => new Date().toISOString();

export class LocalWork {
  onChange: (roomId: string) => void = () => {};
  private queue: Job[] = [];
  private queued = new Set<string>();
  private running: Promise<void> | null = null;

  constructor(
    readonly store: Store,
    readonly ollama: OllamaClient,
    /** How the local model refers to the human lead: their first name if set, else "the lead". */
    readonly leadName: string = "the lead",
  ) {
    store.db.exec(SCHEMA);
  }

  private nameOf(roomId: string, kind: AgentKind): string {
    return this.store.participantByKind(roomId, kind)?.name ?? AGENT_NAMES[kind] ?? kind;
  }

  private key(j: Job) {
    return j.kind === "questions" ? `q:${j.messageId}` : `d:${j.roomId}:${j.from}:${j.to}`;
  }

  private enqueue(j: Job) {
    const k = this.key(j);
    if (this.queued.has(k)) return;
    this.queued.add(k);
    // Questions first: they are what the human acts on.
    if (j.kind === "questions") this.queue.splice(this.queue.findIndex((x) => x.kind === "digest") === -1 ? this.queue.length : this.queue.findIndex((x) => x.kind === "digest"), 0, j);
    else this.queue.push(j);
    this.kick();
  }

  private kick() {
    if (this.running) return;
    const j = this.queue.shift();
    if (!j) return;
    this.running = (j.kind === "questions" ? this.scanQuestions(j.roomId, j.messageId) : this.writeDigest(j.roomId, j.from, j.to))
      .catch((err) => console.error("[local]", err))
      .finally(() => {
        this.queued.delete(this.key(j));
        this.running = null;
        this.onChange(j.roomId);
        this.kick();
      });
  }

  /** Test helper: wait until the queue is empty. */
  async drain() {
    for (let i = 0; i < 1000 && (this.running || this.queue.length); i++) {
      this.kick();
      await this.running;
    }
  }

  // ------------------------------------------------------------ questions
  /** A new agent message arrived: find what it asks the human. */
  onAgentMessage(roomId: string, m: RoomMessage) {
    if (m.author !== "human" && m.author !== "system" && !["summary", "handoff"].includes(m.kind)) this.enqueue({ kind: "questions", roomId, messageId: m.id });
  }

  private async scanQuestions(roomId: string, messageId: string) {
    const m = this.store.message(messageId);
    if (!m || m.meta.questionsScanned) return;
    const status = await this.ollama.status();
    let asks: Ask[] | null = null;
    let method = "rules";
    // Questions the agent listed under "Questions for you" are taken as written, with its own choices: the model
    // can misread one that starts with steps ("Look inside the window, then blink twice. Does the outline turn
    // green?") as an instruction and drop it.
    if (askCandidates(m.body).some((c) => c.listed)) {
      asks = ruleQuestions(m);
      method = "listed";
    } else if (status.available) {
      try {
        asks = await this.llmQuestions(m);
        method = `local:${status.model}`;
      } catch (err) {
        console.error("[local] question scan fell back to rules:", (err as Error).message);
      }
    }
    asks ??= ruleQuestions(m);
    for (const a of asks) {
      // Asked again: the newer wording replaces the open one, so the panel shows it once.
      for (const old of this.store.questions(roomId, "status='open' AND author=? AND seq<?", m.author, m.seq))
        if (sameQuestion(old.text, a.text)) this.store.updateQuestion(old.id, { status: "expired" });
      this.store.addQuestion({ roomId, author: m.author as AgentKind, seq: m.seq, text: a.text, options: a.options });
    }
    this.store.updateMessage(m.id, { meta: { ...m.meta, questionsScanned: method } });
  }

  /** Rewrite each asking sentence as a question, or drop it. Grounded: at most one question per sentence. */
  private async llmQuestions(m: RoomMessage): Promise<Ask[]> {
    const cands = askCandidates(m.body);
    if (!cands.length) return [];
    const list = cands.map((c, i) => `${i + 1}. ${c.text}${c.context ? `\n   (just before: ${c.context.slice(0, 300)})` : ""}`).join("\n");
    const out = await this.ollama.chat({ system: questionSystem(this.leadName), user: `From ${this.nameOf(m.roomId, m.author)}:\n\n${list}`, json: true, temperature: 0, timeoutMs: 120_000 });
    const items: any[] = Array.isArray(JSON.parse(out)?.items) ? JSON.parse(out).items : [];
    const asks: Ask[] = [];
    for (const it of items) {
      const n = Number(it?.n);
      const q = typeof it?.question === "string" ? it.question.trim() : "";
      if (!Number.isInteger(n) || n < 1 || n > cands.length || !q.endsWith("?") || q.length < 8 || /(^|\s)@(?!all\b|everyone\b)[a-z]/i.test(q)) continue;
      if (asks.some((a) => a.text === q)) continue;
      // The agent's own [A | B] list wins; then the model's options; then the rule-based guess.
      const listed = questionWithOptions(cands[n - 1].text).options;
      const fromModel = Array.isArray(it?.options) ? it.options.filter((o: unknown): o is string => typeof o === "string" && !!o.trim() && o.length <= 60).map((o: string) => o.trim()) : [];
      const options = listed.length ? listed : fromModel.length >= 2 && fromModel.length <= 5 ? fromModel : questionWithOptions(q).options;
      asks.push({ text: q, options });
    }
    return asks;
  }

  // ------------------------------------------------------------ digests
  digests(roomId: string): LocalDigest[] {
    return (this.store.db.prepare("SELECT * FROM local_digests WHERE room_id=? ORDER BY from_seq").all(roomId) as any[]).map((r) => ({
      roomId: r.room_id,
      from: r.from_seq,
      to: r.to_seq,
      model: r.model,
      status: r.status,
      body: r.body,
      error: r.error,
      updatedAt: r.updated_at,
    }));
  }

  private setDigest(roomId: string, from: number, to: number, patch: { model: string; status: LocalDigest["status"]; body?: string | null; error?: string | null }) {
    this.store.db
      .prepare(
        `INSERT INTO local_digests (room_id,from_seq,to_seq,model,status,body,error,updated_at) VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(room_id,from_seq,to_seq) DO UPDATE SET model=excluded.model, status=excluded.status, body=excluded.body, error=excluded.error, updated_at=excluded.updated_at`,
      )
      .run(roomId, from, to, patch.model, patch.status, patch.body ?? null, patch.error ?? null, now());
  }

  /** The human asked for a local summary of one stretch. */
  async requestDigest(roomId: string, from: number, to: number) {
    const status = await this.ollama.status(true);
    if (!status.available) throw new Error(`No local model: ${status.detail}. Install one with \`ollama pull llama3.1:8b\`.`);
    this.setDigest(roomId, from, to, { model: status.model!, status: "queued" });
    this.enqueue({ kind: "digest", roomId, from, to });
  }

  private async writeDigest(roomId: string, from: number, to: number) {
    const status = await this.ollama.status();
    if (!status.available) {
      this.setDigest(roomId, from, to, { model: status.model ?? "none", status: "failed", error: status.detail });
      return;
    }
    this.setDigest(roomId, from, to, { model: status.model!, status: "running" });
    this.onChange(roomId);
    const msgs = this.store.messages(roomId).filter((m) => m.seq >= from && m.seq <= to && m.author !== "human" && m.author !== "system" && m.kind !== "summary");
    // Newest messages first within the budget: they say where the discussion ended up.
    let budget = TRANSCRIPT_BUDGET;
    const blocks: string[] = [];
    for (const m of [...msgs].reverse()) {
      const b = `#${m.seq} ${this.nameOf(roomId, m.author)}:\n${m.body.trim()}`;
      if (b.length > budget) break;
      blocks.unshift(b);
      budget -= b.length;
    }
    try {
      const body = await this.ollama.chat({ system: digestSystem(this.leadName), user: `Messages #${from}-#${to}:\n\n${blocks.join("\n\n")}`, numCtx: 32768 });
      this.setDigest(roomId, from, to, { model: status.model!, status: "done", body: body || "(empty summary)" });
    } catch (err) {
      this.setDigest(roomId, from, to, { model: status.model!, status: "failed", error: (err as Error).message });
    }
  }

  // ------------------------------------------------------------ tick
  /**
   * Called by the server loop: scan messages that arrived while Team Room was down (since the human's last message),
   * and summarize each room's newest stretch once its agents are idle.
   */
  async tick() {
    const status = await this.ollama.status();
    for (const room of this.store.rooms()) {
      const msgs = this.store.messages(room.id);
      // Only recent questions matter: after the human's last own message (answers from the questions panel don't
      // count), and from the last couple of days.
      const lastHuman = [...msgs].reverse().find((m) => m.author === "human" && !m.meta.answers)?.seq ?? 0;
      const since = Date.now() - RECENT_MS;
      for (const m of msgs) if (m.seq > lastHuman && Date.parse(m.createdAt) >= since && !m.meta.questionsScanned) this.onAgentMessage(room.id, m);
      if (!status.available) continue;
      // Summaries left queued or running by a previous run of the server: the in-memory queue died with it.
      for (const d of this.digests(room.id))
        if ((d.status === "queued" || d.status === "running") && !this.queued.has(`d:${room.id}:${d.from}:${d.to}`)) this.enqueue({ kind: "digest", roomId: room.id, from: d.from, to: d.to });
      const newest = stretches(msgs).at(-1);
      const idle = this.store.deliveries(room.id, "state IN ('pending','sending','accepted')").length === 0;
      if (!newest || !idle) continue;
      if (this.digests(room.id).some((d) => d.from === newest.from && d.to === newest.to)) continue;
      this.setDigest(room.id, newest.from, newest.to, { model: status.model!, status: "queued" });
      this.enqueue({ kind: "digest", roomId: room.id, from: newest.from, to: newest.to });
    }
  }
}

type Ask = { text: string; options: string[] };

/** Without a local model: the asking sentences themselves, with any options. A list item is its own question; a paragraph's sentences are one. */
/**
 * The question in a paragraph: its question sentences, plus the sentence before when the question points back at it
 * ("Docker is showing an admin prompt. Can you approve it?"). Status sentences around them are dropped. "" when
 * nothing is asked.
 */
function questionPart(text: string): string {
  // Not before "[": that is the agent's list of choices, part of the question before it.
  const sentences = text.split(/(?<=[.!?\]])\s+(?=[A-Z"'`(*])/);
  const asks = (x: string) => ENDS_AS_QUESTION.test(x);
  const i = sentences.findIndex(asks);
  if (i === -1) return "";
  const j = sentences.length - 1 - [...sentences].reverse().findIndex(asks);
  // "Can you approve it?", "Is that OK?": the question needs the sentence before. "Run it on this Mac?" does not.
  const from = i > 0 && /\b(it|them)\b|\b(this|that|these|those)\s*[?,(]/i.test(sentences[i]) ? i - 1 : i;
  return sentences.slice(from, j + 1).join(" ");
}

export function ruleQuestions(m: RoomMessage): Ask[] {
  const asks: string[] = [];
  let prev: { bullet: boolean; section: string | null } | null = null;
  // Without a model to judge them, only what the agent listed under "Questions for you", or sentences that end as a
  // question. Statements that merely mention the human ("Waiting for the lead:") are not asked.
  for (const c of askCandidates(m.body)
    // A listed question stays whole (the steps before its question are part of it); elsewhere, only the question.
    .map((c) => ({ ...c, text: c.listed ? (ENDS_AS_QUESTION.test(c.text) || /\?\s+\[/.test(c.text) ? c.text : "") : questionPart(c.text) }))
    .filter((c) => c.text)) {
    const joinable = prev && !c.bullet && !prev.bullet && prev.section === c.section;
    if (joinable && asks.length && asks[asks.length - 1].length + c.text.length < 700) asks[asks.length - 1] += ` ${c.text}`;
    else asks.push(c.text);
    prev = c;
  }
  return asks.map((t) => {
    const { question, options } = questionWithOptions(t);
    return { text: question, options };
  });
}
