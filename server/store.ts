// Durable room state in SQLite (node:sqlite). The room transcript here is the
// permanent record; T3's event log is not relied on for history.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentKind,
  Decision,
  Delivery,
  DeliveryState,
  MessageKind,
  Participant,
  ParticipantStatus,
  Question,
  Room,
  RoomMessage,
  Task,
} from "../shared/types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  project_id TEXT,
  project_title TEXT,
  mode TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'idle',
  status_detail TEXT,
  phase TEXT NOT NULL DEFAULT 'discussion',
  auto_step INTEGER NOT NULL DEFAULT 0,
  turn_limit INTEGER NOT NULL DEFAULT 6,
  turns_used INTEGER NOT NULL DEFAULT 0,
  brief_version INTEGER NOT NULL DEFAULT 1,
  permission_mode TEXT NOT NULL DEFAULT 'approval-required',
  peer_limit INTEGER NOT NULL DEFAULT 3,
  live INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  provider_instance_id TEXT NOT NULL,
  model TEXT NOT NULL,
  thread_id TEXT,
  thread_link TEXT,
  launch_request_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connecting',
  status_detail TEXT,
  read_position INTEGER,
  delivered_through_seq INTEGER NOT NULL DEFAULT 0,
  context_version TEXT,
  active_run_id TEXT,
  usage_json TEXT,
  UNIQUE(room_id, kind)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  seq INTEGER NOT NULL,
  author TEXT NOT NULL,
  kind TEXT NOT NULL,
  recipients TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivery_state TEXT,
  thread_id TEXT,
  run_id TEXT,
  t3_item_id TEXT,
  delivery_id TEXT,
  meta TEXT,
  UNIQUE(room_id, seq),
  UNIQUE(thread_id, t3_item_id)
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  participant_id TEXT NOT NULL REFERENCES participants(id),
  purpose TEXT NOT NULL,
  message_seqs TEXT NOT NULL,
  through_seq INTEGER NOT NULL,
  context_version TEXT,
  envelope TEXT NOT NULL,
  send_mode TEXT NOT NULL,
  state TEXT NOT NULL,
  t3_delivery TEXT,
  run_id TEXT,
  run_status TEXT,
  auto_step INTEGER,
  counts_as_turn INTEGER NOT NULL DEFAULT 1,
  task_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  author TEXT NOT NULL,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  answer_seq INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(room_id, seq, text)
);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  source_message_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  kind TEXT NOT NULL,
  owner_kind TEXT NOT NULL,
  title TEXT NOT NULL,
  spec TEXT NOT NULL,
  status TEXT NOT NULL,
  status_detail TEXT,
  thread_id TEXT,
  thread_link TEXT,
  launch_request_id TEXT NOT NULL,
  workspace TEXT,
  worktree_path TEXT,
  branch TEXT,
  run_id TEXT,
  read_position INTEGER,
  report TEXT,
  parent_task_id TEXT,
  job_id TEXT,
  strategy TEXT NOT NULL DEFAULT 'solo',
  part INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const now = () => new Date().toISOString();
