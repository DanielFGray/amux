export interface ComposerCompletion {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly replacement: string;
  readonly submit?: boolean;
}

export interface ComposerCompletionSource {
  readonly trigger: "/" | "@";
  readonly complete: (
    query: string,
  ) => readonly ComposerCompletion[] | Promise<readonly ComposerCompletion[]>;
}

export interface ActiveCompletion {
  readonly trigger: "/" | "@";
  readonly query: string;
  readonly start: number;
}

/** The composer currently completes only the token immediately before its cursor. */
export const activeCompletion = (draft: string): ActiveCompletion | undefined => {
  const match = /(^|\s)([/@])([^\s]*)$/.exec(draft);
  if (!match) return;
  const trigger = match[2];
  if (trigger !== "/" && trigger !== "@") return;
  return {
    trigger,
    query: match[3] ?? "",
    start: draft.length - (match[2]?.length ?? 0) - (match[3]?.length ?? 0),
  };
};

export const replaceCompletion = (draft: string, active: ActiveCompletion, replacement: string) =>
  `${draft.slice(0, active.start)}${replacement}${draft.slice(active.start + active.query.length + 1)}`;
