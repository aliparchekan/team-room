# Team Room

Lead a small engineering team made of **real** AI agents (Claude Code, Codex, or any other provider T3 runs) from one shared room.
Team Room is a local companion app for [T3 Code](https://github.com/pingdotgg/t3code). It uses T3's
external MCP interface, so each agent is a real T3 thread on your configured provider. Nothing is
simulated and no model APIs are called directly.

## Prerequisites

- macOS/Linux with **Node.js ≥ 22.13** (uses the built-in `node:sqlite`). Tested on Node 26.8.
- **T3 Code 0.1.7** desktop app (or `t3 serve`) running on this machine. Verified against
  `T3 Code (Beta).app` 0.1.7, server at `http://127.0.0.1:3773`.
- In T3, the **Claude** (`claudeAgent`) and **Codex** (`codex`) providers configured and signed in.

## Open it like an app

```bash
scripts/install-app.sh     # once: adds ~/Applications/Team Room.app and the team-room command
```

Then open **Team Room** from Spotlight, Launchpad or the Dock (drag it there to keep it), or run `team-room` in a
terminal. It opens T3 Code if it isn't running, starts the Team Room server if it isn't running, and opens Team Room
in its own window (a Chrome app window; your default browser if Chrome is missing). Running it again just opens
another window; it never starts a second server.

| Command | What it does |
| --- | --- |
| `team-room` | Start what's needed and open the window |
| `team-room start` | Start T3 and the server without opening a window |
| `team-room stop` | Stop the Team Room server (rooms, runs and agent threads keep their state) |
| `team-room restart` | Stop, then start and open |
| `team-room status` | Show what is running, the T3 link and access level |
| `team-room logs` | Follow `data/server.log` |

While agents have work in flight, Team Room keeps the Mac from idle-sleeping (macOS `caffeinate`; the header shows
**Keeping Mac awake**) and lets it sleep again once they are idle. Closing the lid still sleeps the Mac. Set
`TEAM_ROOM_KEEP_AWAKE=0` to turn this off. If T3 restarts, Team Room reconnects by itself within about 15 seconds.
`scripts/install-app.sh --remove` uninstalls the app and command; your data is untouched.

## Setup and run

```bash
cd ~/team-room
npm install
npm start          # builds the UI, then serves app + API on http://127.0.0.1:8791
```

Open **http://127.0.0.1:8791**. Other commands:

| Command | What it does |
| --- | --- |
| `npm run serve` | Start without rebuilding the UI (uses existing `dist/`) |
| `npm run dev` | Backend with reload + Vite dev server on http://127.0.0.1:5173 |
| `npm test` | Unit tests (controller against an in-memory T3 stand-in) |
| `npx tsx scripts/thread-spike.ts` | Live spike: launch, send, idempotent retries, read, interrupt on real Scratch threads |
| `npm run typecheck` | TypeScript check |
| `npm run spike` | Sign in and dump T3's live tool list and schemas to `data/` |
| `npm run smoke` | Bounded **live** smoke test with real Claude and Codex (starts its own server; stop `npm start` first) |
| `TEAM_ROOM_FIXTURE=1 npm run serve` | Development **fixture mode**: canned local replies, separate DB, red banner. Never live. |

Environment overrides: `T3_MCP_URL` (default: read from `~/.t3/userdata/server-runtime.json`,
falling back to `http://127.0.0.1:3773/mcp`), `TEAM_ROOM_PORT` (default 8791), `TEAM_ROOM_DATA` (default `./data`).

**Your name (optional).** Agents often address you by name ("Sam, should we ship it?"). Set
`TEAM_ROOM_LEAD_NAME=Sam`, or put `{"leadName": "Sam"}` in `data/settings.json`, so Team Room counts those as
questions for you too. Without it, questions to "you" or "the lead" are still found.

## Authentication

Team Room signs in like any outside MCP agent (T3 docs: *Outside agents*). It uses OAuth with dynamic
client registration and PKCE, with redirect `http://127.0.0.1:8791/oauth/callback`.

1. Start Team Room. If it isn't signed in, the header shows **Approve in T3**.
2. On T3's "Connect Team Room" page, choose the access level: the most autonomous mode Team Room may start agents
   in. **Full access** lets rooms and research runs use every mode, including no approval prompts; you still pick the
   mode per room. Choose **Supervised** or higher. Read only cannot start,
   message or stop threads. Threads Team Room starts can never run with more permission than the mode you pick.
3. Enter a pairing code from T3 **Settings → Sharing & access** or `t3 auth pairing create`, then **Approve**.

The token is stored only in `data/t3-credentials.json` (mode 0600, git-ignored). It is never sent to the
browser, put in URLs, or logged. A sign-in lasts 30 days; T3 0.1.7 issues no refresh tokens, so after
that the header asks you to approve again. You can revoke Team Room under **Settings → Sharing & access**.

## Using it

1. **Create a room:** **+ New room** → title, task brief, workspace (a T3 project, or Scratch for
   discussion only), the **agents**, discussion mode, and turn limit (default 6). Team Room
   creates one idle T3 thread per agent, started in the room's **Agent permissions** mode (default
   Supervised). **Open thread in T3 ↗** opens each one.

   **Agents:** a room has 2–6. It starts with Claude Code and Codex; **+ Add agent** adds more, from any
   provider T3 offers (Claude, Codex, Grok, Cursor, OpenCode, Antigravity, Kiro, Muse Code, Pi, …), each with its
   own model and thinking level. Providers T3 hasn't enabled are listed as *off in T3*: turn them on in T3's
   settings first. Each agent gets a handle for @mentions: `@claude`, `@codex`, `@grok`, and a number for a
   second agent of the same provider (`@claude2`, shown as *Claude Code 2*). In a room under way,
   **+ Add an agent…** (Participants) adds one: its new thread starts with the room's record (brief, pins, tasks,
   transcript), and it introduces itself. **Remove from room** stops an agent's turns; its messages stay, and so
   does its T3 thread. AutoResearch mode still runs with Claude Code and Codex.