const j = (v: unknown) => JSON.stringify(v);
const pj = <T>(v: unknown, d: T): T => {
  if (typeof v !== "string") return d;
  try {
    return JSON.parse(v) as T;
  } catch {
    return d;
  }
};

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.db.exec(SCHEMA);
    // Columns added after the first release.
    const roomCols = (this.db.prepare("PRAGMA table_info(rooms)").all() as any[]).map((c) => c.name);
    if (!roomCols.includes("permission_mode"))
      this.db.exec("ALTER TABLE rooms ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'approval-required'");
    const taskCols = (this.db.prepare("PRAGMA table_info(tasks)").all() as any[]).map((c) => c.name);
    if (!taskCols.includes("job_id")) this.db.exec("ALTER TABLE tasks ADD COLUMN job_id TEXT");
    if (!taskCols.includes("strategy")) this.db.exec("ALTER TABLE tasks ADD COLUMN strategy TEXT NOT NULL DEFAULT 'solo'");
    if (!taskCols.includes("part")) this.db.exec("ALTER TABLE tasks ADD COLUMN part INTEGER NOT NULL DEFAULT 0");
    const partCols = (this.db.prepare("PRAGMA table_info(participants)").all() as any[]).map((c) => c.name);
    if (!partCols.includes("previous_threads")) this.db.exec("ALTER TABLE participants ADD COLUMN previous_threads TEXT NOT NULL DEFAULT '[]'");
    const qCols = (this.db.prepare("PRAGMA table_info(questions)").all() as any[]).map((c) => c.name);
    if (!qCols.includes("options")) this.db.exec("ALTER TABLE questions ADD COLUMN options TEXT NOT NULL DEFAULT '[]'");
    if (!partCols.includes("options_json")) this.db.exec("ALTER TABLE participants ADD COLUMN options_json TEXT NOT NULL DEFAULT '{}'");
    if (!partCols.includes("thread_mode")) this.db.exec("ALTER TABLE participants ADD COLUMN thread_mode TEXT");
    if (!partCols.includes("transfer_json")) this.db.exec("ALTER TABLE participants ADD COLUMN transfer_json TEXT");
    if (!partCols.includes("position")) this.db.exec("ALTER TABLE participants ADD COLUMN position INTEGER NOT NULL DEFAULT 0");
    if (!partCols.includes("left_at")) this.db.exec("ALTER TABLE participants ADD COLUMN left_at TEXT");
    if (!taskCols.includes("reviewer_kind")) this.db.exec("ALTER TABLE tasks ADD COLUMN reviewer_kind TEXT");
    if (!roomCols.includes("peer_limit")) this.db.exec("ALTER TABLE rooms ADD COLUMN peer_limit INTEGER NOT NULL DEFAULT 3");
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ---------- rooms ----------
  createRoom(input: {
    title: string;
    brief: string;
    projectId: string | null;
    projectTitle: string | null;
    mode: Room["mode"];
    turnLimit: number;
    permissionMode: Room["permissionMode"];
    peerLimit: number;
    live: boolean;
  }): Room {
    const id = randomUUID();
    const t = now();
    this.db
      .prepare(
        `INSERT INTO rooms (id,title,brief,project_id,project_title,mode,turn_limit,permission_mode,peer_limit,live,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, input.title, input.brief, input.projectId, input.projectTitle, input.mode, input.turnLimit, input.permissionMode, input.peerLimit, input.live ? 1 : 0, t, t);
    return this.room(id)!;
  }

  room(id: string): Room | null {
    const r = this.db.prepare("SELECT * FROM rooms WHERE id=?").get(id) as any;
    return r ? rowToRoom(r) : null;
  }

  rooms(): Room[] {
    return (this.db.prepare("SELECT * FROM rooms ORDER BY updated_at DESC").all() as any[]).map(rowToRoom);
  }

  updateRoom(id: string, patch: Partial<Omit<Room, "id" | "createdAt">>) {
    const cols: Record<string, string> = {
      title: "title",
      brief: "brief",
      mode: "mode",
      status: "status",
      statusDetail: "status_detail",
      phase: "phase",
      autoStep: "auto_step",
      turnLimit: "turn_limit",
      peerLimit: "peer_limit",
      permissionMode: "permission_mode",
      turnsUsed: "turns_used",
      briefVersion: "brief_version",
    };
    const sets: string[] = [];
    const vals: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const c = cols[k];
      if (!c) continue;
      sets.push(`${c}=?`);
      vals.push(v ?? null);
    }
    sets.push("updated_at=?");
    vals.push(now(), id);
    this.db.prepare(`UPDATE rooms SET ${sets.join(",")} WHERE id=?`).run(...vals);
  }

  // ---------- participants ----------
  addParticipant(roomId: string, p: { kind: AgentKind; name: string; providerInstanceId: string; model: string; options?: Record<string, string | boolean> }): Participant {
    const id = randomUUID();
    const position = (this.db.prepare("SELECT COALESCE(MAX(position),-1)+1 AS n FROM participants WHERE room_id=?").get(roomId) as any).n;
    this.db
      .prepare(
        `INSERT INTO participants (id,room_id,kind,name,provider_instance_id,model,launch_request_id,options_json,position)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, roomId, p.kind, p.name, p.providerInstanceId, p.model, `tr-launch-${id}`, j(p.options ?? {}), position);
    return this.participant(id)!;
  }

  participant(id: string): Participant | null {
    const r = this.db.prepare("SELECT * FROM participants WHERE id=?").get(id) as any;
    return r ? rowToParticipant(r) : null;
  }

  /** The room's agents, in order. Agents removed from the room are left out unless `withLeft`. */
  participants(roomId: string, withLeft = false): Participant[] {
    return (
      this.db.prepare(`SELECT * FROM participants WHERE room_id=? ${withLeft ? "" : "AND left_at IS NULL"} ORDER BY position, kind`).all(roomId) as any[]
    ).map(rowToParticipant);
  }

  /** An agent of the room by handle (including one that left, so its messages and tasks still have a name). */
  participantByKind(roomId: string, kind: AgentKind): Participant | null {
    const r = this.db.prepare("SELECT * FROM participants WHERE room_id=? AND kind=?").get(roomId, kind) as any;
    return r ? rowToParticipant(r) : null;
  }

  updateParticipant(id: string, patch: Partial<Participant>) {
    const cols: Record<string, string> = {
      threadId: "thread_id",
      threadLink: "thread_link",
      status: "status",
      statusDetail: "status_detail",
      readPosition: "read_position",
      deliveredThroughSeq: "delivered_through_seq",
      contextVersion: "context_version",
      activeRunId: "active_run_id",
      model: "model",
      threadMode: "thread_mode",
      leftAt: "left_at",
    };
    const sets: string[] = [];
    const vals: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === "usage" || k === "transfer" || k === "previousThreads" || k === "options") {
        sets.push(`${{ usage: "usage_json", transfer: "transfer_json", previousThreads: "previous_threads", options: "options_json" }[k]}=?`);
        vals.push(v == null ? null : j(v));
        continue;
      }
      const c = cols[k];
      if (!c) continue;
      sets.push(`${c}=?`);
      vals.push(v ?? null);
    }
    if (!sets.length) return;
    vals.push(id);
    this.db.prepare(`UPDATE participants SET ${sets.join(",")} WHERE id=?`).run(...vals);
  }

  // ---------- messages ----------
  addMessage(m: {
    roomId: string;
    author: RoomMessage["author"];
    kind: MessageKind;
    recipients: RoomMessage["recipients"];
    body: string;
    deliveryState?: RoomMessage["deliveryState"];
    threadId?: string | null;
    runId?: string | null;
    t3ItemId?: string | null;
    deliveryId?: string | null;
    meta?: Record<string, unknown>;
  }): RoomMessage {
    return this.tx(() => {
      if (m.threadId && m.t3ItemId) {
        const existing = this.db.prepare("SELECT * FROM messages WHERE thread_id=? AND t3_item_id=?").get(m.threadId, m.t3ItemId) as any;
        if (existing) return rowToMessage(existing);
      }
      const seq = ((this.db.prepare("SELECT MAX(seq) AS s FROM messages WHERE room_id=?").get(m.roomId) as any)?.s ?? 0) + 1;
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO messages (id,room_id,seq,author,kind,recipients,body,created_at,delivery_state,thread_id,run_id,t3_item_id,delivery_id,meta)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          m.roomId,
          seq,
          m.author,
          m.kind,
          j(m.recipients),
          m.body,
          now(),
          m.deliveryState ?? null,
          m.threadId ?? null,
          m.runId ?? null,
          m.t3ItemId ?? null,
          m.deliveryId ?? null,
          m.meta ? j(m.meta) : null,
        );
      this.db.prepare("UPDATE rooms SET updated_at=? WHERE id=?").run(now(), m.roomId);
      return this.message(id)!;
    });
  }

  message(id: string): RoomMessage | null {
    const r = this.db.prepare("SELECT * FROM messages WHERE id=?").get(id) as any;
    return r ? rowToMessage(r) : null;
  }

  messages(roomId: string): RoomMessage[] {
    return (this.db.prepare("SELECT * FROM messages WHERE room_id=? ORDER BY seq").all(roomId) as any[]).map(rowToMessage);
  }

  messageForItem(threadId: string, itemId: string): RoomMessage | null {
    const r = this.db.prepare("SELECT * FROM messages WHERE thread_id=? AND t3_item_id=?").get(threadId, itemId) as any;
    return r ? rowToMessage(r) : null;
  }

  updateMessage(id: string, patch: { deliveryState?: RoomMessage["deliveryState"]; meta?: Record<string, unknown> }) {
    if (patch.deliveryState !== undefined)
      this.db.prepare("UPDATE messages SET delivery_state=? WHERE id=?").run(patch.deliveryState, id);
    if (patch.meta !== undefined) this.db.prepare("UPDATE messages SET meta=? WHERE id=?").run(j(patch.meta), id);
  }

  // ---------- deliveries ----------
  addDelivery(d: Omit<Delivery, "id" | "createdAt" | "updatedAt" | "state" | "t3Delivery" | "runId" | "runStatus" | "error"> & { id?: string }): Delivery {
    const id = d.id ?? `tr-${randomUUID()}`;
    const t = now();
    this.db
      .prepare(
        `INSERT INTO deliveries (id,room_id,participant_id,purpose,message_seqs,through_seq,context_version,envelope,send_mode,state,auto_step,counts_as_turn,task_id,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?)`,
      )
      .run(
        id,
        d.roomId,
        d.participantId,
        d.purpose,
        j(d.messageSeqs),
        d.throughSeq,
        d.contextVersion ?? null,
        d.envelope,
        d.sendMode,
        d.autoStep ?? null,
        d.countsAsTurn ? 1 : 0,
        d.taskId ?? null,
        t,
        t,
      );
    return this.delivery(id)!;
  }

  delivery(id: string): Delivery | null {
    const r = this.db.prepare("SELECT * FROM deliveries WHERE id=?").get(id) as any;
    return r ? rowToDelivery(r) : null;
  }

  deliveries(roomId: string, where = "1=1", ...args: any[]): Delivery[] {
    return (
      this.db.prepare(`SELECT * FROM deliveries WHERE room_id=? AND (${where}) ORDER BY created_at`).all(roomId, ...args) as any[]
    ).map(rowToDelivery);
  }

  allDeliveries(where: string, ...args: any[]): Delivery[] {
    return (this.db.prepare(`SELECT * FROM deliveries WHERE ${where} ORDER BY created_at`).all(...args) as any[]).map(rowToDelivery);
  }

  updateDelivery(id: string, patch: Partial<Pick<Delivery, "state" | "t3Delivery" | "runId" | "runStatus" | "error">>) {
    const cols: Record<string, string> = { state: "state", t3Delivery: "t3_delivery", runId: "run_id", runStatus: "run_status", error: "error" };
    const sets: string[] = [];
    const vals: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${cols[k]}=?`);
      vals.push(v ?? null);
    }
    sets.push("updated_at=?");
    vals.push(now(), id);
    this.db.prepare(`UPDATE deliveries SET ${sets.join(",")} WHERE id=?`).run(...vals);
  }

  // ---------- decisions ----------
  addDecision(roomId: string, kind: Decision["kind"], body: string, sourceMessageId?: string | null): Decision {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO decisions (id,room_id,kind,body,source_message_id,created_at) VALUES (?,?,?,?,?,?)")
      .run(id, roomId, kind, body, sourceMessageId ?? null, now());
    return this.decisions(roomId).find((d) => d.id === id)!;
  }

  decisions(roomId: string, activeOnly = false): Decision[] {
    return (
      this.db
        .prepare(`SELECT * FROM decisions WHERE room_id=? ${activeOnly ? "AND active=1" : ""} ORDER BY created_at`)
        .all(roomId) as any[]
    ).map((r) => ({
      id: r.id,
      roomId: r.room_id,
      kind: r.kind,
      body: r.body,
      sourceMessageId: r.source_message_id,
      active: !!r.active,
      createdAt: r.created_at,
    }));
  }

  setDecisionActive(id: string, active: boolean) {
    this.db.prepare("UPDATE decisions SET active=? WHERE id=?").run(active ? 1 : 0, id);
  }

  // ---------- questions for the human ----------
  addQuestion(q: { roomId: string; author: AgentKind; seq: number; text: string; options?: string[] }) {
    const t = now();
    this.db
      .prepare("INSERT OR IGNORE INTO questions (id,room_id,author,seq,text,options,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'open',?,?)")
      .run(randomUUID(), q.roomId, q.author, q.seq, q.text, j(q.options ?? []), t, t);
  }

  questions(roomId: string, where = "", ...args: any[]): Question[] {
    return (this.db.prepare(`SELECT * FROM questions WHERE room_id=? ${where ? `AND ${where}` : ""} ORDER BY seq, rowid`).all(roomId, ...args) as any[]).map((r) => ({
      id: r.id,
      roomId: r.room_id,
      author: r.author,
      seq: r.seq,
      text: r.text,
      options: pj(r.options, []),
      status: r.status,
      answerSeq: r.answer_seq,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  hasQuestionRecords(roomId: string) {
    return !!this.db.prepare("SELECT 1 FROM questions WHERE room_id=? LIMIT 1").get(roomId);
  }

  updateQuestion(id: string, patch: { status: Question["status"]; answerSeq?: number | null }) {
    this.db.prepare("UPDATE questions SET status=?, answer_seq=?, updated_at=? WHERE id=?").run(patch.status, patch.answerSeq ?? null, now(), id);
  }

  // ---------- tasks ----------
  addTask(
    t: Pick<Task, "roomId" | "kind" | "ownerKind" | "title" | "spec" | "workspace"> &
      Partial<Pick<Task, "jobId" | "strategy" | "part" | "reviewerKind">> & { parentTaskId?: string | null },
  ): Task {
    const id = randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO tasks (id,room_id,kind,owner_kind,title,spec,status,launch_request_id,workspace,parent_task_id,job_id,strategy,part,reviewer_kind,created_at,updated_at)
         VALUES (?,?,?,?,?,?,'queued',?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id, t.roomId, t.kind, t.ownerKind, t.title, t.spec, `tr-task-${id}`, t.workspace ?? null, t.parentTaskId ?? null,
        t.jobId ?? null, t.strategy ?? "solo", t.part ?? 0, t.reviewerKind ?? null, ts, ts,
      );
    return this.task(id)!;
  }

  task(id: string): Task | null {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as any;
    return r ? rowToTask(r) : null;
  }

  tasks(roomId: string): Task[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE room_id=? ORDER BY created_at, rowid").all(roomId) as any[]).map(rowToTask);
  }

  updateTask(id: string, patch: Partial<Task>) {
    const cols: Record<string, string> = {
      status: "status",
      statusDetail: "status_detail",
      threadId: "thread_id",
      threadLink: "thread_link",
      worktreePath: "worktree_path",
      branch: "branch",
      runId: "run_id",
      readPosition: "read_position",
      report: "report",
    };
    const sets: string[] = [];
    const vals: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const c = cols[k];
      if (!c) continue;
      sets.push(`${c}=?`);
      vals.push(v ?? null);
    }
    sets.push("updated_at=?");
    vals.push(now(), id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(",")} WHERE id=?`).run(...vals);
  }
}

