import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Avatar, Icon, Md, PermissionSelect, T3ApprovalPanel, T3Link, ThinkingSelect, grantMoreAccess, type Waiting } from "./ui";
import { ResearchMode } from "./Research";
import { DIGEST_LABELS, digest, setLeadName, stretches, type Digest, type DigestCategory } from "../../shared/digest";
import { MAX_AGENTS, MIN_AGENTS, PERMISSION_LABELS, PERMISSION_MODES } from "../../shared/types";
import type { AgentKind, Participant, PermissionMode, ReplyOrder, ProviderInfo, Room, RoomMessage, RoomStatus, RoomView, T3Status, Task, TaskStrategy } from "../../shared/types";
import { api, type RoomListItem } from "./api";

const NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", human: "You", system: "Room" };

/** Display name of an author or agent of the room, by handle (agents that left included). */
function nameIn(view: RoomView, kind: string): string {
  return [...view.participants, ...(view.formerParticipants ?? [])].find((p) => p.kind === kind)?.name ?? NAMES[kind] ?? kind;
}

const STATUS_LABEL: Record<RoomStatus, string> = {
  setting_up: "Connecting",
  idle: "Idle",
  running: "Working",
  paused: "Paused",
  stopping: "Stopping",
  reconciling: "Reconciling",
  awaiting_decision: "Your decision",
  executing: "Executing",
  review_ready: "Review ready",
  needs_attention: "Needs attention",
};

/**
 * The status to show for a room: what its agents are actually doing. The room's own state says whether *automatic*
 * turns advance, so "paused" there often just means the room is waiting while agents still work, or are idle.
 */
function shownStatus(room: Room, agentStatuses: string[], tasksActive: boolean): { cls: string; label: string } {
  if (["setting_up", "reconciling", "stopping", "needs_attention", "awaiting_decision", "review_ready"].includes(room.status))
    return { cls: `s-${room.status}`, label: STATUS_LABEL[room.status] };
  if (tasksActive || agentStatuses.some((s) => s === "working" || s === "queued")) return { cls: "s-running", label: "Working" };
  if (room.status === "paused") {
    if (room.statusDetail?.startsWith("Paused by you")) return { cls: "s-paused", label: "Paused" };
    if (room.statusDetail?.startsWith("Stopped")) return { cls: "s-paused", label: "Stopped" };
    return { cls: "s-idle", label: room.phase === "execution" ? "Plan approved" : "Idle" };
  }
  if (room.status === "running" || room.status === "executing") return { cls: "s-running", label: "Working" };
  return { cls: `s-${room.status}`, label: STATUS_LABEL[room.status] };
}

const KIND_LABEL: Record<string, string> = {
  instruction: "Instruction",
  note: "Note to room",
  proposal: "Proposal",
  critique: "Critique",
  response: "Response to critique",
  reply: "Reply",
  progress: "Progress",
  implementation_report: "Implementation report",
  review: "Code review",
  decision: "Decision",
  handoff: "Handoff note",
  summary: "Summary",
  system: "",
};

