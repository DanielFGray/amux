import { createCliRenderer, BoxRenderable, TextRenderable, RGBA } from "@opentui/core"
import { Workspace } from "./workspace.ts"
import { Sidebar } from "./sidebar.ts"
import { encodeKey } from "./keys.ts"
import type { TerminalPane } from "./pane.ts"

const SHELL = [process.env.SHELL ?? "bash"]

const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 60, useMouse: true })

// Raw key passthrough needs the OUTER terminal to keep emitting classic escape
// sequences — the children speak xterm-256color terminfo and would misparse the
// CSI-u forms a kitty-enabled host produces. OpenTUI negotiates kitty keyboard
// by default (config null is coerced to {} internally), so zero the flags
// before its capability-response handler runs and it never pushes the protocol.
// modifyOtherKeys mode 1 remains, but that only re-encodes modified special
// keys that have no legacy form, which is harmless to pass through raw.
renderer.useKittyKeyboard = false

const root = new BoxRenderable(renderer, {
  id: "root",
  flexDirection: "column",
  width: "100%",
  height: "100%",
})
renderer.root.add(root)

const header = new TextRenderable(renderer, {
  id: "header",
  content: "",
  fg: RGBA.fromInts(30, 30, 46, 255),
  bg: RGBA.fromInts(203, 166, 247, 255),
  height: 1,
  flexShrink: 0,
})
root.add(header)

const ws = new Workspace(renderer, SHELL)

// Sidebar sits beside the workspace in a row so the split tree inside
// ws.root is untouched; the fixed width comes out of the panes' space.
const body = new BoxRenderable(renderer, {
  id: "body",
  flexDirection: "row",
  flexGrow: 1,
})
root.add(body)

const sidebar = new Sidebar(renderer, ws)
body.add(sidebar)
body.add(ws.root)

// Keyboard focus model: while `sidebarActive` the sidebar swallows keystrokes;
// any workspace focus change (pane click, focusNext, a reveal) hands focus
// back, so typing goes straight to the focused pane again.
let lastFocusedPane: TerminalPane | null = null
let sidebarActive = false
sidebar.onReveal = () => {
  sidebarActive = false
  sidebar.active = false
  sidebar.invalidate()
}

ws.onChange = () => {
  sidebar.invalidate()
  if (ws.focused !== lastFocusedPane) {
    lastFocusedPane = ws.focused
    if (sidebarActive) {
      sidebarActive = false
      sidebar.active = false
    }
  }
  const working = ws.agents.filter((a) => a.status === "working").length
  const detached = ws.detached.length
  header.content =
    ` opentui-herdr · ${ws.agents.length} agents (${working} working` +
    `${detached ? `, ${detached} detached` : ""}) · ${ws.panes.length} panes · ` +
    `^a| split · ^a- vsplit · ^a b sidebar · ^a x close view · ^a k kill · ^a q quit `
  // TextRenderable's content setter doesn't mark the renderable dirty, so a
  // repaint has to be requested explicitly or the status line goes stale.
  header.requestRender()
}
ws.init("shell")

// Kill every agent and free its PTY before leaving the terminal, so no child
// process is orphaned by a ^a q or a signal.
function shutdown() {
  ws.disposeAll()
  renderer.destroy()
  process.exit(0)
}
// The renderer's exit listeners destroy it but let the process linger with our
// children still running; make sure agents are disposed on the common signals
// (128 + signum is the conventional exit status for a signal death).
const SIGNAL_EXIT: Record<string, number> = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 }
for (const sig of Object.keys(SIGNAL_EXIT) as (keyof typeof SIGNAL_EXIT)[]) {
  process.once(sig, () => {
    ws.disposeAll()
    process.exit(SIGNAL_EXIT[sig])
  })
}
// Backstop for any other process.exit() path (rendered panes, etc.).
process.once("exit", () => ws.disposeAll())

// tmux-style prefix so keystrokes otherwise belong entirely to the child.
const PREFIX = "\x01" // ctrl+a
let pending = false

renderer.keyInput.on("keypress", (key: any) => {
  const bytes = encodeKey(key)
  if (bytes === null) return

  if (pending) {
    pending = false
    switch (bytes) {
      case "|":
      case "\\":
        return void ws.split("row")
      case "-":
        return void ws.split("column")
      case "b":
        // Toggle the sidebar: closed -> open (focused), open+focused -> closed,
        // open+unfocused -> reclaim focus without closing.
        if (!sidebar.open) {
          sidebar.toggle()
          sidebar.selectFocused()
          sidebarActive = true
        } else if (sidebarActive) {
          sidebar.toggle()
          sidebarActive = false
        } else {
          sidebarActive = true
        }
        sidebar.active = sidebarActive
        sidebar.invalidate()
        return
      case "n":
        return ws.focusNext(1)
      case "p":
        return ws.focusNext(-1)
      case "x":
        // Closes the VIEW; the agent keeps running and stays in the sidebar.
        return void (ws.focused && ws.close(ws.focused))
      case "k":
        // Actually stop the agent.
        return void (ws.focused && ws.killAgent(ws.focused.agent))
      case "q":
        return shutdown()
      case PREFIX:
        return ws.focused?.write(PREFIX) // ^a ^a sends a literal ctrl+a
      default:
        return
    }
  }

  if (bytes === PREFIX) {
    pending = true
    return
  }

  if (sidebarActive) {
    // Sidebar has focus: only escape hands it back; anything else is either
    // consumed or swallowed, never forwarded to a child.
    if (!sidebar.handleKey(bytes)) {
      sidebarActive = false
      sidebar.active = false
      sidebar.invalidate()
    }
    return
  }

  ws.focused?.write(bytes)
})

renderer.start()