function rowToRoom(r: any): Room {
  return {
    id: r.id,
    title: r.title,
    brief: r.brief,
    projectId: r.project_id,
    projectTitle: r.project_title,
    mode: r.mode,
    status: r.status,
    statusDetail: r.status_detail,
    phase: r.phase,
    autoStep: r.auto_step,
    turnLimit: r.turn_limit,
    turnsUsed: r.turns_used,
    briefVersion: r.brief_version,
    permissionMode: r.permission_mode ?? "approval-required",
    peerLimit: r.peer_limit ?? 3,
    live: !!r.live,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToParticipant(r: any): Participant {
  return {
    id: r.id,
    roomId: r.room_id,
    kind: r.kind,
    name: r.name,
    providerInstanceId: r.provider_instance_id,
    model: r.model,
    threadId: r.thread_id,
    threadLink: r.thread_link,
    launchRequestId: r.launch_request_id,
    status: r.status as ParticipantStatus,
    statusDetail: r.status_detail,
    readPosition: r.read_position,
    deliveredThroughSeq: r.delivered_through_seq,
    contextVersion: r.context_version,
    activeRunId: r.active_run_id,
    usage: pj(r.usage_json, null),
    threadMode: r.thread_mode ?? null,
    options: pj(r.options_json, {}),
    previousThreads: pj(r.previous_threads, []),
    transfer: pj(r.transfer_json, null),
    position: r.position ?? 0,
    leftAt: r.left_at ?? null,
  };
}

function rowToMessage(r: any): RoomMessage {
  return {
    id: r.id,
    roomId: r.room_id,
    seq: r.seq,
    author: r.author,
    kind: r.kind,
    recipients: pj(r.recipients, []),
    body: r.body,
    createdAt: r.created_at,
    deliveryState: r.delivery_state,
    threadId: r.thread_id,
    runId: r.run_id,
    t3ItemId: r.t3_item_id,
    deliveryId: r.delivery_id,
    meta: pj(r.meta, {}),
  };
}

function rowToDelivery(r: any): Delivery {
  return {
    id: r.id,
    roomId: r.room_id,
    participantId: r.participant_id,
    purpose: r.purpose,
    messageSeqs: pj(r.message_seqs, []),
    throughSeq: r.through_seq,
    contextVersion: r.context_version,
    envelope: r.envelope,
    sendMode: r.send_mode,
    state: r.state as DeliveryState,
    t3Delivery: r.t3_delivery,
    runId: r.run_id,
    runStatus: r.run_status,
    autoStep: r.auto_step,
    countsAsTurn: !!r.counts_as_turn,
    taskId: r.task_id,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToTask(r: any): Task {
  return {
    id: r.id,
    roomId: r.room_id,
    kind: r.kind,
    ownerKind: r.owner_kind,
    jobId: r.job_id ?? null,
    strategy: r.strategy ?? "solo",
    part: r.part ?? 0,
    reviewerKind: r.reviewer_kind ?? null,
    title: r.title,
    spec: r.spec,
    status: r.status,
    statusDetail: r.status_detail,
    threadId: r.thread_id,
    threadLink: r.thread_link,
    launchRequestId: r.launch_request_id,
    workspace: r.workspace,
    worktreePath: r.worktree_path,
    branch: r.branch,
    runId: r.run_id,
    readPosition: r.read_position,
    report: r.report,
    parentTaskId: r.parent_task_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
