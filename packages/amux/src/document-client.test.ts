/**
 * document-client helpers without a live daemon.
 *
 * OpenDocumentStore already covers force-close and contend. writeDocument is
 * Open/Write/Save composed — covered by documents.test wire smoke. This file
 * holds the rebase retry unique to replaceDocumentOn.
 */
import { expect } from "bun:test";
import { Effect } from "effect";
import type { DocumentMeta } from "@danielfgray/amux-text-buffer";
import { ControlError } from "./control.ts";
import { replaceDocumentOn, type DocumentControl } from "./document-client.ts";
import { testEffect } from "./test-effect.ts";

const meta = (generation: number, dirty: boolean, text: string): DocumentMeta => ({
  uri: "file:///scratch.ts",
  generation,
  dirty,
  lineCount: 1,
  byteLength: Buffer.byteLength(text, "utf8"),
  charCount: text.length,
  refs: 1,
});

testEffect("replaceDocument updates the store without persisting", () =>
  Effect.gen(function* () {
    const writes: Array<{ baseGeneration: number; text: string }> = [];
    const control: DocumentControl = {
      DocumentSnapshot: () => Effect.succeed({ ...meta(1, false, "disk\n"), text: "disk\n" }),
      DocumentOpen: () => Effect.succeed(meta(1, false, "disk\n")),
      DocumentWrite: ({ baseGeneration, text }: { baseGeneration: number; text: string }) => {
        writes.push({ baseGeneration, text });
        return Effect.succeed(meta(baseGeneration + 1, true, text));
      },
    };

    const result = yield* replaceDocumentOn(control, "/scratch.ts", "memory\n", 1);
    expect(result.generation).toBe(2);
    expect(result.dirty).toBe(true);
    expect(writes).toEqual([{ baseGeneration: 1, text: "memory\n" }]);
  }),
);

testEffect("replaceDocument rebases once on a stale generation", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const control: DocumentControl = {
      DocumentSnapshot: () => Effect.succeed({ ...meta(2, true, "human\n"), text: "human\n" }),
      DocumentOpen: () => Effect.succeed(meta(2, true, "human\n")),
      DocumentWrite: ({ baseGeneration, text }: { baseGeneration: number; text: string }) => {
        attempts += 1;
        if (baseGeneration === 1) {
          return Effect.fail(new ControlError({ message: "stale generation" }));
        }
        return Effect.succeed(meta(baseGeneration + 1, true, text));
      },
    };

    const result = yield* replaceDocumentOn(control, "/scratch.ts", "memory\n", 1);
    expect(attempts).toBe(2);
    expect(result.generation).toBe(3);
    expect(result.dirty).toBe(true);
  }),
);
