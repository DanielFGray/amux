# Editor Render Measurement

Measured on 2026-09-07 with Bun 1.4.1, OpenTUI 0.5.1, Solid 1.9.14,
Linux x64, and an Intel Core i7-8665U CPU. The source was the working tree
based on commit `627ab4f`, including the editor shell and ordered file I/O.

## Run

From the repository root:

```sh
bun run --cwd packages/editor bench:render
```

The script runs Bun's test command from the repository root so it loads the
root `bunfig.toml` and OpenTUI's Solid transform. Do not compare an untransformed
JSX run with these results.

## Method

- Generate source-like files with 100, 1,000, and 10,000 unique, fixed-width lines.
- Read each file through the actual editor's file-loading path.
- Mount the editor through the session-view registry in a 100-column,
  40-row OpenTUI test renderer.
- Assert that inserting `x` changes the rendered frame and backspace restores it.
- Warm up with 40 keystrokes, then measure 250 alternating insert/backspace keys.
- Measure from entry into the registered key handler through completion of
  `renderOnce()`. Frame assertions and initial file reads are outside that interval.
- Release the renderer and temporary files after the run.

## Results

Separate run after the verification commands completed:

|  Lines | Median ms/key | p95 ms/key | Mean ms/key |
| -----: | ------------: | ---------: | ----------: |
|    100 |         1.135 |      2.043 |       1.314 |
|  1,000 |         0.901 |      1.466 |       0.983 |
| 10,000 |         0.859 |      1.261 |       0.941 |

The same benchmark within the full unit suite measured 1.919/1.345/1.374 ms
median and 2.472/2.297/2.171 ms p95 at those sizes. A run concurrent with
type checking and analysis was slower. These are observations, not CI limits.

## Trigger Path

In `../src/EditorPane.tsx`, `createEditorBuffer` registers `captureKeys`.
The key is drained into `reduceEditor`, then `setState` publishes the new state.
Solid invalidates `EditorPane`'s `visible` and `status` memos and updates the
visible `LineRow` components. The benchmark then calls OpenTUI `renderOnce`.

The renderer slices the buffer to viewport height before rendering rows.
It does not create one renderable per file line. However, `insertChar` and
`insertBackspace` in `../src/vim-core.ts` copy the complete line array, so
an edit still has an O(total lines) state-copy component.

## Interpretation

This workload provides no evidence that a cell-grid replacement is needed at
10,000 lines. It does not establish a general editor performance guarantee.
The sizes run in ascending order, so JIT warm-up can favor later sizes; the
lower time at 10,000 lines does not mean larger files are faster.

This measures an in-process test renderer, not terminal transport, physical
display latency, daemon command latency, syntax highlighting, LSP work,
long-line horizontal scrolling, or Unicode cell layout. File reads are not timed.
The cell-grid design decision remains a separate task; this spike adds no
alternative renderer.
