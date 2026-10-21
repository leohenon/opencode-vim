import { expect, test } from "bun:test"
import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"
import { copyRowKey, copyTarget } from "../../../src/routes/session/copy-geometry"
import type { SessionRow } from "../../../src/routes/session/grouping/session"

const messages = new Map<string, SessionMessageInfo>([
  ["user", { type: "user", id: "user", text: "hello", time: { created: 1 } }],
  [
    "assistant",
    {
      type: "assistant",
      id: "assistant",
      agent: "build",
      model: { providerID: "provider", id: "model" },
      time: { created: 2 },
      content: [
        { type: "text", text: "answer" },
        {
          type: "tool",
          id: "tool",
          name: "edit",
          state: { status: "running", input: {}, metadata: {} },
          time: { created: 3 },
        },
      ],
    } satisfies SessionMessageAssistant,
  ],
])
const message = (id: string) => messages.get(id)

test("adapts V2 session rows to stable copy targets", () => {
  const rows: SessionRow[] = [
    { type: "message", messageID: "user" },
    { type: "part", ref: { messageID: "assistant", partID: "text:0" } },
    { type: "part", ref: { messageID: "assistant", partID: "tool" } },
  ]

  expect(rows.map((row) => copyTarget(row, message))).toEqual([
    { key: "message:user", id: "session-copy:message:user", role: "user", kind: "user", messageID: "user", col: 3 },
    {
      key: "part:assistant:text:0",
      id: "session-part:assistant:text:0",
      role: "assistant",
      kind: "text",
      part: "text:0",
      messageID: "assistant",
      col: 3,
    },
    {
      key: "part:assistant:tool",
      id: "session-part:assistant:tool",
      role: "assistant",
      kind: "tool",
      part: "tool",
      messageID: "assistant",
      tool: "edit",
      col: 3,
    },
  ])
})

test("copy row keys do not depend on projection position", () => {
  const row: SessionRow = { type: "assistant-footer", messageID: "assistant" }
  expect(copyRowKey(row)).toBe("assistant-footer:assistant")
  expect(copyTarget(row, message, "assistant").id).toBe("assistant")
})