function useHashRoom(): [string | null, (id: string | null) => void] {
  const read = () => (location.hash.startsWith("#room=") ? location.hash.slice(6) : null);
  const [id, setId] = useState<string | null>(read);
  useEffect(() => {
    const f = () => setId(read());
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  return [id, (v) => (location.hash = v ? `room=${v}` : "")];
}

export function App() {
  const [status, setStatus] = useState<T3Status | null>(null);
  if (status) knownProviders = status.providers;
  const [rooms, setRooms] = useState<RoomListItem[]>([]);
  const [roomId, setRoomId] = useHashRoom();
  const [view, setView] = useState<RoomView | null>(null);
  const [creating, setCreating] = useState(false);
  const [mode, setMode] = useState<"rooms" | "research">(() => (location.hash.startsWith("#research") ? "research" : "rooms"));
  const [error, setError] = useState<string | null>(() => new URLSearchParams(location.search).get("auth_error"));

  // Reload once the server serves a newer interface build (after an update or restart), so no window runs old code.
  const buildRef = useRef<string | null | undefined>(undefined);
  const loadStatus = useCallback(() => {
    api
      .status()
      .then((s) => {
        if (buildRef.current && s.buildId && s.buildId !== buildRef.current) return location.reload();
        if (buildRef.current === undefined) buildRef.current = s.buildId ?? null;
        setLeadName(s.leadName);
        setStatus(s);
      })
      .catch((e) => setError(e.message));
  }, []);
  const loadRooms = useCallback(() => {
    api.rooms().then(setRooms).catch(() => {});
  }, []);
  const loadRoom = useCallback(() => {
    if (!roomId) {
      setView(null);
      return;
    }
    api.room(roomId).then(setView).catch((e) => setError(e.message));
  }, [roomId]);

  useEffect(() => {
    loadStatus();
    loadRooms();
  }, [loadStatus, loadRooms]);
  useEffect(() => {
    loadRoom();
  }, [loadRoom]);

  // Server-sent events: refetch what changed.
  const roomRef = useRef(roomId);
  roomRef.current = roomId;
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = (ev) => {
      const e = JSON.parse(ev.data);
      if (e.type === "t3" || e.type === "hello") loadStatus();
      if (e.type === "room") {
        loadRooms();
        if (e.roomId === roomRef.current) api.room(e.roomId).then(setView).catch(() => {});
      }
    };
    return () => es.close();
  }, [loadStatus, loadRooms]);

  // The window title carries a count of agents waiting on you, visible from the Dock and app switcher.
  const waitingCount = rooms.reduce((n, r) => n + (r.waiting?.length ?? 0) + (r.questions ?? 0), 0);
  useEffect(() => {
    document.title = waitingCount ? `(${waitingCount}) Team Room — waiting for you` : "Team Room";
  }, [waitingCount]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div className="app">
      <Header
        status={status}
        onConnect={() => run(async () => setStatus(await api.connect()))}
        onChangeAccess={() =>
          run(async () => {
            const s = await grantMoreAccess();
            if (s) setStatus(s);
          })
        }
      />
      {status?.mode === "fixture" && (
        <div className="fixture-banner">FIXTURE MODE — replies are canned by a local stand-in. No real Claude or Codex sessions are involved.</div>
      )}
      {error && (
        <div className="error-bar" role="alert">
          {error}
          <button className="link" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
      <div className="body">
        {mode === "research" ? (
          <ResearchMode status={status} run={run} modeSwitch={<ModeSwitch mode={mode} setMode={setMode} />} />
        ) : (
          <>
        <aside className="sidebar">
          <ModeSwitch mode={mode} setMode={setMode} />
          <button className="primary block" onClick={() => setCreating(true)} disabled={status?.connection.kind !== "connected"}>
            <Icon name="plus" /> New room
          </button>
          <nav className="room-list">
            {rooms.map((r) => (
              <button
                key={r.id}
                className={`room-item ${r.id === roomId ? "active" : ""}`}
                aria-current={r.id === roomId ? "page" : undefined}
                title={r.title}
                onClick={() => setRoomId(r.id)}
              >
                <span className="room-title">{r.title}</span>
                {r.waiting?.length ? (
                  <span className="room-status s-approval" title={`${r.waiting.join(", ")} waiting for you in T3`}>
                    <i className="dot" />
                    Waiting for your approval
                  </span>
                ) : r.questions ? (
                  <span className="room-status s-questions">
                    <i className="dot" />
                    {r.questions} question{r.questions === 1 ? "" : "s"} for you
                  </span>
                ) : (
                  (() => {
                    const st = shownStatus(r, r.participants.map((p) => p.status), !!r.tasksActive);
                    return (
                      <span className={`room-status ${st.cls}`}>
                        <i className="dot" />
                        {st.label}
                      </span>
                    );
                  })()
                )}
              </button>
            ))}
            {!rooms.length && <p className="muted small">No rooms yet.</p>}
          </nav>
        </aside>
        <main className="main">
          {creating && status ? (
            <NewRoom
              status={status}
              onCancel={() => setCreating(false)}
              onCreate={(b) =>
                run(async () => {
                  const r = await api.createRoom(b);
                  setCreating(false);
                  loadRooms();
                  setRoomId(r.id);
                })
              }
            />
          ) : view ? (
            <RoomPage key={view.room.id} view={view} run={run} webOrigin={status?.webOrigin ?? null} maxPermission={status?.maxPermission ?? null} providers={status?.providers ?? []} localModel={status?.localModel ?? null} />
          ) : (
            <Empty status={status} />
          )}
        </main>
          </>
        )}
      </div>
    </div>
  );
}

function ModeSwitch({ mode, setMode }: { mode: "rooms" | "research"; setMode: (m: "rooms" | "research") => void }) {
  return (
    <div className="mode-switch" role="tablist" aria-label="Mode">
      {(["rooms", "research"] as const).map((m) => (
        <button
          key={m}
          role="tab"
          aria-selected={mode === m}
          className={mode === m ? "on" : ""}
          onClick={() => {
            setMode(m);
            location.hash = m === "research" ? "research" : "";
          }}
        >
          {m === "rooms" ? "Rooms" : "AutoResearch"}
        </button>
      ))}
    </div>
  );
}

function Header({ status, onConnect, onChangeAccess }: { status: T3Status | null; onConnect: () => void; onChangeAccess: () => void }) {
  const c = status?.connection;
  return (
    <header className="header">
      <div className="brand">Team Room</div>
      <div className="t3">
        {!c && <span className="chip">Loading…</span>}
        {c?.kind === "connected" && (
          <span className="chip s-ok" title={status!.mcpUrl}>
            T3 {c.serverVersion} · connected
          </span>
        )}
        {status?.keepAwake && (
          <span className="chip" title="Agents are working, so Team Room is keeping this Mac from sleeping. It lets it sleep again when they are idle. Closing the lid still sleeps the Mac.">
            Keeping Mac awake
          </span>
        )}
        {c?.kind === "connected" && status?.maxPermission && (
          <button className="link small" title="The most autonomous mode Team Room may start agents in. T3 sets this when you approve Team Room." onClick={onChangeAccess}>
            Access: {PERMISSION_LABELS[status.maxPermission]} · change
          </button>
        )}
        {c?.kind === "connecting" && <span className="chip s-running">Connecting to T3…</span>}
        {c?.kind === "needs_auth" && (
          <>
            <span className="chip s-needs_attention">T3 sign-in required</span>
            {c.authorizationUrl ? (
              <a className="button primary" href={c.authorizationUrl} target="_blank" rel="noreferrer">
                Approve in T3
              </a>
            ) : (
              <button className="primary" onClick={onConnect}>
                Sign in to T3
              </button>
            )}
          </>
        )}
        {(c?.kind === "error" || c?.kind === "disconnected") && (
          <>
            <span className="chip s-needs_attention" title={(c as any).detail}>
              T3 unavailable{(c as any).detail ? `: ${(c as any).detail}` : ""}
            </span>
            <button onClick={onConnect}>Retry</button>
          </>
        )}
      </div>
    </header>
  );
}

function Empty({ status }: { status: T3Status | null }) {
  const c = status?.connection;
  return (
    <div className="empty">
      <h2>Lead a small team of real agents</h2>
      <p className="muted">
        Each room has two to six agents (Claude Code, Codex, or any other provider you enable in T3), each in its own T3 thread. Describe a task,
        let them propose and critique, step in at any time, then approve a plan and assign implementation and review.
      </p>
      {c?.kind === "needs_auth" && (
        <p>
          Team Room needs your approval in T3 first. Choose <b>Supervised</b> or higher so it can start, message and stop threads. A pairing code is
          available from T3 <b>Settings → Sharing &amp; access</b> or <code>t3 auth pairing create</code>.
        </p>
      )}
    </div>
  );
}

/** The T3 driver of an agent's provider (claudeAgent, codex, grok, …), from the providers T3 lists or the instance id. */
function driverOf(_view: RoomView, p: Participant, providers?: ProviderInfo[]): string {
  return (providers ?? knownProviders).find((x) => x.instanceId === p.providerInstanceId)?.driver ?? p.providerInstanceId;
}
/** Providers from the latest status, for colouring agents where the status isn't passed down. */
let knownProviders: ProviderInfo[] = [];

// ------------------------------------------------------------------ new room
type AgentDraft = { providerInstanceId: string; model: string; options: Record<string, string | boolean> };

/** A new agent on a provider: its default model. Providers T3 has not enabled can't be picked. */
function draftFor(p: ProviderInfo | undefined): AgentDraft {
  return { providerInstanceId: p?.instanceId ?? "", model: p?.defaultModel ?? p?.models[0]?.slug ?? "", options: {} };
}

/** The provider for the next agent: Claude, then Codex, then any other enabled provider, then Claude again. */
function nextProvider(providers: ProviderInfo[], taken: AgentDraft[]): ProviderInfo | undefined {
  const on = providers.filter((p) => p.available);
  const used = new Set(taken.map((a) => a.providerInstanceId));
  const pref = ["claudeAgent", "codex"];
  return (
    pref.map((d) => on.find((p) => p.driver === d && !used.has(p.instanceId))).find(Boolean) ??
    on.find((p) => !used.has(p.instanceId)) ??
    on.find((p) => p.driver === "claudeAgent") ??
    on[0]
  );
}

function NewRoom({ status, onCancel, onCreate }: { status: T3Status; onCancel: () => void; onCreate: (b: unknown) => void }) {
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [projectId, setProjectId] = useState("");
  const [mode, setMode] = useState<"manual" | "auto">("auto");
  const [turnLimit, setTurnLimit] = useState(6);
  const [peerLimit, setPeerLimit] = useState(3);
  const cap = status.maxPermission;
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("approval-required");
  const [agents, setAgents] = useState<AgentDraft[]>(() => {
    const first = draftFor(nextProvider(status.providers, []));
    return [first, draftFor(nextProvider(status.providers, [first]))];
  });
  const setAgent = (i: number, a: AgentDraft) => setAgents(agents.map((x, j) => (j === i ? a : x)));
  const ready = agents.length >= MIN_AGENTS && agents.every((a) => a.providerInstanceId && a.model && status.providers.find((p) => p.instanceId === a.providerInstanceId)?.available);
  // An automatic round is three turns per agent; suggest a limit that fits one round.
  const roundTurns = agents.length * 3;
  const enabled = status.providers.filter((p) => p.available).length;
  const off = status.providers.filter((p) => !p.available);

  return (
    <form
      className="card new-room"
      onSubmit={(e) => {
        e.preventDefault();
        onCreate({ title, brief, projectId: projectId || null, mode, turnLimit, peerLimit, permissionMode, agents });
      }}
    >
      <h2>New room</h2>
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} required placeholder="e.g. Rate limiter design" />
      </label>
      <label>
        Task brief
        <textarea value={brief} onChange={(e) => setBrief(e.target.value)} required rows={6} placeholder="What should the team figure out? Constraints, goals, context." />
      </label>
      <label>
        Workspace
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">Scratch (no project — discussion only)</option>
          {status.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title} — {p.workspaceRoot}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="agents-field">
        <legend>
          Agents <span className="muted small">({agents.length} of up to {MAX_AGENTS})</span>
        </legend>
        <div className="agent-pickers">
          {agents.map((a, i) => (
            <AgentPicker
              key={i}
              label={`Agent ${i + 1}`}
              providers={status.providers}
              value={a}
              onChange={(v) => setAgent(i, v)}
              onRemove={agents.length > MIN_AGENTS ? () => setAgents(agents.filter((_, j) => j !== i)) : undefined}
            />
          ))}
        </div>
        <div className="agents-foot">
          <button type="button" disabled={agents.length >= MAX_AGENTS || !enabled} onClick={() => setAgents([...agents, draftFor(nextProvider(status.providers, agents))])}>
            + Add agent
          </button>
          {off.length > 0 && (
            <span className="muted small" title={off.map((p) => `${p.displayName}: ${p.unavailableReason ?? "unavailable"}`).join("\n")}>
              Not enabled in T3: {off.map((p) => p.displayName).join(", ")}. Turn providers on in T3’s settings to use them here.
            </span>
          )}
        </div>
      </fieldset>
      <div className="row">
        <label>
          Discussion mode
          <select value={mode} onChange={(e) => setMode(e.target.value as any)}>
            <option value="auto">Bounded automatic (propose → critique → respond)</option>
            <option value="manual">Manual (I choose who speaks)</option>
          </select>
        </label>
        <label title={`One automatic round is ${roundTurns} turns with ${agents.length} agents (each proposes, critiques and responds).`}>
          Automatic turn limit
          <input type="number" min={1} max={50} value={turnLimit} onChange={(e) => setTurnLimit(Number(e.target.value))} />
          {mode === "auto" && turnLimit < roundTurns && (
            <span className="small warn">
              A full round with {agents.length} agents takes {roundTurns}.{" "}
              <button type="button" className="link small" onClick={() => setTurnLimit(roundTurns)}>
                Use {roundTurns}
              </button>
            </span>
          )}
        </label>
        <label title="How many times the agents may pass questions to each other (@handle) before the room waits for you. 0 turns hand-offs off.">
          Agent hand-off limit
          <input type="number" min={0} max={20} value={peerLimit} onChange={(e) => setPeerLimit(Number(e.target.value))} />
        </label>
      </div>
      <label>
        Agent permissions (T3 runtime mode)
        <PermissionSelect value={permissionMode} onChange={setPermissionMode} cap={cap} />
      </label>
      <div className="actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary" type="submit" disabled={!ready}>
          Create room
        </button>
      </div>
    </form>
  );
}

/** Pick an agent: any provider T3 has (the ones it has not enabled are listed but can't be chosen), its model and thinking level. */
function AgentPicker(p: { label: string; providers: ProviderInfo[]; value: AgentDraft; onChange: (v: AgentDraft) => void; onRemove?: () => void }) {
  const info = p.providers.find((x) => x.instanceId === p.value.providerInstanceId);
  return (
    <fieldset className={`picker a-${info ? avatarKey(info.driver) : "agent"}`}>
      <legend>
        {info?.displayName ?? p.label}
        {p.onRemove && (
          <button type="button" className="link small muted-link picker-remove" onClick={p.onRemove} aria-label={`Remove ${p.label}`}>
            Remove
          </button>
        )}
      </legend>
      <select value={p.value.providerInstanceId} aria-label={`${p.label} provider`} onChange={(e) => p.onChange(draftFor(p.providers.find((x) => x.instanceId === e.target.value)))}>
        {!info && <option value="">Choose a provider</option>}
        {p.providers.map((o) => (
          <option key={o.instanceId} value={o.instanceId} disabled={!o.available}>
            {o.displayName}
            {o.available ? "" : " (off in T3)"}
          </option>
        ))}
      </select>
      {info?.models.length ? (
        <select value={p.value.model} aria-label={`${p.label} model`} onChange={(e) => p.onChange({ ...p.value, model: e.target.value, options: {} })}>
          {info.models.map((m) => (
            <option key={m.slug} value={m.slug}>
              {m.name}
            </option>
          ))}
        </select>
      ) : (
        <input value={p.value.model} aria-label={`${p.label} model`} placeholder="Model id (T3 lists none)" onChange={(e) => p.onChange({ ...p.value, model: e.target.value.trim() })} />
      )}
      <ThinkingSelect providers={p.providers} providerInstanceId={p.value.providerInstanceId} model={p.value.model} options={p.value.options} onChange={(o) => p.onChange({ ...p.value, options: o })} />
      {info && !info.available && <p className="warn small">{info.unavailableReason}</p>}
    </fieldset>
  );
}

/** Avatar colour family for a provider driver; providers without their own colour share a neutral one. */
function avatarKey(driver: string): string {
  if (driver === "claudeAgent") return "claude";
  return TONES.includes(driver) ? driver : "agent";
}
const TONES = ["codex", "grok", "cursor", "opencode", "antigravity", "kiro", "muse", "pi", "fx"];

// ---------------------------------------------------------------- room page
type Run = (fn: () => Promise<unknown>) => Promise<void>;

function RoomPage({
  view,
  run,
  webOrigin,
  maxPermission,
  providers,
  localModel,
}: {
  view: RoomView;
  run: Run;
  webOrigin: string | null;
  maxPermission: PermissionMode | null;
  providers: ProviderInfo[];
  localModel: LocalModelInfo;
}) {
  const { room } = view;
  const [approving, setApproving] = useState<{ body: string; sourceMessageId: string | null } | null>(null);
  const [reviewing, setReviewing] = useState<Waiting | null>(null);
  const waiting = waitingAgents(view);
  // Close the panel once T3 reports the agent is no longer waiting.
  const stillWaiting = reviewing ? waiting.some((w) => w.id === reviewing.id) : false;
  return (
    <div className="room">
      <section className="center">
        <RoomHeader view={view} run={run} waiting={waiting} />
        <ApprovalBanner view={view} waiting={waiting} canEmbed={!!webOrigin} onReview={setReviewing} />
        <QuestionsPanel view={view} run={run} />
        <Conversation view={view} run={run} localModel={localModel} onApprove={(m) => setApproving({ body: m.body, sourceMessageId: m.id })} />
        <Composer view={view} run={run} />
      </section>
      <aside className="panel">
        <Participants view={view} run={run} cap={maxPermission} providers={providers} />
        <Controls view={view} run={run} />
        {view.summary && room.phase === "discussion" && ["awaiting_decision", "paused", "idle"].includes(room.status) && (
          <DecisionSummary view={view} onApprove={(m) => setApproving({ body: m.body, sourceMessageId: m.id })} />
        )}
        <Pinned view={view} run={run} />
        <Execution view={view} run={run} cap={maxPermission} onApprove={() => setApproving({ body: "", sourceMessageId: null })} />
      </aside>
      {reviewing && webOrigin && (
        <T3ApprovalPanel item={reviewing} webOrigin={webOrigin} resolved={!stillWaiting} onClose={() => setReviewing(null)} />
      )}
      {approving && (
        <ApproveDialog
          initial={approving}
          onCancel={() => setApproving(null)}
          onApprove={(body) =>
            run(async () => {
              await api.approve(room.id, body, approving.sourceMessageId);
              setApproving(null);
            })
          }
        />
      )}
    </div>
  );
}


function waitingAgents(view: RoomView): Waiting[] {
  return [
    ...view.participants
      .filter((p) => p.status === "awaiting_input")
      .map((p) => ({ id: p.id, name: p.name, link: p.threadLink, threadId: p.threadId })),
    ...view.tasks
      .filter((t) => t.status === "awaiting_input")
      .map((t) => ({ id: t.id, name: `${nameIn(view, t.ownerKind)} (${t.kind})`, link: t.threadLink, threadId: t.threadId })),
  ];
}

/** Agents blocked on a T3 approval or question. */
function ApprovalBanner({ waiting, canEmbed, onReview }: { view: RoomView; waiting: Waiting[]; canEmbed: boolean; onReview: (w: Waiting) => void }) {
  if (!waiting.length) return null;
  return (
    <div className="approval-banner" role="status">
      <div>
        <b>{waiting.map((w) => w.name).join(" and ")}</b> {waiting.length > 1 ? "are" : "is"} waiting for your approval or answer.
      </div>
      <div className="approval-links">
        {waiting.map((w) =>
          w.link ? (
            <span key={w.id} className="approval-pair">
              <T3Link className="button primary" link={w.link}>
                Open {w.name} in T3 <Icon name="external" />
              </T3Link>
              {canEmbed && (
                <button onClick={() => onReview(w)} title="Show T3's approval screen inside Team Room">
                  Review here
                </button>
              )}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}

/**
 * T3's own thread screen, served by the local T3 server, shown inside the room. The approval is
 * made in T3's UI under T3's checks; this page cannot read the frame or T3's sign-in.
 */
function RoomHeader({ view, run, waiting }: { view: RoomView; run: Run; waiting: Waiting[] }) {
  const { room } = view;
  const shown = shownStatus(room, view.participants.map((p) => p.status), view.tasks.some((t) => ACTIVE_TASK.includes(t.status)));
  const [editing, setEditing] = useState(false);
  const [brief, setBrief] = useState(room.brief);
  const [open, setOpen] = useState(view.messages.length === 0);
  useEffect(() => {
    setBrief(room.brief);
  }, [room.brief]);
  return (
    <div className="room-header">
      <div className="title-row">
        <h1>{room.title}</h1>
        {waiting.length ? (
          <span className="status-pill s-approval" title={`Room: ${shown.label}`}>
            <i className="dot" />
            Waiting for your approval
          </span>
        ) : (
          <span className={`status-pill ${shown.cls}`}>
            <i className="dot" />
            {shown.label}
          </span>
        )}
        {!room.live && <span className="chip s-needs_attention">fixture</span>}
      </div>
      <div className="room-meta">
        <span title="Workspace">{room.projectTitle ?? "Scratch workspace"}</span>
        <span>{room.phase === "discussion" ? (room.mode === "auto" ? "Automatic discussion" : "Manual discussion") : "Execution"}</span>
        <span className="num" title="Automatic turns used / limit">
          Turns {room.turnsUsed}/{room.turnLimit}
        </span>
        <span title="T3 runtime mode for this room's agent threads">{PERMISSION_LABELS[room.permissionMode]}</span>
        <span className="num" title="Agent-to-agent hand-offs allowed in a row before the room waits for you">
          {room.peerLimit === 0 ? "Hand-offs off" : `Hand-offs up to ${room.peerLimit}`}
        </span>
      </div>
      {waiting.length > 0 ? (
        <div className="status-detail s-approval">
          {waiting.map((w) => w.name).join(" and ")} {waiting.length > 1 ? "are" : "is"} waiting for your approval in T3.
          {room.statusDetail ? <span className="muted"> Room: {room.statusDetail}</span> : null}
        </div>
      ) : (
        room.statusDetail && <div className={`status-detail s-${room.status}`}>{room.statusDetail}</div>
      )}
      <div className="brief">
        <button className={`disclosure ${open ? "open" : ""}`} aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="chevron" /> Task brief
        </button>
        {open &&
          (editing ? (
            <div>
              <textarea rows={5} value={brief} onChange={(e) => setBrief(e.target.value)} />
              <div className="actions">
                <button onClick={() => setEditing(false)}>Cancel</button>
                <button
                  className="primary"
                  onClick={() =>
                    run(async () => {
                      await api.patchRoom(room.id, { brief });
                      setEditing(false);
                    })
                  }
                >
                  Save brief
                </button>
              </div>
            </div>
          ) : (
            <div className="brief-body">
              <Md text={room.brief} />
              <button className="link small" onClick={() => setEditing(true)}>
                Edit brief
              </button>
            </div>
          ))}
      </div>
    </div>
  );
}

// Answers typed but not sent yet, per question, kept across reloads like composer drafts.
const answerDrafts = {
  get: (id: string) => {
    try {
      return sessionStorage.getItem(`answer:${id}`) ?? "";
    } catch {
      return "";
    }
  },
  set: (id: string, v: string) => {
    try {
      if (v) sessionStorage.setItem(`answer:${id}`, v);
      else sessionStorage.removeItem(`answer:${id}`);
    } catch {
      /* ignore */
    }
  },
};

/** Every open question the agents asked the human, in one place, answerable in one message. */
function QuestionsPanel({ view, run }: { view: RoomView; run: Run }) {
  const open = view.questions.filter((q) => q.status === "open");
  const recent = view.questions.filter((q) => q.status !== "open").slice(-3);
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries(open.map((q) => [q.id, answerDrafts.get(q.id)])));
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState(false);
  if (!open.length && !recent.length) return null;
  // The answer sent: the chosen option, the typed text, or both ("The server — use ptlabb03").
  const finalAnswer = (id: string) => [choices[id], (answers[id] ?? "").trim()].filter(Boolean).join(" — ");
  const filled = open.filter((q) => finalAnswer(q.id));
  const setAnswer = (id: string, v: string) => {
    setAnswers({ ...answers, [id]: v });
    answerDrafts.set(id, v);
  };
  const choose = (id: string, option: string) => setChoices({ ...choices, [id]: choices[id] === option ? "" : option });
  const jump = (seq: number) => document.getElementById(`msg-${seq}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const send = () =>
    run(async () => {
      await api.answerQuestions(
        view.room.id,
        filled.map((q) => ({ id: q.id, text: finalAnswer(q.id) })),
      );
      for (const q of filled) answerDrafts.set(q.id, "");
      setAnswers({});
      setChoices({});
    });
  if (!open.length)
    return (
      <div className="questions done">
        <span className="muted small">
          No open questions for you. Last handled: {recent.map((q) => `${nameIn(view, q.author)} #${q.seq} (${q.status})`).join(", ")}.
        </span>
      </div>
    );
  return (
    <section className="questions" aria-label="Questions for you">
      <header>
        <b>
          {open.length} question{open.length === 1 ? "" : "s"} for you
        </b>
        <span className="muted small">Answer any of them; they go back in one message.</span>
        <span className="spacer" />
        <button className="link small" onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? "Show" : "Hide"}
        </button>
      </header>
      {!collapsed && (
        <>
          <ol>
            {open.map((q) => (
              <li key={q.id} className={`a-${q.author}`}>
                <div className="q-head">
                  <Avatar who={q.author} />
                  <span className="q-text">{q.text}</span>
                </div>
                {q.options.length > 0 && (
                  <div className="q-options" role="radiogroup" aria-label={`Answers to: ${q.text}`}>
                    {q.options.map((o) => (
                      <button key={o} role="radio" aria-checked={choices[q.id] === o} className={choices[q.id] === o ? "on" : ""} onClick={() => choose(q.id, o)}>
                        {o}
                      </button>
                    ))}
                  </div>
                )}
                <div className="q-answer">
                  <textarea
                    rows={1}
                    value={answers[q.id] ?? ""}
                    placeholder={q.options.length ? (choices[q.id] ? "Add a note (optional)" : "Or write your own answer") : "Your answer"}
                    aria-label={`Answer to: ${q.text}`}
                    onChange={(e) => setAnswer(q.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && filled.length) send();
                    }}
                  />
                  <div className="q-actions">
                    <button className="link small" onClick={() => jump(q.seq)} title="Show the message it came from">
                      #{q.seq}
                    </button>
                    <button className="link small muted-link" onClick={() => run(() => api.dismissQuestion(view.room.id, q.id))} title="Not a question for you, or already handled">
                      Dismiss
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ol>
          <footer>
            <button className="primary" disabled={!filled.length} onClick={send}>
              Send {filled.length || ""} answer{filled.length === 1 ? "" : "s"}
            </button>
            <span className="muted small">
              {filled.length
                ? `Goes to ${[...new Set(filled.map((q) => nameIn(view, q.author)))].join(" and ")} as one message, each question quoted. Ctrl/⌘+Enter sends.`
                : "Unanswered questions stay here."}
            </span>
            <span className="spacer" />
            {open.length > 1 && (
              <button
                className="link small muted-link"
                onClick={() => confirm(`Dismiss all ${open.length} questions?`) && run(async () => { for (const q of open) await api.dismissQuestion(view.room.id, q.id); })}
              >
                Dismiss all
              </button>
            )}
          </footer>
        </>
      )}
    </section>
  );
}

type LocalDigest = NonNullable<RoomView["localDigests"]>[number];
type Point = { digest: Digest; summary: RoomMessage | null; pending: string | null; lastAgent: string; names: Record<string, string>; local: LocalDigest | null };
type LocalModelInfo = { available: boolean; model: string | null; detail: string | null } | null;

/** After each stretch of agent discussion between the human's messages: its automatic digest, and any agent summary. */
function digestPoints(view: RoomView): Map<number, Point> {
  const points = new Map<number, Point>();
  const summaries = view.messages.filter((m) => m.kind === "summary" && Array.isArray(m.meta.range));
  const names = Object.fromEntries([...view.participants, ...(view.formerParticipants ?? [])].map((p) => [p.kind, p.name]));
  for (const { from, to } of stretches(view.messages)) {
    const summary = [...summaries].reverse().find((s) => s.meta.range[0] <= from && s.meta.range[1] >= to) ?? null;
    const open = view.deliveries.find(
      (d) => d.purpose === "summary" && ["pending", "held", "sending", "accepted"].includes(d.state) && Math.min(...d.messageSeqs) <= from && Math.max(...d.messageSeqs) >= to,
    );
    const pending = open ? (view.participants.find((p) => p.id === open.participantId)?.name ?? "An agent") : null;
    // The server asks the last agent in the range that is still in the room.
    const here = view.participants.map((p) => p.kind);
    const lastAgent = [...view.messages].reverse().find((m) => m.seq >= from && m.seq <= to && here.includes(m.author))?.author ?? here[0];
    const local = view.localDigests?.find((x) => x.from === from && x.to === to) ?? null;
    points.set(to, { digest: digest(view.messages, from, to, Object.keys(names)), summary, pending, lastAgent: nameIn(view, lastAgent), names, local });
  }
  return points;
}

const FIRST_SHOWN: DigestCategory[] = ["needsYou", "blocked"];
const DIGEST_ORDER: DigestCategory[] = ["needsYou", "blocked", "decided", "disputed", "next"];

function DigestCard({ point, roomId, run, latest, newest, localModel }: { point: Point; roomId: string; run: Run; latest: boolean; newest: boolean; localModel: LocalModelInfo }) {
  const d = point.digest;
  const local = point.local;
  const done = local?.status === "done" && local.body ? local : null;
  const [open, setOpen] = useState(false);
  const [folded, setFolded] = useState(!newest);
  if (folded) {
    const counts = DIGEST_ORDER.filter((c) => d.lines[c].length).map((c) => `${d.lines[c].length} ${DIGEST_LABELS[c].toLowerCase()}`);
    const gist = done ? done.body!.replace(/\*\*[^*]+\*\*[\s\S]*$/, "").replace(/\s+/g, " ").trim().slice(0, 140) : "";
    return (
      <button className="digest-folded" onClick={() => setFolded(false)} title="Show this digest">
        <b>Digest #{d.from}–#{d.to}</b> {gist ? `· ${gist}` : counts.length ? `· ${counts.join(" · ")}` : "· nothing flagged"}
        {point.summary ? ` · agent summary in #${point.summary.seq}` : ""}
      </button>
    );
  }
  const cats = DIGEST_ORDER.filter((c) => d.lines[c].length);
  // Collapsed: the lines that need the human, or the newest next steps if nothing does.
  const shown = open ? cats : cats.filter((c) => FIRST_SHOWN.includes(c)).length ? cats.filter((c) => FIRST_SHOWN.includes(c)) : cats.filter((c) => c === "next" || c === "decided").slice(0, 1);
  const hidden = cats.length - shown.length;
  const jump = (seq: number) => document.getElementById(`msg-${seq}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <aside className="digest" aria-label={`Digest of messages ${d.from} to ${d.to}`}>
      <header>
        <b>Digest #{d.from}–#{d.to}</b>
        <span className="muted">
          {Object.entries(d.replies)
            .map(([k, n]) => `${point.names[k] ?? k} ${n}`)
            .join(" · ")}
          {latest ? " · so far" : ""}
        </span>
        <span className="spacer" />
        <span
          className="muted digest-note"
          title={done ? `Written on this Mac by ${done.model} (Ollama). Costs nothing against your agents' plans.` : "Built from the agents' own section headings and phrasing. No model is used, so it costs nothing."}
        >
          {done ? `${done.model} · local, free` : "automatic · no AI"}
        </span>
      </header>
      {done ? (
        <div className="digest-local">
          <Md text={done.body!} />
        </div>
      ) : local && (local.status === "queued" || local.status === "running") ? (
        <p className="muted small digest-wait">
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>{" "}
          Summarizing locally with {local.model}…
        </p>
      ) : null}
      {(!done || open) && d.topics.length > 0 && <div className="digest-topics">{d.topics.slice(0, open ? 6 : 3).join(" · ")}</div>}
      {(!done || open) && shown.map((c) => (
        <div key={c} className={`digest-cat dc-${c}`}>
          <span className="digest-label">{DIGEST_LABELS[c]}</span>
          <ul>
            {(open ? d.lines[c] : d.lines[c].slice(-3)).map((l, i) => (
              <li key={i}>
                <button className="link digest-src" onClick={() => jump(l.seq)} title={`Go to #${l.seq}`}>
                  {point.names[l.author] ?? l.author} #{l.seq}
                </button>{" "}
                {l.text}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {!done && !cats.length && <p className="muted small">No decisions, questions, blockers or next steps stated in so many words.</p>}
      {local?.status === "failed" && <p className="warn small">Local summary failed: {local.error}</p>}
      <footer>
        {done ? (
          <button className="link small" onClick={() => setOpen(!open)}>
            {open ? "Hide details" : "Details, with links to each message"}
          </button>
        ) : (
          (hidden > 0 || open) && (
            <button className="link small" onClick={() => setOpen(!open)}>
              {open ? "Show less" : `Show all (${hidden} more section${hidden === 1 ? "" : "s"})`}
            </button>
          )
        )}
        {!done && localModel?.available && (!local || local.status === "failed") && (
          <button className="link small" onClick={() => run(() => api.localDigest(roomId, d.from, d.to))} title={`Summarized on this Mac by ${localModel.model}; costs nothing against your plans.`}>
            Summarize locally (free)
          </button>
        )}
        <span className="spacer" />
        {point.summary ? (
          <button className="link small" onClick={() => jump(point.summary!.seq)}>
            Agent summary in #{point.summary.seq}
          </button>
        ) : point.pending ? (
          <span className="small muted">{point.pending} is writing a summary…</span>
        ) : (
          <button
            className="link small muted-link"
            onClick={() => run(() => api.summarize(roomId, { from: d.from, to: d.to }))}
            title="Asks the agent who spoke last to write a summary. Uses one agent turn."
          >
            Ask {point.lastAgent} for a fuller summary (uses a turn)
          </button>
        )}
      </footer>
    </aside>
  );
}

function Conversation({ view, run, onApprove, localModel }: { view: RoomView; run: Run; onApprove: (m: RoomMessage) => void; localModel: LocalModelInfo }) {
  const points = digestPoints(view);
  const lastPoint = Math.max(0, ...points.keys());
  const lastHuman = [...view.messages].reverse().find((m) => m.author === "human")?.seq ?? 0;
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Follow new messages only while the human is at the bottom; reading further up is never interrupted.
  const stick = useRef(true);
  const lastSeq = view.messages.at(-1)?.seq ?? 0;
  const [seenSeq, setSeenSeq] = useState(lastSeq);
  const toBottom = () => {
    endRef.current?.scrollIntoView({ block: "end" });
    stick.current = true;
    setSeenSeq(lastSeq);
  };
  // Block body: scrollIntoView returns a Promise in current Chromium, which React would treat as a cleanup.
  useEffect(() => {
    const newest = view.messages.at(-1);
    const sentByHuman = !!newest && newest.author === "human" && newest.seq > seenSeq;
    if (stick.current || sentByHuman) toBottom();
  }, [view]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (stick.current && seenSeq !== lastSeq) setSeenSeq(lastSeq);
  };
  const unseen = view.messages.filter((m) => m.seq > seenSeq && m.author !== "system").length;
  const working = view.participants.filter((p) => p.status === "working" || p.status === "queued");
  return (
    <div className="conversation" ref={scrollRef} onScroll={onScroll}>
      <div className="conversation-inner">
        {view.messages.map((m) => (
          <Fragment key={m.id}>
            <Message m={m} view={view} onApprove={onApprove} />
            {points.has(m.seq) && <DigestCard point={points.get(m.seq)!} roomId={view.room.id} run={run} latest={m.seq === lastPoint && lastPoint > lastHuman} newest={m.seq === lastPoint} localModel={localModel} />}
          </Fragment>
        ))}
        {working.map((p) => (
          <div key={p.id} className={`typing a-${avatarKey(driverOf(view, p))}`} role="status">
            <span className="dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {p.name} is {p.status === "queued" ? "queued in T3" : "working in T3"}
          </div>
        ))}
        <div ref={endRef} />
        {unseen > 0 && (
          <button className="new-msgs" onClick={toBottom}>
            {unseen} new message{unseen === 1 ? "" : "s"} <Icon name="chevron" />
          </button>
        )}
      </div>
    </div>
  );
}

function Message({ m, view, onApprove }: { m: RoomMessage; view: RoomView; onApprove: (m: RoomMessage) => void }) {
  if (m.author === "system")
    return (
      <div className="system-msg" role="note">
        <span>{m.body}</span>
      </div>
    );
  const isAgent = m.author !== "human";
  const participant = isAgent ? [...view.participants, ...(view.formerParticipants ?? [])].find((p) => p.kind === m.author) : null;
  const task = m.meta.taskId ? view.tasks.find((t) => t.id === m.meta.taskId) : null;
  const link = task?.threadLink ?? participant?.threadLink;
  const to = m.recipients.includes("all") ? "everyone" : m.recipients.map((r) => nameIn(view, r)).join(", ");
  // Room-thread replies can become the plan, or replace it once no task is running.
  const planLike = isAgent && !m.meta.taskId && ["proposal", "response", "reply"].includes(m.kind) && !view.tasks.some((t) => ACTIVE_TASK.includes(t.status));
  return (
    <article id={`msg-${m.seq}`} className={`msg a-${participant ? avatarKey(driverOf(view, participant)) : m.author} k-${m.kind}`}>
      <Avatar who={m.author} name={participant?.name} tone={participant ? avatarKey(driverOf(view, participant)) : undefined} />
      <div className="msg-main">
      <header>
        <span className="author">{nameIn(view, m.author)}</span>
        {KIND_LABEL[m.kind] && <span className="kind">{KIND_LABEL[m.kind]}{m.kind === "summary" && Array.isArray(m.meta.range) ? ` of #${m.meta.range[0]}–#${m.meta.range[1]}` : ""}</span>}
        {m.author === "human" && m.kind !== "decision" && <span className="muted small">→ {to}</span>}
        {m.meta.untracked && <span className="chip small">outside room turn · not relayed</span>}
        <span className="spacer" />
        {m.author === "human" && m.deliveryState && m.deliveryState !== "recorded" && <DeliveryBadge m={m} view={view} />}
        {m.meta.runStatus && m.meta.runStatus !== "completed" && <span className="chip s-needs_attention small">run {m.meta.runStatus}</span>}
        <time className="msg-time" dateTime={m.createdAt}>
          {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </time>
      </header>
      <Md text={m.body} />
      {m.meta.verification && (
        <div className="verification">
          <b>Reported verification</b>
          <Md text={m.meta.verification} />
        </div>
      )}
      {isAgent && (link || planLike) && (
        <footer className="msg-actions">
          {planLike && (
            <button className="link" onClick={() => onApprove(m)}>
              {view.room.phase === "discussion" ? "Approve as plan…" : "Approve as revised plan…"}
            </button>
          )}
          {link && (
            <T3Link link={link} title={m.runId ? `Run ${m.runId} · open in the T3 app` : undefined}>
              Open in T3 <Icon name="external" />
            </T3Link>
          )}
        </footer>
      )}
      </div>
    </article>
  );
}

function DeliveryBadge({ m, view }: { m: RoomMessage; view: RoomView }) {
  const per = (m.meta.perTarget ?? {}) as Record<string, string>;
  const label: Record<string, string> = {
    pending: "waiting to send",
    sending: "sending…",
    delivered: "delivered",
    queued: "queued in T3",
    uncertain: "delivery uncertain",
    failed: "failed",
  };
  const parts = Object.entries(per);
  return (
    <span className={`chip small d-${m.deliveryState}`} title="Confirmed by T3's response to the send request">
      {parts.length ? parts.map(([k, v]) => `${nameIn(view, k)}: ${label[v] ?? v}`).join(" · ") : label[m.deliveryState!] ?? m.deliveryState}
    </span>
  );
}

// Unsent drafts per room, kept while the page is open.
// Kept in sessionStorage so they survive the automatic reload after an update.
const drafts = {
  get: (id: string) => {
    try {
      return sessionStorage.getItem(`draft:${id}`);
    } catch {
      return null;
    }
  },
  set: (id: string, v: string) => {
    try {
      sessionStorage.setItem(`draft:${id}`, v);
    } catch {
      /* private mode: drafts last until the page closes */
    }
  },
  delete: (id: string) => {
    try {
      sessionStorage.removeItem(`draft:${id}`);
    } catch {
      /* ignore */
    }
  },
};

function Composer({ view, run }: { view: RoomView; run: Run }) {
  const roomId = view.room.id;
  const [text, setTextState] = useState(() => drafts.get(roomId) ?? "");
  const setText = (v: string) => {
    setTextState(v);
    if (v) drafts.set(roomId, v);
    else drafts.delete(roomId);
  };
  const [target, setTarget] = useState<string>("all");
  const [pin, setPin] = useState<"" | "decision" | "constraint">("");
  const [order, setOrder] = useState<ReplyOrder>("parallel");
  const disabled = view.room.status === "setting_up";
  const agents = view.participants;
  const handles = agents.map((p) => p.kind);
  // Mirrors the server: @mentions of the room's agents override "To".
  const mentions = [...text.matchAll(/(^|[\s(])@([a-z][a-z0-9_-]*)\b/gi)].map((m) => m[2].toLowerCase()).filter((k) => k === "all" || k === "everyone" || handles.includes(k));
  const addressed = mentions.length
    ? mentions.includes("all") || mentions.includes("everyone")
      ? handles
      : handles.filter((k) => mentions.includes(k))
    : target === "all"
      ? handles
      : handles.includes(target)
        ? [target]
        : [];
  const several = addressed.length > 1;
  // A chosen first agent that is no longer addressed falls back to everyone at once.
  const replyOrder: ReplyOrder = addressed.includes(order) ? order : "parallel";
  const send = () =>
    run(async () => {
      await api.post(view.room.id, { body: text, target, pin: pin || null, order: several ? replyOrder : undefined });
      setText("");
      setPin("");
    });
  return (
    <div className="composer">
      <div className="composer-box">
      <textarea
        value={text}
        rows={3}
        disabled={disabled}
        aria-label="Message"
        placeholder={`Message the team. Use ${handles.map((k) => `@${k}`).join(", ")} or @all to address someone.`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) send();
        }}
      />
      <div className="composer-row">
        <div className="composer-options">
        <label className="inline">
          To
          <select value={target} onChange={(e) => setTarget(e.target.value as any)}>
            <option value="all">Everyone ({agents.length === 2 ? "both reply" : `all ${agents.length} reply`})</option>
            {agents.map((p) => (
              <option key={p.kind} value={p.kind}>
                {p.name}
              </option>
            ))}
            <option value="room">Room note (no reply; sent with next turn)</option>
          </select>
        </label>
        {several && (
          <label className="inline" title="Who answers first. The others get that answer and build on it.">
            Order
            <select value={replyOrder} onChange={(e) => setOrder(e.target.value as ReplyOrder)}>
              <option value="parallel">{addressed.length === 2 ? "Both" : "All"} at once, first answer passed on</option>
              {addressed.map((k) => (
                <option key={k} value={k}>
                  {nameIn(view, k)} first, then the {addressed.length === 2 ? "other" : "others"}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="inline">
          Pin as
          <select value={pin} onChange={(e) => setPin(e.target.value as any)}>
            <option value="">—</option>
            <option value="decision">Decision</option>
            <option value="constraint">Constraint</option>
          </select>
        </label>
        </div>
        <button className="primary" disabled={!text.trim() || disabled} onClick={send}>
          Send
        </button>
      </div>
      </div>
      <p className="composer-hint">@mentions override “To”. Your message pauses automatic discussion. Ctrl/⌘+Enter sends.</p>
    </div>
  );
}

const P_LABEL: Record<Participant["status"], string> = {
  connecting: "Connecting",
  ready: "Ready",
  queued: "Queued",
  working: "Working",
  awaiting_input: "Awaiting approval/input",
  stopping: "Stopping",
  stopped: "Stopped",
  failed: "Failed",
  complete: "Complete",
};

function Participants({ view, run, cap, providers }: { view: RoomView; run: Run; cap: PermissionMode | null; providers: ProviderInfo[] }) {
  const participants = view.participants;
  const [moving, setMoving] = useState(false);
  const [adding, setAdding] = useState<AgentDraft | null>(null);
  const settingUp = view.room.status === "setting_up";
  return (
    <section className="card">
      <h3>Participants</h3>
      <div className="participant human">
        <Avatar who="human" />
        <div className="p-info">
          <div className="p-name">You</div>
          <div className="muted small">Lead</div>
        </div>
      </div>
      {participants.map((p) => (
        <div key={p.id} className={`participant a-${avatarKey(driverOf(view, p, providers))}`}>
          <Avatar who={p.kind} name={p.name} tone={avatarKey(driverOf(view, p, providers))} />
          <div className="p-info">
            <div className="p-row">
              <span className="p-name">{p.name}</span>
              <span className="muted small p-handle">@{p.kind}</span>
              <span className={`chip ps-${p.status}`}>{p.transfer ? "Moving" : P_LABEL[p.status]}</span>
            </div>
            <div className="muted small">
              {providers.find((x) => x.instanceId === p.providerInstanceId)?.displayName ?? p.providerInstanceId}
              {p.threadMode && ` · ${PERMISSION_LABELS[p.threadMode]}`}
            </div>
            <ModelSelect providers={providers} participant={p} onChange={(model) => run(() => api.agentModel(view.room.id, p.kind, model))} />
            <ThinkingSelect
              compact
              providers={providers}
              providerInstanceId={p.providerInstanceId}
              model={p.model}
              options={p.options ?? {}}
              onChange={(o) => run(() => api.agentOptions(view.room.id, p.kind, o))}
            />
            {p.statusDetail && <div className={`small ${p.status === "failed" || p.status === "awaiting_input" ? "warn" : "muted"}`}>{p.statusDetail}</div>}
            {p.threadLink ? (
              <T3Link className="small" link={p.threadLink}>
                Open thread in T3 <Icon name="external" />
              </T3Link>
            ) : (
              p.threadId && <span className="small muted">thread {p.threadId}</span>
            )}
            {participants.length > 1 && (
              <button
                className="link small muted-link p-remove"
                disabled={settingUp}
                onClick={() =>
                  confirm(`Remove ${p.name} from this room? It stops getting turns. Its messages stay here and its thread stays in T3.`) &&
                  run(() => api.removeAgent(view.room.id, p.kind))
                }
              >
                Remove from room
              </button>
            )}
            {p.previousThreads.length > 0 && (
              <span className="small muted">
                Earlier thread{p.previousThreads.length > 1 ? "s" : ""}:{" "}
                {p.previousThreads.map((t, i) => (
                  <T3Link key={t.threadId} link={t.link} title={`${PERMISSION_LABELS[t.mode]} · until ${new Date(t.endedAt).toLocaleString()} · open in the T3 app`}>
                    {i ? ", " : ""}#{i + 1}
                  </T3Link>
                ))}
              </span>
            )}
          </div>
        </div>
      ))}
      {(view.formerParticipants ?? []).length > 0 && (
        <p className="muted small">Left the room: {(view.formerParticipants ?? []).map((p) => p.name).join(", ")}</p>
      )}
      {adding ? (
        <div className="add-agent">
          <AgentPicker label="New agent" providers={providers} value={adding} onChange={setAdding} />
          <p className="muted small">It starts in a new T3 thread with the room’s record (brief, decisions, tasks, transcript) and introduces itself.</p>
          <div className="actions">
            <button onClick={() => setAdding(null)}>Cancel</button>
            <button
              className="primary"
              disabled={!adding.providerInstanceId || !adding.model || !providers.find((x) => x.instanceId === adding.providerInstanceId)?.available}
              onClick={() =>
                run(async () => {
                  await api.addAgent(view.room.id, adding);
                  setAdding(null);
                })
              }
            >
              Add to room
            </button>
          </div>
        </div>
      ) : (
        <button
          className="block"
          disabled={participants.length >= MAX_AGENTS || settingUp || !providers.some((x) => x.available)}
          title={participants.length >= MAX_AGENTS ? `A room has at most ${MAX_AGENTS} agents.` : undefined}
          onClick={() => setAdding(draftFor(nextProvider(providers, participants)))}
        >
          + Add an agent…
        </button>
      )}
      <button className="block move-btn" disabled={participants.some((p) => p.transfer) || settingUp} onClick={() => setMoving(true)}>
        Move to new threads…
      </button>
      {moving && <TransferDialog view={view} cap={cap} onCancel={() => setMoving(false)} onMove={(b) => run(async () => { await api.transfer(view.room.id, b); setMoving(false); })} />}
    </section>
  );
}

/** Switch an agent's model (same provider); T3 applies it to the running thread from its next turn. */
function ModelSelect({ providers, participant: p, onChange }: { providers: ProviderInfo[]; participant: Participant; onChange: (model: string) => void }) {
  const models = providers.find((x) => x.instanceId === p.providerInstanceId)?.models ?? [];
  if (!models.length) return null;
  const known = models.some((m) => m.slug === p.model);
  return (
    <span className="thinking-inline">
      Model
      <select value={p.model} aria-label={`${p.name}'s model`} onChange={(e) => e.target.value !== p.model && onChange(e.target.value)}>
        {!known && <option value={p.model}>{p.model}</option>}
        {models.map((m) => (
          <option key={m.slug} value={m.slug}>
            {m.name}
          </option>
        ))}
      </select>
    </span>
  );
}

function TransferDialog({ view, cap, onCancel, onMove }: { view: RoomView; cap: PermissionMode | null; onCancel: () => void; onMove: (b: { mode: string; agents: string[]; handoff: boolean }) => void }) {
  const [mode, setMode] = useState<PermissionMode>(cap ?? view.room.permissionMode);
  const [agents, setAgents] = useState<AgentKind[]>(view.participants.map((p) => p.kind));
  const [handoff, setHandoff] = useState(true);
  const busy = view.participants.filter((p) => agents.includes(p.kind) && ["working", "queued", "awaiting_input"].includes(p.status));
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal transfer" role="dialog" aria-label="Move agents to new threads" onClick={(e) => e.stopPropagation()}>
        <h2>Move agents to new threads</h2>
        <p className="muted small">
          T3 keeps a thread's permissions for its whole life, so the agents continue in fresh T3 threads started with the permissions you choose. Their
          current threads stay in T3 and are linked here.
        </p>
        <label className="stack">
          Permissions for the new threads
          <PermissionSelect value={mode} onChange={setMode} cap={cap} />
        </label>
        <div className="checks">
          <span>Move</span>
          {view.participants.map((p) => (
            <label key={p.kind} className="inline">
              <input type="checkbox" checked={agents.includes(p.kind)} onChange={(e) => setAgents(e.target.checked ? [...agents, p.kind] : agents.filter((k) => k !== p.kind))} />
              {p.name}
              {p.threadMode ? <span className="muted small"> (now {PERMISSION_LABELS[p.threadMode]})</span> : null}
            </label>
          ))}
        </div>
        <label className="inline">
          <input type="checkbox" checked={handoff} onChange={(e) => setHandoff(e.target.checked)} />
          Ask each agent for a handoff note first
        </label>
        <div className="carry">
          <b>Carried into each new thread</b>
          <ul className="small">
            <li>The task brief, approved plan and pinned decisions</li>
            <li>Implementation tasks so far, with their worktrees</li>
            <li>The room transcript ({view.messages.length} messages; the newest in full, older ones summarized if it is long)</li>
            {handoff && <li>The agent's own handoff note: files it read, commands it ran, reasoning, open questions, next step</li>}
          </ul>
          <span className="muted small">Not carried: anything the agent never wrote down. The handoff note is how that gets across.</span>
        </div>
        {busy.length > 0 && <p className="warn small">{busy.map((p) => p.name).join(", ")} {busy.length > 1 ? "are" : "is"} mid-turn; Team Room stops that turn first.</p>}
        <div className="actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={!agents.length} onClick={() => onMove({ mode, agents, handoff })}>
            Move {agents.length === view.participants.length && agents.length > 1 ? (agents.length === 2 ? "both" : `all ${agents.length}`) : agents.length === 1 ? view.participants.find((p) => p.kind === agents[0])?.name : `${agents.length} agents`}
          </button>
        </div>
      </div>
    </div>
  );
}

function Controls({ view, run }: { view: RoomView; run: Run }) {
  const { room } = view;
  const id = room.id;
  const s = room.status;
  const discussion = room.phase === "discussion";
  const [limit, setLimit] = useState(room.turnLimit);
  useEffect(() => {
    setLimit(room.turnLimit);
  }, [room.turnLimit]);
  const [peerLimit, setPeerLimit] = useState(room.peerLimit);
  useEffect(() => {
    setPeerLimit(room.peerLimit);
  }, [room.peerLimit]);
  const busy = s === "setting_up" || s === "reconciling";
  return (
    <section className="card">
      <h3>Discussion</h3>
      <div className="btn-grid">
        {discussion && room.autoStep === 0 && (
          <button className="primary" disabled={busy || s === "stopping"} onClick={() => run(() => api.action(id, "auto/start"))}>
            Start automatic round
          </button>
        )}
        {discussion && room.autoStep > 0 && (
          <button className="primary" disabled={busy || s === "running" || s === "stopping"} onClick={() => run(() => api.action(id, "continue"))}>
            Continue discussion
          </button>
        )}
        <button disabled={busy || s === "paused" || s === "stopping"} onClick={() => run(() => api.action(id, "pause"))} title="Stop scheduling new turns; running turns finish">
          Pause
        </button>
        <button className="danger" disabled={busy || s === "stopping"} onClick={() => run(() => api.action(id, "stop"))} title="Ask T3 to interrupt every running agent">
          Stop agents
        </button>
        <button disabled={!["paused", "needs_attention", "stopping"].includes(s)} onClick={() => run(() => api.action(id, "resume"))} title="Re-read T3, reconcile, then continue">
          Resume
        </button>
      </div>
      <div className="segmented" role="group" aria-label="Ask for a turn">
        {view.participants.map((p) => (
          <button key={p.kind} disabled={busy} onClick={() => run(() => api.ask(id, p.kind))}>
            Ask {p.name.replace(/ Code\b/, "")}
          </button>
        ))}
        <button disabled={busy} onClick={() => run(() => api.ask(id, "all"))}>
          Ask everyone
        </button>
      </div>
      <div className="limits">
        <label htmlFor="turn-limit">Turn limit</label>
        <input id="turn-limit" type="number" min={1} max={50} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
        <button disabled={limit === room.turnLimit} onClick={() => run(() => api.patchRoom(id, { turnLimit: limit }))}>
          Set
        </button>
        <label htmlFor="peer-limit" title="Agent-to-agent hand-offs in a row before the room waits for you. 0 turns them off.">
          Hand-off limit
        </label>
        <input id="peer-limit" type="number" min={0} max={20} value={peerLimit} onChange={(e) => setPeerLimit(Number(e.target.value))} />
        <button disabled={peerLimit === room.peerLimit} onClick={() => run(() => api.patchRoom(id, { peerLimit }))}>
          Set
        </button>
      </div>
    </section>
  );
}

function DecisionSummary({ view, onApprove }: { view: RoomView; onApprove: (m: RoomMessage) => void }) {
  const s = view.summary!;
  const msg = (id: string) => view.messages.find((m) => m.id === id)!;
  return (
    <section className="card summary">
      <h3>For your decision</h3>
      {s.limitReached && <p className="warn small">Turn limit reached.</p>}
      {s.proposals.map((p) => (
        <div key={p.messageId} className={`proposal a-${p.author}`}>
          <b>{nameIn(view, p.author)}’s proposal</b>
          <p className="small">{p.excerpt}…</p>
          <button className="link small" onClick={() => onApprove(msg(p.messageId))}>
            Approve as plan…
          </button>
        </div>
      ))}
      {s.sections.map((sec) => (
        <div key={sec.author} className="sections">
          <b>{nameIn(view, sec.author)} reports</b>
          <List title="Agreements" items={sec.agreements} />
          <List title="Disagreements" items={sec.disagreements} />
          <List title="Questions for you" items={sec.questions} />
        </div>
      ))}
      <p className="muted small">Sections are quoted from each agent’s final response; Team Room does not summarize with a model.</p>
    </section>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="small">
      <div className="muted">{title}</div>
      <ul>
        {items.map((i, n) => (
          <li key={n}>{i}</li>
        ))}
      </ul>
    </div>
  );
}

function Pinned({ view, run }: { view: RoomView; run: Run }) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState("constraint");
  return (
    <section className="card">
      <h3>Pinned decisions &amp; constraints</h3>
      {!view.decisions.length && <p className="muted small">Nothing pinned. Pinned items are sent to agents as binding context.</p>}
      <ul className="pins">
        {view.decisions.map((d) => (
          <PinItem key={d.id} d={d} onToggle={() => run(() => api.setDecisionActive(view.room.id, d.id, !d.active))} />
        ))}
      </ul>
      <div className="pin-add">
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="constraint">Constraint</option>
          <option value="decision">Decision</option>
        </select>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. No new dependencies" />
        <button
          disabled={!text.trim()}
          onClick={() =>
            run(async () => {
              await api.pin(view.room.id, kind, text);
              setText("");
            })
          }
        >
          Pin
        </button>
      </div>
    </section>
  );
}

function PinItem({ d, onToggle }: { d: RoomView["decisions"][number]; onToggle: () => void }) {
  const long = d.body.length > 280;
  const [expanded, setExpanded] = useState(false);
  return (
    <li className={d.active ? "" : "inactive"}>
      <div className="pin-head">
        <span className="chip small">{d.kind.replace("_", " ")}</span>
        <span className="spacer" />
        {d.kind !== "approved_plan" && (
          <button className="link small" onClick={onToggle}>
            {d.active ? "Unpin" : "Re-pin"}
          </button>
        )}
      </div>
      <div className={`pin-body ${long && !expanded ? "clamped" : ""}`}>
        <Md text={d.body} />
      </div>
      {long && (
        <button className="link small" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Show all"}
        </button>
      )}
    </li>
  );
}


const ACTIVE_TASK: Task["status"][] = ["queued", "launching", "working", "awaiting_input"];

const STRATEGY_HINT: Record<TaskStrategy, string> = {
  solo: "One agent builds in a new worktree; another reviews it without editing.",
  turns: "Each agent with a part builds it, one after the other, in the same worktree, so there is never more than one writer. Then each part is reviewed by the next agent.",
  parallel: "Each agent with a part builds it at the same time, in its own worktree and branch. Then each part is reviewed by the next agent. You combine the branches.",
};

const T_LABEL: Record<Task["status"], string> = {
  queued: "Queued",
  launching: "Launching",
  working: "Working",
  awaiting_input: "Awaiting approval/input",
  completed: "Complete",
  failed: "Failed",
  stopped: "Stopped",
  uncertain: "Uncertain",
};

function Execution({ view, run, cap, onApprove }: { view: RoomView; run: Run; cap: PermissionMode | null; onApprove: () => void }) {
  const { room } = view;
  const plan = [...view.decisions].reverse().find((d) => d.kind === "approved_plan" && d.active);
  const agents = view.participants;
  const kinds = agents.map((p) => p.kind);
  const [chosen, setImplementer] = useState<AgentKind>(kinds[0] ?? "");
  const implementer = kinds.includes(chosen) ? chosen : (kinds[0] ?? "");
  // "" = the next agent in the room, as the server picks by default.
  const [reviewerChoice, setReviewer] = useState<AgentKind>("");
  const reviewer = reviewerChoice && reviewerChoice !== implementer && kinds.includes(reviewerChoice) ? reviewerChoice : "";
  const nextAfter = (k: AgentKind) => kinds[(kinds.indexOf(k) + 1) % kinds.length];
  const [strategy, setStrategy] = useState<TaskStrategy>("solo");
  const [title, setTitle] = useState("");
  const [spec, setSpec] = useState("");
  const [parts, setParts] = useState<Record<AgentKind, string>>({});
  const joint = strategy !== "solo";
  const [baseRef, setBaseRef] = useState("HEAD");
  const taking = kinds.filter((k) => (parts[k] ?? "").trim());
  const ready = title.trim() && (joint ? taking.length >= 2 : spec.trim()) && (!joint || !room.projectId || baseRef.trim());
  // Joint parts in build order: who goes first, then the room's order.
  const partOrder = strategy === "turns" ? [implementer, ...kinds.filter((k) => k !== implementer)] : kinds;
  const [note, setNote] = useState("");
  const activeTask = view.tasks.some((t) => ACTIVE_TASK.includes(t.status));
  // Parts of the latest job that have a finished review, for per-part change requests.
  const lastJob = [...view.tasks].reverse().find((t) => t.kind === "implement")?.jobId;
  const reviewedParts = view.tasks.filter(
    (t) => t.kind === "implement" && t.jobId === lastJob && view.tasks.some((r) => r.kind === "review" && r.parentTaskId === t.id && r.status === "completed"),
  );
  return (
    <section className="card">
      <h3>Execution</h3>
      <label className="stack small perm-select" title="Applies to threads this room starts from now on. T3 keeps an existing thread's mode, so the discussion threads stay as they are.">
        Agent permissions for new tasks
        <PermissionSelect value={room.permissionMode} onChange={(m) => run(() => api.patchRoom(room.id, { permissionMode: m }))} cap={cap} />
      </label>
      {!plan ? (
        <>
          <p className="muted small">Discussion never starts implementation. Approve a plan first.</p>
          <button onClick={onApprove}>Approve a plan…</button>
        </>
      ) : (
        <>
          {!activeTask && (
            <button className="link small revise-plan" onClick={onApprove}>
              Approve a revised plan…
            </button>
          )}
          {!activeTask && room.status !== "review_ready" && (
            <div className="task-form">
              <label className="stack small">
                Who builds it
                <select value={strategy} onChange={(e) => setStrategy(e.target.value as TaskStrategy)}>
                  <option value="solo">One implements, another reviews</option>
                  <option value="turns">{agents.length === 2 ? "Both" : "Several"}, taking turns in one worktree</option>
                  <option value="parallel">{agents.length === 2 ? "Both" : "Several"}, in parallel worktrees</option>
                </select>
              </label>
              <p className="muted small">{STRATEGY_HINT[strategy]}</p>
              {strategy !== "parallel" && (
                <label className="inline small">
                  {joint ? "Goes first" : "Implementer"}
                  <select value={implementer} onChange={(e) => setImplementer(e.target.value as AgentKind)}>
                    {agents.map((p) => (
                      <option key={p.kind} value={p.kind}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {!joint && agents.length > 1 && (
                <label className="inline small">
                  Reviewer
                  <select value={reviewer} onChange={(e) => setReviewer(e.target.value as AgentKind)}>
                    <option value="">{nameIn(view, nextAfter(implementer))} (next agent)</option>
                    {agents
                      .filter((p) => p.kind !== implementer && p.kind !== nextAfter(implementer))
                      .map((p) => (
                        <option key={p.kind} value={p.kind}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title" aria-label="Task title" />
              {joint ? (
                <>
                  {agents.length > 2 && <p className="muted small">Agents whose part is left empty sit this job out. At least two need a part.</p>}
                  {partOrder.map((k) => (
                    <label key={k} className={`stack small part a-${avatarKey(driverOf(view, agents.find((p) => p.kind === k)!))}`}>
                      {nameIn(view, k)}’s part
                      <textarea
                        rows={3}
                        value={parts[k] ?? ""}
                        onChange={(e) => setParts({ ...parts, [k]: e.target.value })}
                        placeholder={`What ${nameIn(view, k)} builds, what it must not touch, how to verify`}
                      />
                    </label>
                  ))}
                </>
              ) : (
                <textarea rows={3} value={spec} onChange={(e) => setSpec(e.target.value)} aria-label="Scope" placeholder="Bounded scope: what to build, what not to touch, how to verify" />
              )}
              {room.projectId ? (
                <label className="inline small">
                  New worktree from
                  <input value={baseRef} onChange={(e) => setBaseRef(e.target.value)} style={{ width: 100 }} />
                </label>
              ) : (
                <p className="muted small">
                  {strategy === "turns"
                    ? "Scratch room: each agent gets its own scratch folder; the second reads the first’s folder. Use a project room for one shared worktree."
                    : "Scratch room: work happens in a new T3 scratch folder."}
                </p>
              )}
              <button
                className="primary"
                disabled={!ready}
                onClick={() =>
                  run(() =>
                    api.startTask(room.id, { implementer, reviewer: reviewer || null, strategy, first: implementer, title, spec, parts, baseRef: room.projectId ? baseRef : null }),
                  )
                }
              >
                {joint ? "Start joint implementation" : "Assign implementation"}
              </button>
            </div>
          )}
          {view.tasks.map((t) => (
            <div key={t.id} className="task">
              <div className="p-row">
                <b>
                  {t.kind === "implement" ? "Implement" : "Review"}
                  {t.strategy !== "solo" && (
                    <span className="muted"> · {nameIn(view, t.kind === "implement" ? t.ownerKind : (view.tasks.find((x) => x.id === t.parentTaskId)?.ownerKind ?? t.ownerKind))}’s part</span>
                  )}
                </b>
                <span className={`chip ts-${t.status}`}>{T_LABEL[t.status]}</span>
              </div>
              <div className="small">
                {nameIn(view, t.ownerKind)} · {t.title}
                {t.kind === "implement" && t.reviewerKind && <span className="muted"> · {nameIn(view, t.reviewerKind)} reviews</span>}
              </div>
              {t.worktreePath && <div className="small muted">worktree {t.worktreePath}</div>}
              {t.statusDetail && <div className="small warn">{t.statusDetail}</div>}
              {t.threadLink && (
                <T3Link className="small" link={t.threadLink}>
                  Open thread in T3 <Icon name="external" />
                </T3Link>
              )}
            </div>
          ))}
          {room.status === "review_ready" && (
            <div className="task-form">
              <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" />
              <div className="btn-grid">
                <button className="primary" onClick={() => run(() => api.acceptReview(room.id, note))}>
                  Accept
                </button>
                {reviewedParts.length > 1 ? (
                  reviewedParts.map((t) => (
                    <button key={t.id} onClick={() => run(() => api.requestChanges(room.id, note, t.id))}>
                      Changes to {nameIn(view, t.ownerKind)}’s part
                    </button>
                  ))
                ) : (
                  <button onClick={() => run(() => api.requestChanges(room.id, note))}>Request changes</button>
                )}
              </div>
              <p className="muted small">Team Room never pushes, merges, or deploys.</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ApproveDialog({ initial, onCancel, onApprove }: { initial: { body: string }; onCancel: () => void; onApprove: (body: string) => void }) {
  const [body, setBody] = useState(initial.body);
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Approve plan</h2>
        <p className="muted small">
          Edit the plan as needed. Approving closes the discussion and stores this as a binding decision that travels with every implementation and
          review task. Nothing starts until you assign a task.
        </p>
        <textarea rows={14} value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={!body.trim()} onClick={() => onApprove(body)}>
            Approve plan
          </button>
        </div>
      </div>
    </div>
  );
}

