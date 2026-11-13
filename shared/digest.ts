// Automatic digest of a stretch of agent discussion, without any model: it
// pulls the lines the agents themselves marked or phrased as decisions,
// disagreements, questions for the human, blockers and next steps.
// Free and instant; an agent-written summary remains available on request.
import type { AgentKind, RoomMessage } from "./types.js";

export type DigestLine = {
  author: AgentKind;
  seq: number;
  text: string;
  /** A list item (its own point) rather than a sentence of a paragraph. */
  bullet?: boolean;
  /** The section heading it sits under, if any. */
  section?: string | null;
};
export type DigestCategory = "needsYou" | "blocked" | "disputed" | "decided" | "next";

export type Digest = {
  from: number;
  to: number;
  replies: Record<AgentKind, number>;
  topics: string[];
  lines: Record<DigestCategory, DigestLine[]>;
};

export const DIGEST_LABELS: Record<DigestCategory, string> = {
  needsYou: "Needs you",
  blocked: "Blocked",
  disputed: "Disputed",
  decided: "Agreed or decided",
  next: "Next",
};

/** Order matters: a line goes to the first category that matches. */
const ORDER: DigestCategory[] = ["needsYou", "blocked", "disputed", "decided", "next"];

/** Headings the agents use for sections: everything under them belongs to that category. */
const HEADING_RULES: [RegExp, DigestCategory][] = [
  [/question|need(s|ed)? (from )?you|for you|for the (human )?lead|your (call|decision|approval|input)|what (we|i) need/i, "needsYou"],
  [/block|fail|error|problem|issue/i, "blocked"],
  [/disagree|dispute|still open|open (point|item|question)s?$|risk|concern|differ/i, "disputed"],
  [/agree|decid|decision|recommend|conclusion|result|verdict|consensus/i, "decided"],
  [/^(next( steps?)?|(my|our) (next|plan)|plan(ned)? next|steps?\b(?! \d)|who does what|to ?do|handoff)/i, "next"],
];

