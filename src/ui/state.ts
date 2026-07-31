import { createSignal, createMemo, type Accessor } from "solid-js"
import type { SpaceSet, Space } from "../space.ts"
import type { Agent } from "../agent.ts"
import type { TerminalPane } from "../pane.ts"

/** How often polled state (agent status, spinner frame) is re-read. */
export const POLL_MS = 100

export interface AppState {
  spaces: Accessor<readonly Space[]>
  active: Accessor<Space | null>
  focusedPane: Accessor<TerminalPane | null>
  allAgents: Accessor<Agent[]>
  /** Advances on a timer. Read this in anything that displays polled state. */
  tick: Accessor<number>
  /** Current spinner frame index, derived from the tick. */
  frame: Accessor<number>
  /** Bump after any structural change (space/agent/pane added or removed). */
  refresh: () => void
  dispose: () => void
}

/**
 * A reactive view of the imperative domain objects.
 *
 * Two kinds of change, modelled differently on purpose:
 *
 * - *Structural* — a space or agent appears or disappears, focus moves. These
 *   are push events; `refresh()` bumps a revision signal from SpaceSet.onChange.
 * - *Polled* — an agent's state, its foreground command, the spinner frame.
 *   There is nothing to push from: the state lives in the kernel (the pty's
 *   foreground pgid) or on the agent's screen, and ghostty deliberately offers
 *   no notification for scroll position either. A timer is the honest model,
 *   not a workaround.
 *
 * Views read `tick()` alongside a getter to opt into the polled refresh.
 */
export function createAppState(spaces: SpaceSet): AppState {
  const [revision, setRevision] = createSignal(0)
  const [tick, setTick] = createSignal(0)

  const refresh = () => setRevision((r) => r + 1)

  const previous = spaces.onChange
  spaces.onChange = () => {
    previous?.()
    refresh()
  }

  const timer = setInterval(() => setTick((t) => t + 1), POLL_MS)
  timer.unref?.()

  const spacesList = createMemo(() => {
    revision()
    return [...spaces.spaces]
  })

  return {
    spaces: spacesList,
    active: createMemo(() => {
      revision()
      return spaces.active
    }),
    focusedPane: createMemo(() => {
      revision()
      return spaces.active?.workspace.focused ?? null
    }),
    allAgents: createMemo(() => {
      revision()
      return spaces.allAgents
    }),
    tick,
    frame: tick,
    refresh,
    dispose() {
      clearInterval(timer)
    },
  }
}