2. **Start the discussion:**
   - **Bounded automatic:** **Start automatic round** runs blind proposals from every agent, then
     each critiques the others' real proposals, then each responds to the critiques. That's 3 turns per agent
     (6 with two agents, 9 with three: the form suggests a limit that fits), then the room pauses on
     **Your decision**. The side panel shows the proposals and each agent's
     *Agreements / Disagreements / Questions for the lead* sections, quoted from their final responses.
   - **Manual:** use **Ask <agent> / Ask everyone**, or write an agent's handle (`@claude`, `@grok`, …) or `@all`
     in the composer. Each agent receives the others' new contributions with your message and is asked to
     engage with them (agree, challenge, add).
   - **Messages to several agents** have an **Order** choice. *<Agent> first* sends to that agent, then gives
     the others your message plus that answer and asks them to build on it. *All at once* (the default) starts
     all of them; whoever finishes first has its answer steered into the others' running turns.
   - **Agents can call each other.** An agent that writes another agent's handle (`@codex`) in a reply gets that
     question handed to that agent; `@all` hands it to every other agent. The handover is labelled as a
     colleague's question, not your instruction. After
     a set number of hand-offs in a row (the room's **hand-off limit**, default 3, set in **+ New room** or under
     *Discussion*; 0 turns hand-offs off) the room waits for you. Hand-offs never happen during the automatic round, which
     has its own exchange. Your own messages that contain agents' handles are addressed to those agents.
   - Proposals stay blind even if the agents already spoke. A peer's contributions are held back until the
     critique turn, and the critique turn always includes the proposal being critiqued.
   - If your message arrives while an agent is mid-turn, it is steered in with an instruction to answer you
     **and** still finish that turn's task.
3. **Intervene:** type in the composer at any time. Your message is recorded first, automatic
   advancement pauses, and the message goes straight to the addressed agents. If an agent is busy,
   T3 steers it into the running turn when it can, or otherwise queues it. Each message shows the
   delivery state T3 confirmed: *delivered*, *queued in T3*, *uncertain*, or *failed*.
   - **Room note** (no reply): sent along with each agent's next turn.
   - **Pin as Decision / Constraint**, or the **Pinned** panel: binding context that is re-sent
     whenever it changes.
