#!/bin/sh
# installed by amux
# managed by amux; reinstalling or updating the integration overwrites this file.
# add custom hooks beside this file instead of editing it.
# AMUX_AGENT_STATE_PLUGIN=1
# AMUX_INTEGRATION_ID=cursor
# AMUX_INTEGRATION_VERSION=1

set -eu

action="${1:-}"
hook_input_file="$(mktemp "${TMPDIR:-/tmp}/amux-cursor-hook.XXXXXX")" || exit 0
trap 'rm -f "$hook_input_file"' EXIT HUP INT TERM
cat >"$hook_input_file" 2>/dev/null || true

case "$action" in
  session) ;;
  *) exit 0 ;;
esac

[ -n "${AMUX_PROCESS_STATE_SOCKET:-}" ] || exit 0
[ -n "${AMUX_PANE_ID:-}" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

AMUX_ACTION="$action" AMUX_HOOK_INPUT_FILE="$hook_input_file" python3 - <<'PY'
import json
import os
import random
import socket
import time

source = "amux:cursor"
pane_id = os.environ.get("AMUX_PANE_ID")
socket_path = os.environ.get("AMUX_PROCESS_STATE_SOCKET")
hook_input_file = os.environ.get("AMUX_HOOK_INPUT_FILE")

if not pane_id or not socket_path:
    raise SystemExit(0)

hook_input = {}
if hook_input_file:
    try:
        with open(hook_input_file, encoding="utf-8") as handle:
            content = handle.read()
        if content.strip():
            hook_input = json.loads(content)
    except Exception:
        hook_input = {}

def first_text(*names):
    for name in names:
        value = hook_input.get(name)
        if isinstance(value, str) and value:
            return value
    return None

event = first_text("hook_event_name", "hookEventName")
if event not in (None, "sessionStart"):
    raise SystemExit(0)

session_id = first_text("session_id", "sessionId", "conversation_id", "conversationId")
if session_id is None:
    raise SystemExit(0)

request_id = f"{source}:{int(time.time() * 1000)}:{random.randrange(1_000_000):06d}"
report_seq = time.time_ns()
params = {
    "paneId": pane_id,
    "source": source,
    "agent": "cursor",
    "seq": report_seq,
    "agentSessionId": session_id,
}
request = {
    "id": request_id,
    "method": "pane.report_agent_session",
    "params": params,
}

try:
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(0.5)
    client.connect(socket_path)
    client.sendall((json.dumps(request) + "\n").encode())
    try:
        client.recv(4096)
    except Exception:
        pass
    client.close()
except Exception:
    pass
PY
