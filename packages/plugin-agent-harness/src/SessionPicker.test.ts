import { expect, test } from "bun:test";
import type { WorkspaceSnapshot } from "@danielfgray/amux";
import { conversationPreview } from "@danielfgray/amux/project-store.ts";
import type { ConversationRecord } from "@danielfgray/amux/project-store.ts";
import { sessionEntries } from "./SessionPicker.tsx";

test("conversationPreview prefers the first user text blob", () => {
  expect(
    conversationPreview(
      JSON.stringify({
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: [{ type: "text", text: "ship the picker" }] },
        ],
      }),
    ),
  ).toBe("ship the picker");
  expect(conversationPreview("{}")).toBe("(conversation)");
});

test("sessionEntries sorts by conversation date, newest first", () => {
  const snapshot = {
    revision: 1,
    spaces: [
      {
        id: "s1",
        name: "amux",
        dir: "/tmp/amux",
        state: { activeWindow: 1 },
        windows: [
          {
            number: 1,
            state: { focus: null },
            layout: { root: null, focus: null },
            sessions: [
              {
                id: "agent-live",
                name: "native-agent",
                cwd: "/tmp/amux",
                cols: 80,
                rows: 24,
                exited: false,
                exitCode: null,
                kind: "component",
                provider: "native",
              },
              {
                id: "agent-dead",
                name: "native-agent",
                cwd: "/tmp/amux",
                cols: 80,
                rows: 24,
                exited: true,
                exitCode: 1,
                kind: "component",
                provider: "native",
              },
            ],
          },
        ],
      },
    ],
    state: { activeSpace: "s1" },
  } as unknown as WorkspaceSnapshot;

  const stored: ConversationRecord[] = [
    {
      session: "agent-live",
      conversation: JSON.stringify({
        messages: [{ role: "user", content: [{ type: "text", text: "still going" }] }],
      }),
      updated: 100,
    },
    {
      session: "agent-orphan-old",
      conversation: JSON.stringify({
        messages: [{ role: "user", content: [{ type: "text", text: "ancient" }] }],
      }),
      updated: 50,
    },
    {
      session: "agent-orphan-new",
      conversation: JSON.stringify({
        messages: [{ role: "user", content: [{ type: "text", text: "fresh" }] }],
      }),
      updated: 300,
    },
    {
      session: "agent-dead",
      conversation: JSON.stringify({
        messages: [{ role: "user", content: [{ type: "text", text: "mid" }] }],
      }),
      updated: 200,
    },
  ];

  const entries = sessionEntries(snapshot, stored);
  expect(entries.map((entry) => entry.value)).toEqual([
    "agent-orphan-new", // 300
    "agent-dead", // 200
    "agent-live", // 100
    "agent-orphan-old", // 50
  ]);
  expect(entries[0]?.kind).toBe("stored");
  expect(entries[0]?.detail).toContain("fresh");
});
