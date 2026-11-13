#!/bin/bash
# Team Room launcher: opens T3 Code, starts the Team Room server if it is not
# running, and opens Team Room in its own window. Safe to run again at any time.
#
#   team-room            start everything and open the window (same as "open")
#   team-room start      start T3 and the server without opening a window
#   team-room stop       stop the Team Room server (T3 and your agents' threads keep their state)
#   team-room restart    stop, then open
#   team-room status     show what is running
#   team-room logs       follow the server log
#
# Settings (environment): TEAM_ROOM_PORT (8791), TEAM_ROOM_KEEP_AWAKE=0 to never keep the Mac awake.
set -uo pipefail

SELF="$(readlink -f "$0")"
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
PORT="${TEAM_ROOM_PORT:-8791}"
URL="http://127.0.0.1:${PORT}"
LOG="$ROOT/data/server.log"
PIDFILE="$ROOT/data/server.pid"
T3_APP="T3 Code (Beta)"
INTERACTIVE=0
[ -t 1 ] && INTERACTIVE=1

say() { if [ "$INTERACTIVE" = 1 ]; then echo "$*"; fi; }
fail() {
  # Launched from Finder or the Dock there is no terminal: show a macOS alert instead.
  if [ "$INTERACTIVE" = 1 ]; then echo "Team Room: $*" >&2; else osascript -e "display alert \"Team Room\" message \"$*\" as critical" >/dev/null 2>&1; fi
  exit 1
}

# Finder-launched apps get a minimal PATH, so find Node explicitly (the one Team Room was tested with first).
find_node() {
  for n in "$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do [ -x "$n" ] && { echo "$n"; return; }; done
  /bin/zsh -lc 'command -v node' 2>/dev/null
}
NODE="$(find_node)"

t3_origin() {
  # The running T3 server writes its address here; 3773 is its default.
  local rt="$HOME/.t3/userdata/server-runtime.json"
  if [ -f "$rt" ] && [ -n "$NODE" ]; then
    "$NODE" -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).origin;if(o){console.log(o);process.exit(0)}}catch{}process.exit(1)' "$rt" 2>/dev/null && return
  fi
  echo "http://127.0.0.1:3773"
}
t3_up() { [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$(t3_origin)/")" != "000" ]; }
tr_up() { [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$URL/api/status")" = "200" ]; }
tr_pid() { lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null | head -1; }

wait_for() { # wait_for <seconds> <check-function>
  local i
  for ((i = 0; i < $1 * 2; i++)); do "$2" && return 0; sleep 0.5; done
  return 1
}

start_t3() {
  t3_up && return 0
  say "Opening $T3_APP…"
  open -g -a "$T3_APP" 2>/dev/null || fail "Could not open $T3_APP. Is it installed in /Applications?"
  wait_for 90 t3_up || fail "$T3_APP did not start its server within 90 seconds. Open it yourself, then try again."
}

# The local model (Ollama) finds the agents' questions and writes free summaries. Start it if it's installed but not
# running (e.g. after a restart); Team Room falls back to simpler rules without it.
start_ollama() {
  [ "${TEAM_ROOM_LOCAL_MODEL:-}" = "off" ] && return 0
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 http://127.0.0.1:11434/api/tags)" = "200" ] && return 0
  [ -d "/Applications/Ollama.app" ] && open -g -a Ollama >/dev/null 2>&1
  return 0
}

start_server() {
  tr_up && return 0
  [ -n "$NODE" ] || fail "Node.js was not found. Install Node 22.13 or newer."
  [ -f "$ROOT/node_modules/tsx/dist/cli.mjs" ] || fail "Dependencies are missing. Run: cd $ROOT && npm install"
  mkdir -p "$ROOT/data"
  if [ ! -f "$ROOT/dist/index.html" ]; then
    say "Building the interface…"
    (cd "$ROOT" && "$NODE" node_modules/vite/bin/vite.js build >>"$LOG" 2>&1) || fail "Building the interface failed; see $LOG"
  fi
  say "Starting Team Room…"
  echo "--- $(date '+%Y-%m-%d %H:%M:%S') started by team-room launcher ---" >>"$LOG"
  (cd "$ROOT" && nohup "$NODE" node_modules/tsx/dist/cli.mjs server/index.ts >>"$LOG" 2>&1 & echo $! >"$PIDFILE")
  wait_for 30 tr_up || fail "Team Room did not start within 30 seconds; see $LOG"
}

# Bring an open Team Room window to the front. The first time, macOS may ask whether
# the launcher may control Google Chrome; if that is declined, a new window opens instead.
focus_existing() {
  osascript >/dev/null 2>&1 <<APPLESCRIPT
tell application "System Events" to if not (exists process "Google Chrome") then error "not running"
tell application "Google Chrome"
  repeat with w in windows
    try
      if (URL of active tab of w) starts with "$URL" then
        set minimized of w to false
        set index of w to 1
        activate
        return
      end if
    end try
  end repeat
end tell
error "no window"
APPLESCRIPT
}

open_window() {
  if [ -d "/Applications/Google Chrome.app" ]; then
    focus_existing && return
    # A chromeless app window, like a desktop app. When Chrome is already running it opens the
    # window in the background, so bring that window forward once it exists. (Not `open -a "Google
    # Chrome"`: Chrome answers that with a blank New Tab window in front of Team Room.)
    if open -na "Google Chrome" --args --app="$URL" >/dev/null 2>&1; then
      local i
      for i in 1 2 3 4 5 6 7 8 9 10; do
        sleep 0.5
        focus_existing && return
      done
      return
    fi
  fi
  open "$URL"
}

stop_server() {
  local pid
  pid="$(tr_pid)"
  if [ -z "$pid" ]; then say "Team Room is not running."; return 0; fi
  kill "$pid" 2>/dev/null
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  rm -f "$PIDFILE"
  say "Stopped Team Room (pid $pid). Rooms, research runs and agent threads keep their state; run team-room to continue."
}

case "${1:-open}" in
  open)
    start_t3
    start_ollama
    start_server
    open_window
    say "Team Room is open at $URL"
    ;;
  start)
    start_t3
    start_ollama
    start_server
    say "Team Room is running at $URL"
    ;;
  stop) stop_server ;;
  restart)
    stop_server
    start_t3
    start_ollama
    start_server
    open_window
    ;;
  status)
    t3_up && echo "T3 Code:   running at $(t3_origin)" || echo "T3 Code:   not running"
    if tr_up; then
      echo "Team Room: running at $URL (pid $(tr_pid))"
      curl -s --max-time 2 "$URL/api/status" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(`T3 link:   ${j.connection.kind}${j.maxPermission?` · access ${j.maxPermission}`:""}${j.keepAwake?" · keeping the Mac awake":""}`)})'
    else
      echo "Team Room: not running"
    fi
    ;;
  logs) tail -n 50 -f "$LOG" ;;
  *)
    echo "Usage: team-room [open|start|stop|restart|status|logs]" >&2
    exit 2
    ;;
esac
