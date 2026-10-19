import { createEffect, createMemo, createSignal, type Accessor } from "solid-js"

export type VimMode = "normal" | "insert" | "replace" | "visual" | "visual-line" | "copy"
export type VimPending = "" | "c" | "d" | "g" | "z" | "f" | "F" | "t" | "T" | "y" | "w" | "r" | "vr"
export type VimFind = { char: string; forward: boolean; till: boolean } | null
export type VimRegister = { text: string; linewise: boolean } | null
export type VimSnapshot = { text: string; cursor: number; data?: unknown }
export type VimRepeat = { run: () => boolean }

type VimHistory = {
  before: VimSnapshot
  after: VimSnapshot
}

const VIM_COUNT_MAX = 9999
const VIM_COUNT_MAX_DIGITS = String(VIM_COUNT_MAX).length

export function createVimState(input: { enabled: Accessor<boolean>; initial?: Accessor<VimMode | undefined> }) {
  const [mode, setMode] = createSignal<VimMode>(input.initial?.() ?? "insert")
  const [pending, setPendingValue] = createSignal<VimPending>("")
  const [pendingDisplay, setPendingDisplay] = createSignal("")
  const [count, setCountValue] = createSignal("")
  const [lastFind, setLastFind] = createSignal<VimFind>(null)
  const [register, setRegister] = createSignal<VimRegister>(null)
  const [anchor, setAnchor] = createSignal<number | null>(null)
  const [replace, setReplace] = createSignal<number | null>(null)
  const [typed, setTyped] = createSignal(false)
  const [undos, setUndos] = createSignal<VimHistory[]>([])
  const [redos, setRedos] = createSignal<VimSnapshot[]>([])
  const [edit, setEdit] = createSignal<VimSnapshot | null>(null)
  const [repeat, setRepeat] = createSignal<VimRepeat | null>(null)
  const [replaying, setReplaying] = createSignal(false)
  const [skipExitOnModeChange, setSkipExitOnModeChange] = createSignal(false)
  const [exitScrollToBottom, setExitScrollToBottom] = createSignal(true)
  const cancelEditCallbacks = new Set<() => void>()

  function setPending(next: VimPending, display = "") {
    setPendingValue(next)
    setPendingDisplay(display)
  }

  function clearPending() {
    if (pending()) setPendingValue("")
    if (pendingDisplay()) setPendingDisplay("")
    clearCount()
  }

  function clearCount() {
    if (count()) setCountValue("")
  }

  function appendCountDigit(digit: string) {
    setCountValue((value) => (value.length >= VIM_COUNT_MAX_DIGITS ? value : value + digit))
  }

  function takeCount(defaultValue = 1) {
    const value = count() ? Number(count()) : defaultValue
    clearCount()
    return Math.max(1, Math.min(Number.isSafeInteger(value) ? value : defaultValue, VIM_COUNT_MAX))
  }

  function clearEdit() {
    setEdit(null)
  }

  function cancelOpenEdit() {
    cancelEditCallbacks.forEach((callback) => callback())
    clearEdit()
  }

  function clearHistory() {
    cancelOpenEdit()
    setUndos([])
    setRedos([])
    setRepeat(null)
  }

  function changeMode(next: VimMode) {
    clearPending()
    clearCount()
    if (next !== "visual" && next !== "visual-line") setAnchor(null)
    if (next !== "replace") {
      setReplace(null)
      setTyped(false)
    }
    setMode(next)
  }

  function push(before: VimSnapshot, after: VimSnapshot) {
    clearEdit()
    if (before.text === after.text && before.cursor === after.cursor) return
    setUndos((list) => [...list, { before, after }])
    setRedos([])
  }

  createEffect(() => {
    const enabled = input.enabled()

    if (!enabled) {
      if (mode() !== "insert") setMode("insert")
      clearPending()
      cancelOpenEdit()
      return
    }
  })

  return {
    mode,
    setMode: changeMode,
    pending,
    pendingDisplay,
    setPending,
    clearPending,
    count,
    appendCountDigit,
    clearCount,
    takeCount,
    lastFind,
    setLastFind,
    register,
    setRegister,
    anchor,
    setAnchor,
    replace,
    setReplace,
    typed,
    setTyped,
    beginEdit(snapshot: VimSnapshot) {
      setEdit(snapshot)
    },
    commitEdit(snapshot: VimSnapshot) {
      const start = edit()
      clearEdit()
      if (!start) return
      push(start, snapshot)
    },
    cancelEdit() {
      cancelOpenEdit()
    },
    onCancelEdit(callback: () => void) {
      cancelEditCallbacks.add(callback)
      return () => cancelEditCallbacks.delete(callback)
    },
    repeat,
    setRepeat(next: VimRepeat | null) {
      setRepeat(next)
    },
    replaying,
    setReplaying,
    push,
    undo(snapshot: VimSnapshot) {
      const item = undos()[undos().length - 1]
      if (!item) return
      setUndos((list) => list.slice(0, -1))
      setRedos((list) => [...list, snapshot])
      clearEdit()
      return item.before
    },
    redo(snapshot: VimSnapshot) {
      const item = redos()[redos().length - 1]
      if (!item) return
      setRedos((list) => list.slice(0, -1))
      setUndos((list) => [...list, { before: snapshot, after: item }])
      clearEdit()
      return item
    },
    resetHistory: clearHistory,
    reset() {
      clearPending()
      clearCount()
      setAnchor(null)
      setReplace(null)
      setTyped(false)
      clearHistory()
      setMode("insert")
    },
    canUndo: createMemo(() => undos().length > 0),
    canRedo: createMemo(() => redos().length > 0),
    isInsert: createMemo(() => mode() === "insert"),
    isReplace: createMemo(() => mode() === "replace"),
    isVisual: createMemo(() => mode() === "visual" || mode() === "visual-line"),
    isVisualLine: createMemo(() => mode() === "visual-line"),
    isCopy: createMemo(() => mode() === "copy"),
    skipExitOnModeChange,
    setSkipExitOnModeChange,
    exitScrollToBottom,
    setExitScrollToBottom,
  }
}
