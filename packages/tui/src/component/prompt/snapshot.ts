import type { PromptInfo } from "../../prompt/history"

export function promptSnapshotDataEqual(before: unknown, after: unknown) {
  if (!before || typeof before !== "object" || !after || typeof after !== "object") {
    return Bun.deepEquals(before, after)
  }
  return Bun.deepEquals(normalizePromptSnapshot(before as PromptInfo), normalizePromptSnapshot(after as PromptInfo))
}

function normalizePromptSnapshot(prompt: PromptInfo) {
  const mention = (value: { start: number; end: number; text: string } | undefined) =>
    value ? { ...value, start: 0, end: 0 } : undefined
  // Text changes are recorded separately by Vim repeat; only metadata changes make an edit unsafe to replay.
  const { text: _, ...metadata } = prompt
  return {
    ...metadata,
    files: prompt.files?.map((part) => ({ ...part, mention: mention(part.mention) })),
    agents: prompt.agents?.map((part) => ({ ...part, mention: mention(part.mention) })),
    skills: prompt.skills?.map((part) => ({ ...part, mention: mention(part.mention) })),
    pasted: prompt.pasted.map((part) => ({
      ...part,
      source: { ...part.source, start: 0, end: 0 },
    })),
  }
}
