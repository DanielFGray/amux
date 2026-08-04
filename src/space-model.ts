/** Renderer-free state for one space. Windows are addressed by their stable numbers. */
export interface SpaceState {
  activeWindow: number | null;
  lastWindow: number | null;
  nextWindow: number;
}

/** Renderer-free state for the workspace. Spaces are addressed by their stable IDs. */
export interface SpaceSetState {
  activeSpace: string | null;
}

export function spaceState(): SpaceState {
  return { activeWindow: null, lastWindow: null, nextWindow: 1 };
}

export function spaceSetState(): SpaceSetState {
  return { activeSpace: null };
}

/** Claim a window number, keeping automatic numbering ahead of restored windows. */
export function claimWindowNumber(
  state: SpaceState,
  requested?: number,
): readonly [SpaceState, number] {
  const number = requested ?? state.nextWindow;
  return [{ ...state, nextWindow: Math.max(state.nextWindow, number + 1) }, number];
}

/** Select an existing window and retain the previous one for last-window. */
export function selectWindowState(
  state: SpaceState,
  windows: readonly number[],
  number: number,
): SpaceState {
  if (state.activeWindow === number || !windows.includes(number)) return state;
  return { ...state, activeWindow: number, lastWindow: state.activeWindow };
}

/** Remove a window and choose the same successor tmux does. */
export function closeWindowState(
  state: SpaceState,
  remaining: readonly number[],
  closed: number,
  index: number,
): SpaceState {
  if (state.activeWindow === closed) {
    const activeWindow =
      (state.lastWindow !== null && remaining.includes(state.lastWindow)
        ? state.lastWindow
        : null) ??
      remaining[Math.min(index, remaining.length - 1)] ??
      null;
    return { ...state, activeWindow, lastWindow: null };
  }
  return state.lastWindow === closed ? { ...state, lastWindow: null } : state;
}

export function activateSpaceState(
  state: SpaceSetState,
  spaces: readonly string[],
  id: string,
): SpaceSetState {
  return state.activeSpace === id || !spaces.includes(id) ? state : { activeSpace: id };
}

/** Remove a space and, when necessary, activate its next neighbour. */
export function removeSpaceState(
  state: SpaceSetState,
  remaining: readonly string[],
  removed: string,
  index: number,
): SpaceSetState {
  if (state.activeSpace !== removed) return state;
  return { activeSpace: remaining[Math.min(index, remaining.length - 1)] ?? null };
}