/** Phrasing that puts a single line in a category when no section heading does. */
const LINE_RULES: [RegExp, DigestCategory][] = [
  [/\b(your (approval|decision|call|go-?ahead|ok|input|choice)|need(s)? (your|from you)|please (confirm|approve|choose|decide|say)|waiting (for|on) you|up to you|do you want|should (we|i)\b.*\?|which (one|option) (do|would) you)/i, "needsYou"],
  [/\b(blocked|stuck|failed|failing|errors?|unable to|denied|declined|timed out|time-?out|disk (is )?(100% )?full|permission (prompt|denied)|won['’]t start|crash(ed|es)?)\b/i, "blocked"],
  [/\b(disagree|not convinced|i['’]?d challenge|challenge|however|instead of|differs?|concern|overstat|i['’]m not sure|doubt)\b/i, "disputed"],
  [/\b(agree[ds]?|agreed|decided|approved|recommend(ation|ed)?|we['’]ll go with|final|settled|confirm(ed|s)?|consensus|accept(ed)?)\b/i, "decided"],
  [/\b(next|i['’]ll|i will|we['’]ll|we will|going to|plan to|step \d|then i|after that|first,? i)\b/i, "next"],
];

/**
 * The human lead's first name, if set (TEAM_ROOM_LEAD_NAME or data/settings.json). Agents often address the lead by
 * name ("Ali, do you want…?"), so the patterns that find what is meant for the human accept it next to "you" and
 * "the lead". Unset, only those generic forms count.
 */
let N = "";
let NS = "";
export function setLeadName(name: string | null | undefined): void {
  const n = (name ?? "").trim().replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
  N = n ? `|${n}` : "";
  NS = n ? `|${n}['’]s` : "";
  build();
}

let GENERIC_HEADINGS!: RegExp;
let ADDRESSES_HUMAN!: RegExp;
let NAMES_HUMAN!: RegExp;
let HUMAN_NAMED!: RegExp;
let ASK_SIGNAL_RE!: RegExp;
let ASK_HEADING!: RegExp;
let QUESTIONS_SECTION!: RegExp;
function build(): void {
  GENERIC_HEADINGS = new RegExp(`^(agreements?|disagreements?|questions?( for (the lead|you${N}))?|what (we|i) need from you.*|next steps?|summary|changes|expected effect|verification|handoff|context|notes?)$`, "i");
  ADDRESSES_HUMAN = new RegExp(`\\b(you|human lead${N})\\b`, "i");
  NAMES_HUMAN = new RegExp(`\\b(human lead|the lead|lead's${N})\\b`, "i");
  HUMAN_NAMED = new RegExp(`\\b((the |human )lead${N})\\b`, "i");
  ASK_SIGNAL_RE = new RegExp(
    [
      "\\?\\s*$",
      "\\?\\s*\\[[^\\]]*\\|[^\\]]*\\]\\s*\\.?$",
      `need(s)? (from )?(you${N})\\b`,
      "please (confirm|approve|choose|decide|tell|let (me|us) know)",
      `(your|the lead['’]s${NS}) (explicit )?(call|decision|approval|go-?ahead|choice|ok|instruction|input|confirmation|answer|review)`,
      `(requires?|needs?|waits? (for|on)|waiting (for|on)|pending) (your|you\\b|the lead${N}${NS})`,
      `for (you|the lead${N}) to (review|decide|choose|confirm|approve|answer|pick|send|say)`,
      `once (you${N}) (decide|confirm|choose|approve|pick|reply|say)`,
    ].join("|"),
    "i",
  );
  ASK_HEADING = new RegExp(`question|need(s|ed)? (from )?(you${N})|what (we|i) need|your (call|decision|approval|input|go-?ahead)|decisions? (for|from) (you|the lead${N})|for (you|the lead${N}) to (decide|answer|approve|choose)`, "i");
  QUESTIONS_SECTION = new RegExp(`^questions? (for|to) (you|the (human )?lead${N})\\b`, "i");
}
build();
const PER_CATEGORY = 6;

function clean(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__/g, "")
    .replace(/(^|\s)[*_](\S[^*_]*\S)[*_](?=\s|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(s: string, max = 220): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 30))}…`;
}

/** Split one agent message into candidate lines, each with the section heading it sits under. */
function units(body: string): { text: string; heading: string | null; bullet: boolean }[] {
  const out: { text: string; heading: string | null; bullet: boolean }[] = [];
  let heading: string | null = null;
  let inCode = false;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode || !line || line.startsWith("|") || /^-{3,}$/.test(line)) continue;
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      heading = clean(h[1]);
      continue;
    }
    // A bold lead-in ("**Next:** …") acts as a heading for its own line.
    const lead = /^(?:[-*+]|\d+[.)])?\s*\*\*([^*]{2,60}?):?\*\*:?\s*(.*)$/.exec(line);
    const text = clean(line.replace(/^(?:[-*+]|\d+[.)])\s+/, ""));
    if (!text || text.length < 12) continue;
    if (/^- none$/i.test(line) || /^none\.?$/i.test(text)) continue;
    const bullet = /^(?:[-*+]|\d+[.)])\s+/.test(line);
    // Long paragraphs: judge sentence by sentence. Not a bullet under "Questions for you": the agent wrote it as one
    // question, often with the steps it asks about before the question itself.
    const listedAsk = bullet && !!heading && QUESTIONS_SECTION.test(heading);
    const sentences = text.length > 260 && !listedAsk ? text.split(/(?<=[.!?])\s+(?=[A-Z@`"(])/) : [text];
    for (const s of sentences) if (s.length >= 12) out.push({ text: s, heading: lead ? clean(lead[1]) : heading, bullet });
  }
  return out;
}

/**
 * `toPeer`: the message (or its section) is addressed to the other agent, so "you" there means that agent,
 * and only lines naming the human lead count as needing the human.
 */
function categorize(u: { text: string; heading: string | null }, toPeer: boolean): DigestCategory | null {
  // Only short, section-like headings ("Questions for you", "Next steps") classify everything under them;
  // a long topic heading such as "Reply to Codex: agreed, with one change" does not.
  if (u.heading && u.heading.length <= 40) for (const [re, cat] of HEADING_RULES) if (re.test(u.heading)) return cat === "needsYou" && toPeer && !NAMES_HUMAN.test(u.heading) ? "next" : cat;
  for (const [re, cat] of LINE_RULES) {
    if (!re.test(u.text)) continue;
    if (cat === "needsYou" && toPeer && !NAMES_HUMAN.test(u.text)) continue;
    return cat;
  }
  // Questions addressed to the human, even without a heading.
  if (/\?\s*$/.test(u.text) && (toPeer ? NAMES_HUMAN.test(u.text) : ADDRESSES_HUMAN.test(u.text)) && !AGENT_MENTION.test(u.text)) return "needsYou";
  return null;
}

/** An @mention of an agent (any handle but @all / @everyone), as agents address each other. */
const AGENT_MENTION = /(?:^|[\s(,])@(?!all\b|everyone\b)[a-z][a-z0-9_-]*\b/i;
const isAgent = (a: string) => a !== "human" && a !== "system";
const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Mentions of the agents other than `author`, by handle or (first word of) name. */
function peerPattern(author: AgentKind, agents: AgentKind[]): RegExp {
  const others = agents.filter((a) => a !== author);
  // Handles cover names too ("claude" in "Claude Code", "codex"); "claude2" also matches "Claude Code 2" loosely enough.
  return others.length ? new RegExp(`@(${others.map(escape).join("|")})\\b|\\b(${others.map((o) => escape(o.replace(/\d+$/, ""))).join("|")})\\b`, "i") : /(?!)/;
}



/**
 * The parts of an agent's message meant for the human. A paragraph that opens with an @claude/@codex mention is for the other
 * agent, and so are the paragraphs after it until a new heading or a paragraph that names the human.
 */
export function forHuman(body: string): string {
  const out: string[] = [];
  let toPeer = false;
  for (const para of body.split(/\n\s*\n/)) {
    const t = para.trim();
    if (/^#{1,6}\s/.test(t) || HUMAN_NAMED.test(t)) toPeer = false;
    // Addressed to another agent: an @mention within the paragraph's opening words ("Agreed, @codex. …").
    else if (AGENT_MENTION.test(t.slice(0, 42))) toPeer = true;
    if (!toPeer) out.push(para);
  }
  return out.join("\n\n");
}

/** A line that actually asks something: a question, or a plain request for the human's input. */
const ASKS = /\?\s*$|\b(need(s)? (from )?you|please (confirm|approve|choose|decide|tell|let (me|us) know)|your (call|decision|approval|go-?ahead|choice|ok)\b|waiting (for|on) you)/i;

/**
 * Digest the agents' messages with seq in [from, to]. `agents`: the room's agent handles (by default, every agent that
 * wrote in `messages`), used to tell what an agent says to another agent from what it says to the human.
 */
export function digest(messages: RoomMessage[], from: number, to: number, agents?: AgentKind[]): Digest {
  const lines: Record<DigestCategory, DigestLine[]> = { needsYou: [], blocked: [], disputed: [], decided: [], next: [] };
  const replies: Record<AgentKind, number> = {};
  const topics: string[] = [];
  const seen = new Set<string>();
  const team = agents ?? [...new Set(messages.map((m) => m.author).filter(isAgent))];
  const agentMsgs = messages.filter((m) => m.seq >= from && m.seq <= to && isAgent(m.author) && m.kind !== "summary");
  for (const m of agentMsgs) {
    const author = m.author as AgentKind;
    const PEER = peerPattern(author, team);
    replies[author] = (replies[author] ?? 0) + 1;
    for (const h of m.body.matchAll(/^#{1,3}\s+(.+)$/gm)) {
      const t = clip(clean(h[1]), 70);
      if (!GENERIC_HEADINGS.test(t) && !topics.includes(t) && topics.length < 6) topics.push(t);
    }
    // Addressed to another agent: it opens with an @mention, or its first heading names another agent.
    const opening = m.body.slice(0, 240);
    const firstHeading = /^#{1,6}\s+(.+)$/m.exec(m.body)?.[1] ?? "";
    const toPeerMsg = /^\s*@(?!all\b|everyone\b)[a-z][a-z0-9_-]*\b/i.test(m.body) || (/reply to|\bto\b|@/i.test(firstHeading) && PEER.test(firstHeading)) || ((m.meta as any)?.purpose === "peer_question" && PEER.test(opening));
    const forHumanLines = new Set(units(forHuman(m.body)).map((u) => u.text));
    for (const u of units(m.body)) {
      const toPeer = toPeerMsg || (!!u.heading && PEER.test(u.heading)) || PEER.test(u.text.slice(0, 30));
      let cat = categorize(u, toPeer);
      // "Needs you" only for real asks in the parts meant for the human; anything else under such a heading is context.
      if (cat === "needsYou" && (!ASKS.test(u.text) || !forHumanLines.has(u.text))) cat = null;
      if (!cat) continue;
      const text = clip(u.text);
      const key = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      lines[cat].push({ author, seq: m.seq, text, bullet: u.bullet, section: u.heading });
    }
  }
  // Keep the most recent lines: later messages reflect where the discussion ended up.
  for (const c of ORDER) lines[c] = lines[c].slice(-PER_CATEGORY);
  return { from, to, replies, topics, lines };
}

/** Stretches of agent discussion between the human's messages (at least `min` agent replies each). */
export function stretches(messages: RoomMessage[], min = 2): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let from = 1;
  let last: number | null = null;
  let count = 0;
  const close = () => {
    if (count >= min && last !== null) out.push({ from, to: last });
  };
  for (const m of messages) {
    if (m.author === "human") {
      close();
      from = m.seq + 1;
      last = null;
      count = 0;
    } else if (isAgent(m.author) && m.kind !== "summary") {
      last = m.seq;
      count++;
    }
  }
  close();
  return out;
}

/** Some sign a sentence asks the human something: a question, or a step that waits on the human. */
export const ASK_SIGNAL = { test: (t: string) => ASK_SIGNAL_RE.test(t) };

/**
 * The sentences of an agent's message that ask the human something, in the parts meant for the human, each with the
 * sentence before it as context. A model may rewrite each one as a question, but never adds any.
 */
export function askCandidates(body: string): { text: string; context: string | null; bullet: boolean; section: string | null; listed: boolean }[] {
  const us = units(forHuman(body));
  // Agents are told to list what they ask under "## Questions for you". When a message has that section, it is the
  // whole list: other sentences that mention the human ("Waiting for the lead:", "the work that doesn't need you")
  // are status, not questions.
  const inSection = (u: { heading: string | null }) => !!u.heading && QUESTIONS_SECTION.test(u.heading);
  const hasSection = us.some(inSection);
  const out: { text: string; context: string | null; bullet: boolean; section: string | null; listed: boolean }[] = [];
  us.forEach((u, i) => {
    if (AGENT_MENTION.test(u.text)) return;
    if (hasSection) {
      if (!inSection(u)) return;
    } else {
      const underAskHeading = !!u.heading && u.heading.length <= 40 && ASK_HEADING.test(u.heading);
      if (!ASK_SIGNAL.test(u.text) && !underAskHeading) return;
    }
    const prev = i > 0 && us[i - 1].heading === u.heading ? us[i - 1].text : null;
    out.push({ text: u.text, context: prev, bullet: u.bullet, section: u.heading, listed: hasSection });
  });
  return out.slice(0, 10);
}


/** Ends as a question: "…?", or "…? [A | B]" with the agent's choices. */
export const ENDS_AS_QUESTION = /\?\s*(\[[^\]]*\])?\s*\.?$/;

const STOP = new Set("the a an and or but to of on in at for with from by is are was were be been it its this that these those you your i me my we our can could would should will shall may might do does did so if when then than as just now there here what which who how".split(" "));
const contentWords = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9' -]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));

/**
 * The same question asked again, worded differently ("Docker Desktop is showing an admin password prompt… Can you
 * approve it?" then "Docker Desktop is waiting on an admin password prompt… Can you approve it when you're back?"):
 * most of the shorter one's content words are in the other.
 */
export function sameQuestion(a: string, b: string): boolean {
  const x = contentWords(a);
  const y = contentWords(b);
  const small = Math.min(x.size, y.size);
  if (small < 3) return a.trim().toLowerCase() === b.trim().toLowerCase();
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / small >= 0.6;
}

/**
 * A question and the answers to offer as buttons. Options come from the agent's own `[A | B | C]` list, or are
 * inferred: "Should we …?" gets Yes / No, "… this Mac or the server?" gets its alternatives.
 */
export function questionWithOptions(text: string): { question: string; options: string[] } {
  const listed = /^(.*?\?)\s*\[([^\[\]]+\|[^\[\]]+)\]\s*\.?$/.exec(text.trim());
  if (listed) {
    const options = listed[2].split("|").map((o) => o.trim()).filter(Boolean).slice(0, 6);
    if (options.length >= 2) return { question: listed[1].trim(), options };
  }
  return { question: text.trim(), options: inferOptions(text) };
}

const YES_NO_START = /^(should|shall|do|does|did|can|could|is|are|was|were|will|would|may|must|have|has|ok to|okay to|want me to)\b/i;

const CHOICE_START = /^(should|shall|do|does|did|can|could|is|are|will|would|which|want|prefer|ok|okay)\b/i;
/** Words after which a list of alternatives starts: "run on |this Mac or the server", "want |gVisor, Firecracker or runc". */
const ALT_LEAD = /\b(on|in|into|use|using|with|to|for|from|via|choose|pick|prefer|want|run|keep|go with|between|switch to|start with)\s+/gi;

function inferOptions(text: string): string[] {
  const t = text.trim();
  if (!t.endsWith("?")) return [];
  // The last sentence holds the question ("Context. Should I delete it?").
  const q = t.split(/(?<=[.!])\s+/).pop()!.replace(/\?$/, "").trim();
  if (!CHOICE_START.test(q)) return []; // "What is …?", "How …?" are open questions
  const orAt = q.toLowerCase().lastIndexOf(" or ");
  if (orAt === -1) return YES_NO_START.test(q) ? ["Yes", "No"] : [];
  const left = q.slice(0, orAt);
  const right = q.slice(orAt + 4).trim();
  let start = -1;
  for (const m of left.matchAll(ALT_LEAD)) start = m.index! + m[0].length;
  if (start === -1) return [];
  const alts = [...left.slice(start).split(/,\s*/), right].map((a) => a.trim()).filter(Boolean);
  if (alts.length < 2 || alts.length > 4 || alts.some((a) => a.split(/\s+/).length > 5)) return [];
  // Capitalize plain words, but keep names like "gVisor" or "iOS" as written.
  return alts.map((a) => (/^[a-z][a-z]/.test(a) ? a.charAt(0).toUpperCase() + a.slice(1) : a));
}
