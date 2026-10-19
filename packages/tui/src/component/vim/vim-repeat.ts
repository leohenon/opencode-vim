import type { TextareaRenderable } from "@opentui/core"
import type { createVimState, VimSnapshot } from "./vim-state"
import { replaceUnderCursor } from "./vim-motions"

type VimTextPatch = {
  startOffset: number
  baseEndOffset: number
  insert: string
  cursorOffset: number
}

type VimTextEdit = Omit<VimTextPatch, "cursorOffset">

type VimRepeatRecorder = {
  textarea: TextareaRenderable
  insertText: TextareaRenderable["insertText"]
  deleteRange: TextareaRenderable["deleteRange"]
  setText: TextareaRenderable["setText"]
}

type VimActiveRepeat = {
  before: VimSnapshot
  base: VimSnapshot
  setup: () => boolean | void
} & ({ type: "patch"; edits: VimTextEdit[]; recorder?: VimRepeatRecorder } | { type: "replace"; chars: string[] })

type VimPatchRepeat = Extract<VimActiveRepeat, { type: "patch" }>

export function createVimRepeat(input: {
  state: ReturnType<typeof createVimState>
  textarea: () => TextareaRenderable
  snapshot: () => VimSnapshot
  snapshotDataEqual?: (before: unknown, after: unknown) => boolean
  tracked: () => boolean
}) {
  let activeRepeat: VimActiveRepeat | undefined
  let mutationDepth = 0

  function clampOffset(offset: number, length: number) {
    return Math.max(0, Math.min(length, offset))
  }

  function changed(before: VimSnapshot, after: VimSnapshot) {
    return before.text !== after.text || before.cursor !== after.cursor
  }

  function sameData(before: VimSnapshot, after: VimSnapshot) {
    return input.snapshotDataEqual?.(before.data, after.data) ?? Bun.deepEquals(before.data, after.data)
  }

  function textEdit(origin: VimSnapshot, before: VimSnapshot, after: VimSnapshot): VimTextEdit | null {
    if (before.text === after.text) return null
    let commonStart = 0
    while (
      commonStart < before.text.length &&
      commonStart < after.text.length &&
      before.text[commonStart] === after.text[commonStart]
    )
      commonStart++
    const start = Math.min(commonStart, before.cursor)
    let baseEnd = before.text.length
    let afterEnd = after.text.length
    while (baseEnd > start && afterEnd > start && before.text[baseEnd - 1] === after.text[afterEnd - 1]) {
      baseEnd--
      afterEnd--
    }
    return {
      startOffset: start - origin.cursor,
      baseEndOffset: baseEnd - origin.cursor,
      insert: after.text.slice(start, afterEnd),
    }
  }

  function patch(base: VimSnapshot, after: VimSnapshot): VimTextPatch | null {
    const edit = textEdit(base, base, after)
    if (!edit)
      return {
        startOffset: 0,
        baseEndOffset: 0,
        insert: "",
        cursorOffset: after.cursor - base.cursor,
      }
    const deleted = base.text.slice(base.cursor + edit.startOffset, base.cursor + edit.baseEndOffset)
    if (deleted && edit.insert.includes(deleted)) return null
    return {
      ...edit,
      cursorOffset: after.cursor - base.cursor,
    }
  }

  function applyTextEdit(base: VimSnapshot, next: VimTextEdit) {
    const textarea = input.textarea()
    const start = clampOffset(base.cursor + next.startOffset, textarea.plainText.length)
    const end = Math.max(start, clampOffset(base.cursor + next.baseEndOffset, textarea.plainText.length))
    if (end > start) {
      const startPos = textarea.editBuffer.offsetToPosition(start)
      const endPos = textarea.editBuffer.offsetToPosition(end)
      if (!startPos || !endPos) return
      textarea.deleteRange(startPos.row, startPos.col, endPos.row, endPos.col)
    }
    textarea.cursorOffset = start
    if (next.insert) textarea.insertText(next.insert)
    textarea.cursorOffset = start + next.insert.length
  }

  function applyPatch(base: VimSnapshot, next: VimTextPatch) {
    applyTextEdit(base, next)
    const textarea = input.textarea()
    textarea.cursorOffset = clampOffset(base.cursor + next.cursorOffset, textarea.plainText.length)
  }

  function recordTextEdit(active: VimPatchRepeat, before: VimSnapshot) {
    if (activeRepeat !== active || input.state.replaying()) return
    const edit = textEdit(active.base, before, input.snapshot())
    if (edit) active.edits.push(edit)
  }

  function recordMutation<T>(active: VimPatchRepeat, run: () => T) {
    if (mutationDepth) return run()
    const before = input.snapshot()
    mutationDepth++
    try {
      return run()
    } finally {
      mutationDepth--
      recordTextEdit(active, before)
    }
  }

  function startRecording(active: VimPatchRepeat) {
    const textarea = input.textarea()
    const recorder = {
      textarea,
      insertText: textarea.insertText,
      deleteRange: textarea.deleteRange,
      setText: textarea.setText,
    }
    active.recorder = recorder
    textarea.insertText = (...args) => {
      return recordMutation(active, () => recorder.insertText.apply(textarea, args))
    }
    textarea.deleteRange = (...args) => {
      return recordMutation(active, () => recorder.deleteRange.apply(textarea, args))
    }
    textarea.setText = (...args) => {
      return recordMutation(active, () => recorder.setText.apply(textarea, args))
    }
  }

  function stopRecording(active: VimActiveRepeat) {
    if (active.type !== "patch" || !active.recorder) return
    active.recorder.textarea.insertText = active.recorder.insertText
    active.recorder.textarea.deleteRange = active.recorder.deleteRange
    active.recorder.textarea.setText = active.recorder.setText
    active.recorder = undefined
  }

  function finishActiveRepeat() {
    const active = activeRepeat
    activeRepeat = undefined
    if (active) stopRecording(active)
    return active
  }

  function cancel() {
    finishActiveRepeat()
  }

  input.state.onCancelEdit(cancel)

  function applyTextEdits(base: VimSnapshot, edits: VimTextEdit[], cursorOffset: number) {
    edits.forEach((edit) => applyTextEdit(base, edit))
    const textarea = input.textarea()
    textarea.cursorOffset = clampOffset(base.cursor + cursorOffset, textarea.plainText.length)
  }

  function withReplay(run: () => void) {
    input.state.setReplaying(true)
    try {
      run()
    } finally {
      input.state.setReplaying(false)
    }
  }

  function pushReplay(before: VimSnapshot, after: VimSnapshot) {
    if (!sameData(before, after)) input.state.setRepeat(null)
    if (!changed(before, after)) return false
    input.state.push(before, after)
    return true
  }

  function recordRepeat(run: () => void) {
    if (input.state.replaying()) return
    input.state.setRepeat({
      run() {
        const before = input.snapshot()
        withReplay(run)
        return pushReplay(before, input.snapshot())
      },
    })
  }

  function edit(run: () => boolean | void) {
    if (!input.tracked()) {
      run()
      return
    }
    const before = input.snapshot()
    const repeatable = !input.state.replaying() && !input.state.isVisual()
    const applied = run() === true
    const after = input.snapshot()
    input.state.push(before, after)
    if (!repeatable) return
    if (!sameData(before, after)) {
      input.state.setRepeat(null)
      return
    }
    if (applied || changed(before, after)) recordRepeat(run)
  }

  function begin(run?: () => boolean | void, options?: { replace?: boolean }) {
    if (!input.tracked()) {
      run?.()
      return
    }
    cancel()
    const before = input.snapshot()
    const repeatable = !input.state.replaying() && !input.state.isVisual()
    input.state.beginEdit(before)
    if (run?.() === false) {
      input.state.cancelEdit()
      return
    }
    if (repeatable) {
      const next = {
        before,
        base: input.snapshot(),
        setup: run ?? (() => {}),
      }
      activeRepeat = options?.replace ? { ...next, type: "replace", chars: [] } : { ...next, type: "patch", edits: [] }
      if (activeRepeat.type === "patch") startRecording(activeRepeat)
    }
  }

  function commit(after: VimSnapshot) {
    const active = finishActiveRepeat()
    if (!active || input.state.replaying()) return
    if (!sameData(active.before, active.base) || !sameData(active.base, after)) {
      input.state.setRepeat(null)
      return
    }
    const recordCommittedRepeat = (run: () => void) =>
      input.state.setRepeat({
        run() {
          const before = input.snapshot()
          let failed = false
          withReplay(() => {
            if (active.setup() === false) {
              failed = true
              input.state.setMode("normal")
              return
            }
            run()
            input.state.setMode("normal")
          })
          const repeated = input.snapshot()
          if (failed) return false
          return pushReplay(before, repeated)
        },
      })
    if (active.type === "replace" && active.chars.length) {
      recordCommittedRepeat(() => {
        const start = input.state.replace()
        active.chars.forEach((char) => replaceUnderCursor(input.textarea(), char))
        if (start !== null) input.textarea().cursorOffset = Math.max(start, input.textarea().cursorOffset - 1)
      })
      return
    }
    if (active.type === "replace") {
      input.state.setRepeat(null)
      return
    }
    if (active.edits.length) {
      const cursorOffset = after.cursor - active.base.cursor
      recordCommittedRepeat(() => applyTextEdits(input.snapshot(), active.edits, cursorOffset))
      return
    }
    const next = patch(active.base, after)
    if (!next) {
      input.state.setRepeat(null)
      return
    }
    if (active.before.text === active.base.text && active.base.text === after.text && !next.insert) {
      input.state.setRepeat(null)
      return
    }
    recordCommittedRepeat(() => applyPatch(input.snapshot(), next))
  }

  return {
    edit,
    begin,
    commit,
    recordReplaceChar(char: string) {
      if (activeRepeat?.type === "replace") activeRepeat.chars.push(char)
    },
    cancel,
  }
}
