# Agent transcript rendering

## Decision

Agent transcripts are semantic event streams rendered as retained widgets. The
TUI must also be able to render the retained transcript into a synthetic grid on
demand. VT bytes and grids are never transport data.

This is option (c): semantic/retained widgets with grid serialization. Plain
retained widgets (option b) provide no common text-coordinate model for copy
mode, literal search, and capture. VT rendering (option a) preserves the existing
terminal machinery, but wraps prose at cell boundaries and makes a browser
emulate a terminal to display a conversation.

`transcript-rendering.test.tsx` is the 80-column prototype. It uses native
OpenTUI text widgets with word wrapping, then captures the same rendered buffer
as OpenTUI `CapturedFrame` rows. The fixture demonstrates that:

- prose wraps at words and the tool event remains a compact semantic summary;
- the serialized frame has 80 cells per row, including span widths;
- capture reads row ranges, search returns a display-cell coordinate, and yank
  extracts a cell range from that one grid;
- a VT fills cells through a word boundary at 80 columns and splits a word after
  resize to 52 columns, while the retained rendering reflows at words.

This evidence is deliberately narrower than a copy-mode implementation. The
fixture fits within the renderer's 24-row buffer, so it does not prove how to
serialize retained content beyond a viewport. It also does not exercise copy
motions or paint a retained-widget selection. Those remain integration work;
selection painting is necessarily pane-specific even when its coordinates and
text operations are shared.

## Serialization contract

The TUI transcript view owns semantic events and presentation state such as
collapsed tool blocks. On request it serializes that current presentation at a
specified width into:

```ts
interface TranscriptGrid {
  cols: number
  rows: string[]
  viewport: { top: number; height: number }
}
```

This is a conceptual shape, not a production TypeScript API. OpenTUI's test-only
`CapturedFrame.lines[].spans` supplies rendered rows and cell widths for the
prototype. A production serializer must preserve the cell positions produced by
OpenTUI's renderer rather than assume Ghostty and OpenTUI assign every grapheme
the same width. The prototype reuses copy mode's Ghostty-based mapping only to
exercise the operations with its CJK fixture: there the string index and cell
column differ, and search and yank still address the intended cells.

The eventual grid adapter needs these capabilities:

1. Serialize all display rows at the pane's current width.
2. Identify the visible row range (`top` and `height`) separately from content.
3. Extract plain text from an inclusive row/cell range.
4. Find literal text and return its row/cell coordinate.

Copy-mode motions, search, yank extraction, visible capture, and full capture can
then share grid-level operations behind PTY and transcript adapters. Viewport
movement and selection painting remain responsibilities of each pane renderer.
Serialization is on demand and width-specific; it is not persisted, replayed
over attach, or treated as transcript identity. A resize discards it and derives
a new grid from the semantic events.

The prototype deliberately does not add the adapter to production. Agent
frames and transcript panes do not exist yet, so adding pane abstractions now
would be speculative. The frame task should define semantic events; the first
transcript pane should implement this narrow serializer beside its retained
widget tree.