4. **Pause / Stop / Resume / Continue:**
   - **Pause** stops scheduling; running turns finish and are recorded.
   - **Stop agents** asks T3 to interrupt every running agent. The room shows *Stopping* until T3
     reports that each run actually ended.
   - **Resume** re-reads T3, reconciles uncertain deliveries, then continues.
   - **Continue discussion** resumes the automatic sequence, or runs one more exchange round within the turn limit.
   - **Questions for you.** When an agent asks you something, Team Room records it. With a local model (below) the
     model rewrites each asking sentence as a short question (or drops it); otherwise the sentence itself is used.
     Asking sentences are the ones with a question mark, a plain request for your input, or a step that waits on you
     ("requires the lead's explicit instruction"), in the parts of the message meant for you. The model never adds
     questions of its own: one sentence in, at most one question out. Paragraphs that open by addressing the other
     agent ("@codex …", "Agreed, @codex. …") are skipped. Only recent questions count: from the last two days and after
     your latest message. Writing in the room closes older open questions; answers sent from the panel do not. Open questions collect in one panel at the top of
     the room, and the sidebar and window title count them. Type answers to any of them and **Send answers**: they go
     back as one message with each question quoted, to the agent(s) who asked. One turn per agent, not per question.
     **Dismiss** questions that need no answer. A paragraph with context is one question; list items are separate ones.
     Questions with set choices show them as **buttons**: click one to answer, optionally adding a note. Agents are
     asked to list choices as `- Where should Step 1 run? [This Mac | The server]`; otherwise the local model offers
     options, or yes/no and "A or B" questions get theirs by rule. Open questions keep just a text box.
   - **Digests (automatic, free).** After each stretch of agent discussion between your messages, a **Digest** card
     (older ones fold to one line) lists what the agents said they agreed or decided, what is still disputed, what is blocked, what needs you,
     and their next steps, each line linked to its message. It is built from the agents' own section headings and
     phrasing, with no model, so it costs nothing. **Ask … for a fuller summary (uses a turn)** has the agent who
     spoke last write one instead; it is posted to you only and starts no hand-offs.
   - **Local model (optional, free).** If Ollama is running with a chat model (`ollama pull llama3.1:8b`), Team Room
     uses it for the questions above and writes a short summary at the top of each room's newest digest once the
     agents are idle; older digests have **Summarize locally (free)**. Nothing is sent to Claude or Codex. Set
     `TEAM_ROOM_LOCAL_MODEL` to pick a model, or `off` to disable it. Without Ollama everything falls back to rules.
   - **Model and thinking level.** Each agent's card has a **Model** picker (the other models of its T3 provider) and a
     **Thinking** picker with the levels T3 lists for its model (Claude:
     Low … Max, Ultracode, Ultrathink; Codex: Low … Ultra). Changing either reconfigures the running T3 thread from its
     next turn (a thinking level the new model doesn't offer resets to its default); new rooms, moved agents, tasks and AutoResearch runs take it at launch. Higher levels use more of
     your plan.
5. **Approve a plan:** **Approve as plan…** on a proposal or reply (editable), or **Approve a plan…**
   in Execution. Discussion never starts implementation by itself. The agents can keep talking after
   approval, for example to split the work, and their `@mentions` are still handed over. While no task is
   running you can approve a **revised plan**, which replaces the previous one for all later tasks.
6. **Assign implementation:** in Execution, choose **Who builds it**:
   - **One implements, another reviews.** The implementer gets its own T3 thread in a **new worktree**,
     with the approved plan and constraints in its prompt. When it finishes, the **Reviewer** you picked (by
     default the next agent in the room) reviews in that same worktree and is told not to modify files.
   - **Several, taking turns in one worktree.** You write a part for each agent taking part (at least two; an
     agent with an empty part sits the job out) and pick who goes first. Each builds its part in turn in the
     same new worktree, with the earlier agents' reports in its prompt. Only one agent writes at a time. Then
     each part is reviewed by the next agent taking part, all at once, read-only.
   - **Several, in parallel worktrees.** The agents build their parts at the same time, each in its own new
     worktree and branch. Each part is reviewed by the next agent taking part as soon as it's done. Team Room
     doesn't combine the branches; you do that.

   **Move to new threads…** (Participants panel) moves any of the agents to fresh T3 threads with the permissions
   you choose, because T3 never changes an existing thread's mode. First, each agent writes a handoff note in its old
   thread: files it read, commands and results, reasoning, open questions, next step. The new thread then starts with
   the brief, the approved plan and pins, the tasks so far, the room transcript (the newest messages in full, older
   ones summarized to fit T3's 120,000-character limit) and that note, and confirms it is caught up. A busy agent's
   turn is stopped first. Old threads stay in T3 and are linked as "Earlier threads"; later messages go to the new
   thread only.

   **Agent permissions for new tasks** (top of Execution) raises the mode for the task threads the room starts from
   now on, up to Team Room's T3 access. The discussion threads keep the mode they started with; T3 does not change
   an existing thread's mode. If an agent asks for more access in a discussion thread, give it the work as a task.

   In both joint modes each agent's prompt includes the other's part as context, so neither builds the other's
   part. Joint modes need a worktree in project rooms, so each agent never writes in your project checkout. In
   a Scratch room each agent gets its own scratch folder.

   Implementation reports (with *Reported verification*) and reviews come back to the room. Then choose
   **Accept** or **Request changes**. In joint jobs you request changes per part, and only the changed part is
   reviewed again. A part that shares its worktree waits until the other part is no longer being changed.

Team Room never pushes, merges, publishes, or deploys.

## AutoResearch mode

Give Team Room an objective and an evaluation, and agents run measured experiments toward a better solution, in
the spirit of [karpathy/autoresearch](https://github.com/karpathy/autoresearch), with Claude Code and Codex as
real T3 agents.

**Where:** the **AutoResearch** tab at the top of the sidebar, then **New research run**.

**What you give it:** the objective; the repository (a T3 project, which must be a git repo) and baseline ref; the
evaluation, either an **automated command** or **assisted** (you judge each result against written criteria); the
direction (minimize, maximize, pass/fail); protected paths (the evaluation itself); the allowed modification scope;
which agent plays which role, and their models; the strategy; and limits (max experiments, max duration, experiments
at a time, retries, stop after N experiments without gain).

**The loop**, run by Team Room's orchestrator (deterministic code, not a model):

1. Freeze the protected evaluation files from the baseline commit, then **measure the baseline** (repeated runs). If the
   evaluation prints no metric, or the baseline fails its own checks, the run stops and says the objective is not
   measurable as configured; assisted mode is the alternative.
2. The **researcher** agent gets the full history rebuilt from the database (every hypothesis, measurement, decision
   and lesson, plus closed directions) and proposes hypotheses as JSON, following the strategy.
3. Each experiment gets its own **git worktree and branch** (`autoresearch/<run>/E<n>`) created from its parent's
   commit, and an **implementer** agent works there through T3 (`existing_worktree`).
4. Team Room commits the agent's changes on that branch and checks the diff: touching a protected path or anything
   outside the allowed scope makes the experiment **invalid** without evaluation, and **pauses the run** for you.
5. Team Room runs the **evaluation itself**, in the experiment's checkout, with `$EVAL_DIR` pointing at a fresh copy
   of the frozen evaluation files. Evaluations run one at a time so parallel experiments don't distort timings. It
   takes the median of repeats; a change counts only if it beats the current best by more than the minimum
   improvement and the measured spread. Ahead but within noise → measured again with twice the runs →
   **inconclusive** if still unclear.
6. A candidate improvement goes to the **evaluator** agent (by default the other agent) to check that it is real and
   allowed (no special-casing, no hidden behaviour changes). Only then is it **kept** and becomes the best.
7. Build errors or failed evaluations go back to the same implementer with the error, up to the retry limit.
   Approaches that failed twice with nothing kept, or that you rejected, are closed.
8. Repeat until a limit is reached or you stop it. Every decided worktree is removed; its commit stays on its branch.

**Strategies:** greedy improvement, parallel exploration, explore/exploit, failure-driven investigation
(`server/research/strategies.ts`; adding one is one entry).

**Controls:** Start, Pause, Resume, Stop. You can also suggest a hypothesis (it runs first), reject a direction
(cancels its queued work and tells the researcher), pin a promising experiment (explore/exploit may build on it),
change the limits, judge experiments in assisted mode, and approve T3 permission prompts from the banner.

**Dashboard:** overview (best, baseline, improvement, experiments, remaining budget, active agents); experiment graph;
metric over time with best-so-far; sortable, searchable history with comparison; per-experiment details with diff,
every evaluation run and its output, and the agents' reports; activity log; and a report built from the records,
with Markdown and CSV export.

**Safety:** your checkout is never written; nothing is merged or pushed (the report names the best branch); Stop
interrupts the run's agents and removes only the run's worktrees; history survives stops and restarts. After a
restart, an interrupted evaluation is measured again and agent turns are re-read from T3.

**Approvals:** by default agents only read and edit files; Team Room runs the evaluation and sends errors back,
so with Auto-accept edits a run needs no approvals. Tick **Let agents run commands** for more thorough self-checks;
below Full access each command then waits for you (the dashboard banner opens T3's approval screen).

**Limits:** T3 0.1.7 reports no usage cost, so a spending cap can't be enforced (the field is shown disabled). With
**Supervised** access every agent command waits for your approval; Auto-accept edits is much smoother. T3 only lets
full-access clients register projects, so add the repository to T3 yourself.

### Try it

```bash
npx tsx scripts/autoresearch-demo.ts      # creates data/demo/autoresearch-demo (a git repo)
```

Add that folder as a project in T3, open **AutoResearch → New research run → Fill in the demo**, and start. The demo
(`examples/autoresearch-demo`) is a deliberately slow prime-counting `solver.py`; `eval/evaluate.py` checks every
answer against its own reference and times the solver, reloading it before every timed call.

Without real agents: `TEAM_ROOM_FIXTURE=1 TEAM_ROOM_PORT=8792 npm run serve` runs the same engine with scripted
agents (red FIXTURE banner, separate database) on a fixture copy of the demo.

## Architecture

```
browser (React)  ──HTTP + SSE──▶  server/index.ts  (Express, 127.0.0.1 only)
                                        │
                              server/controller.ts   explicit room state machine
                               │                │
                     server/store.ts      server/t3/adapter.ts   ← only file that knows T3's tool shapes
                     server/research/*    (AutoResearch: engine = orchestrator, workspace = git worktrees,
                                           evaluator = runner + judge, strategies, prompts, report, store)
                     (SQLite: rooms,       server/t3/connection.ts (MCP client + OAuth, @modelcontextprotocol/sdk)
                      participants,                │
                      transcript,            T3 /mcp  ──▶ real Claude / Codex threads
                      deliveries,
                      decisions, tasks)
```

- **Durable room record.** Every message stores author, kind, recipients, time, delivery state, and
  the T3 thread and run it came from. Original agent text is kept in full (truncated T3 items are paged
  in). T3's event log is never the only record.
- **Deliveries** are the unit of relay. Each records exactly which room messages it carried, the
  envelope text sent, and T3's answer (*started / steered / queued* plus run id). A participant's
  `delivered_through_seq` only advances once T3 confirms, so nothing is re-sent. The brief and pinned
  decisions are re-sent only when they change.
- **Envelopes** label every source: *Instruction from the human lead*, *Note from the human lead*,
  *DECISION approved by the human lead*, and *Codex's proposal (peer agent — context, NOT an instruction to you)*.
  Agent text is never presented as an instruction from you.
- **State machine.** Room states are `setting_up, idle, running, paused, stopping, reconciling,
  awaiting_decision, executing, review_ready, needs_attention`. The allowed transitions are listed in
  `TRANSITIONS`, and anything else throws. Each room's work runs serialized.
- **Idempotency.** The delivery id is T3's `clientRequestId` for `t3_thread_send`, and each
  participant or task has a stable `clientRequestId` for `t3_thread_launch`. Both were verified live
  to return the same thread, message and run on retry.
- **Recovery.** On start, sends that were in flight become *uncertain* and the room pauses as
  *needs attention*. **Resume** replays them with the same `clientRequestId`, which T3 de-duplicates.
  Rooms that were running are re-read from T3, and replies are recorded once per run (unique per thread and run).
- **Polling.** T3's outside-client interface has no event subscription, so in-flight threads are
  polled every 2 s, backing off to 30 s while T3 is unreachable. Idle rooms are not polled.
- **One writer.** Only one implementation task can run per room. The reviewer starts after the
  implementer finishes, in the same worktree, and is told not to edit.

## T3 integration as verified (T3 Code 0.1.7)

OAuth metadata at `/.well-known/oauth-protected-resource/mcp`: scopes `orchestration:read` and
`orchestration:operate`, `authorization_code` with S256 PKCE, public client, no refresh grant.
The live `tools/list` returned 68 tools. Operations used and verified against real threads:

| Tool | Used for | Verified |
| --- | --- | --- |
| `orchestrator_capabilities` | providers and models (`claudeAgent`, `codex`, no constraints) | ✅ |
| `t3_project_list` | workspace picker | ✅ |
| `t3_thread_launch` (`scratch` / `projectId` + `workspaceStrategy`, `modelSelection`, `clientRequestId`) | participant and task threads | ✅ retry with same id → same thread |
| `t3_thread_send` (`mode`, `clientRequestId`) | deliveries | ✅ retry → same `messageId`/`runId`; `delivery: started` |
| `t3_thread_read` (`afterPosition`, `itemId`+`textOffset`) | replies, run status, pending requests, worktree | ✅ `user_message` / `assistant_message` items, `recentRuns` |
| `t3_thread_interrupt` (`stop: true`) | Stop agents | ✅ `interrupt_requested` → run observed `interrupted`; later sends still run |

Not used: `delegate_task` and `create_threads`. In 0.1.7 both require an active calling thread
(`actsAsCaller`), which an outside client does not have.

Thread links are the ones T3 returns to outside clients:
`https://app.t3.codes/threads/<environmentId>/<threadId>`. That hosted page offers to open the thread
in the desktop app.

## Tests

`npm test` runs the unit and controller tests against a fake T3 adapter (no agents, no network).
`TEAM_ROOM_FIXTURE=1 TEAM_ROOM_PORT=8792 npm run serve` runs the whole app with canned replies, and `npm run smoke`
is a short live run with real agents.

## Known limitations

- **No live events.** Updates come from bounded polling, so status can lag by about 2 s.
- **No usage or cost data.** T3's outside-client read results carry none, so the UI shows none.
- **Approvals use T3's own screen, shown inside Team Room.** T3 0.1.7 does not let outside clients approve
  permission requests (`t3_pending_request` says so explicitly), and Team Room does not work around that. When an
  agent waits, the room banner shows **Open … in T3**, which switches the T3 desktop app to that thread
  (`t3code://threads/<environment>/<thread>`, opened by Team Room's local server, so the browser asks nothing).
  **Review here** instead opens a panel with T3's own thread page from the local T3 server (`http://127.0.0.1:3773`). You approve or decline there, through T3's normal checks; Team Room
  cannot read the panel or your T3 sign-in. The first time, T3 asks to pair the browser: paste a token from
  **Settings → Sharing & access** or `t3 auth pairing create`, then click **Reload**.
  A waiting agent shows as **Waiting for your approval** in the room header and sidebar (instead of the room's own
  status), with the command it asked to run, and the window title shows a count. T3 does not report permission
  approvals as pending requests, so Team Room reads them from the thread's activity timeline while a run is active.
  To get fewer prompts, give a room a more autonomous **Agent permissions** mode when you create it. The modes
  are T3's own (Supervised, Auto-accept edits, Auto, Full access), and T3 caps them at the access level you
  approved for Team Room. To raise that cap, use **Access · change** in the header. An existing thread keeps
  the mode it started with.
- **Scratch rooms.** Discussion only in practice. Implementation runs in a fresh scratch folder, and
  the reviewer runs in its own scratch folder with the implementer's path in its prompt, because T3
  binds `existing_worktree` only within a project. Use a project room for real implementation work.
- **Stop holds queued turns.** T3's Stop holds queued turns; Team Room marks those deliveries
  cancelled. You can release them in T3 if you want them.
- **Agreements and disagreements.** These are quoted from the agents' own final-response sections;
  there is no moderator model.
- **Re-approval.** The sign-in expires after 30 days and must be approved again (no refresh grant in 0.1.7).

## Status and license

An early, independent project: it is not made by or affiliated with the T3 Code team, and it relies on T3's
external MCP interface as of T3 Code 0.1.7, which may change. It runs only on your own machine (the server listens
on `127.0.0.1`); do not expose it to a network.

MIT License. See [LICENSE](LICENSE).
