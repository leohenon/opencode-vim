import type { SessionMessageInfo } from "@opencode/client"
import { groupID } from "./anchors"
import type { SessionRow } from "./grouping/session"
import { resolvePart, sessionRowID } from "./rows"
import type { CopyTarget } from "./copy-mode"

// Descendant identity is independent of the parent overlay's coordinates.
export const copyIdentities = new WeakMap<object, () => CopyTarget>()
export const copyHeaders = new WeakMap<object, () => string | undefined>()

export function identifyCopyNode(node: object, target: () => CopyTarget) {
  copyIdentities.set(node, target)
}

export function identifyCopyHeader(node: object, id: () => string | undefined) {
  copyHeaders.set(node, id)
}

export function copyTarget(
  row: SessionRow,
  message: (messageID: string) => SessionMessageInfo | undefined,
  boundaryID?: string,
): CopyTarget {
  const key = copyRowKey(row)
  const id = sessionRowID(row, boundaryID) ?? `session-copy:${key}`
  if (row.type === "group") return { key, id, role: "assistant", kind: "tool", col: 3 }
  if (row.type === "message") {
    const item = message(row.messageID)
    if (item?.type === "user") return { key, id, messageID: row.messageID, role: "user", kind: "user", col: 3 }
    return { key, id, messageID: row.messageID, role: "assistant", kind: "tool", col: 3 }
  }
  if (row.type === "part") {
    const item = message(row.ref.messageID)
    const part = item?.type === "assistant" ? resolvePart(item, row.ref.partID) : undefined
    const messageID = row.ref.messageID
    if (part?.type === "text")
      return { key, id, role: "assistant", kind: "text", part: row.ref.partID, messageID, col: 3 }
    if (part?.type === "reasoning")
      return { key, id, role: "assistant", kind: "reasoning", part: row.ref.partID, messageID, col: 3 }
    return {
      key,
      id,
      role: "assistant",
      kind: "tool",
      part: row.ref.partID,
      messageID,
      tool: part?.type === "tool" ? part.name : undefined,
      col: 3,
    }
  }
  return { key, id, role: "assistant", kind: "tool", col: 3 }
}

export function copyRowKey(row: SessionRow) {
  if (row.type === "group") return `group:${groupID(row, 0) ?? JSON.stringify(row.children)}`
  if (row.type === "part") return `part:${row.ref.messageID}:${row.ref.partID}`
  if (row.type === "message" || row.type === "assistant-footer") return `${row.type}:${row.messageID}`
  if (row.type === "compaction-queued") return `${row.type}:${row.inboxID}`
  if (row.type === "turn-usage") return `${row.type}:${row.messageIDs.join(":")}`
  return row satisfies never
}
