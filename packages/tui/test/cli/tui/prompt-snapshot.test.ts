import { expect, test } from "bun:test"
import { Skill } from "@opencode/schema/skill"
import { promptSnapshotDataEqual } from "../../../src/component/prompt/snapshot"
import type { PromptInfo } from "../../../src/prompt/history"

const prompt: PromptInfo = {
  text: "@a.ts @build @review [Pasted]",
  files: [{ uri: "file:///a.ts", name: "a.ts", mention: { start: 0, end: 5, text: "@a.ts" } }],
  agents: [{ name: "build", mention: { start: 6, end: 12, text: "@build" } }],
  skills: [{ id: Skill.ID.make("review"), mention: { start: 13, end: 20, text: "@review" } }],
  pasted: [{ text: "expanded", source: { start: 21, end: 29, text: "[Pasted]" } }],
}

test("production snapshot equality ignores text and shifted metadata offsets without changing snapshots", () => {
  const shifted = structuredClone(prompt)
  shifted.text = "prefix " + shifted.text
  for (const part of [...shifted.files!, ...shifted.agents!, ...shifted.skills!]) {
    part.mention!.start += 7
    part.mention!.end += 7
  }
  shifted.pasted[0]!.source.start += 7
  shifted.pasted[0]!.source.end += 7
  const before = structuredClone(prompt)
  const after = structuredClone(shifted)
  expect(promptSnapshotDataEqual(prompt, shifted)).toBe(true)
  expect(prompt).toEqual(before)
  expect(shifted).toEqual(after)
})

test.each(["file", "agent", "skill", "paste", "mention", "attachment"])(
  "production snapshot equality protects changed %s metadata",
  (kind) => {
    const changed = structuredClone(prompt)
    if (kind === "file") changed.files![0]!.uri = "file:///b.ts"
    if (kind === "agent") changed.agents![0]!.name = "plan"
    if (kind === "skill") changed.skills![0]!.id = Skill.ID.make("test")
    if (kind === "paste") changed.pasted[0]!.text = "other expanded text"
    if (kind === "mention") changed.files![0]!.mention!.text = "@b.ts"
    if (kind === "attachment") changed.files!.push({ uri: "data:image/png;base64,abc", name: "image" })
    expect(promptSnapshotDataEqual(prompt, changed)).toBe(false)
  },
)
