import { expect, test } from "bun:test";
import { conversationPreview } from "@danielfgray/amux/project-store.ts";
import type { ConversationRecord } from "@danielfgray/amux/project-store.ts";
import { sessionEntries, type SessionPickerWorkspace } from "./SessionPicker.tsx";

test("conversationPreview prefers the first user text blob", () => {
  expect(
    conversationPreview(
      JSON.stringify({
        content: [
          { role: "system", content: "sys" },
          { role: "user", content: [{ type: "text", text: "ship the picker" }] },
        ],
      }),
    ),
  ).toBe("ship the picker");
  expect(conversationPreview("{}")).toBe("(conversation)");
});

test("sessionEntries sorts by conversation date, newest first", () => {
  const snapshot: SessionPickerWorkspace = {
    spaces: [
      {
        id: "s1",
        name: "amux",
        dir: "/tmp/amux",
        windows: [
          {
            sessions: [
              {
                id: "agent-live",
                name: "native-agent",
                exited: false,
                kind: "component",
                provider: "native",
              },
              {
                id: "agent-dead",
                name: "native-agent",
                exited: true,
                kind: "component",
                provider: "native",
              },
            ],
          },
        ],
      },
    ],
    state: { activeSpace: "s1" },
  };

  const stored: ConversationRecord[] = [
    {
      session: "agent-live",
      conversation: JSON.stringify({
        content: [{ role: "user", content: [{ type: "text", text: "still going" }] }],
      }),
      updated: 100,
    },
    {
      session: "agent-orphan-old",
      conversation: JSON.stringify({
        content: [{ role: "user", content: [{ type: "text", text: "ancient" }] }],
      }),
      updated: 50,
    },
    {
      session: "agent-orphan-new",
      conversation: JSON.stringify({
        content: [{ role: "user", content: [{ type: "text", text: "fresh" }] }],
      }),
      updated: 300,
    },
    {
      session: "agent-dead",
      conversation: JSON.stringify({
        content: [{ role: "user", content: [{ type: "text", text: "mid" }] }],
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
