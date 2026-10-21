import { createEffect, onCleanup } from "solid-js"
import type { TextareaRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { useClipboard } from "../../context/clipboard"
import { useToast } from "../../ui/toast"
import { useConfig } from "../../config"
import { Keymap } from "../../context/keymap"
import { useVimEnabled } from "../vim"
import { createVimState, type VimMode, type VimRegister, type VimSnapshot } from "../vim/vim-state"
import { createVimHandler, vimLangmapKeyName } from "../vim/vim-handler"
import { clearSelection } from "../vim/vim-motions"
import { useVimIndicator } from "../vim/vim-indicator"
import type { CopyModeAdapter } from "../vim/copy-adapter"

let lastVimMode: VimMode | undefined

export function usePromptVim(opts: {
  textarea: () => TextareaRenderable
  mode: () => "normal" | "shell"
  copy?: () => CopyModeAdapter | undefined
  disabled?: () => boolean
  submit: () => void
  autocomplete: () => false | "@" | "/"
  snapshot: () => VimSnapshot
  snapshotDataEqual: (before: unknown, after: unknown) => boolean
  restore: (next: VimSnapshot) => void
}) {
  const clipboard = useClipboard()
  const toast = useToast()
  const config = useConfig().data
  const keymap = Keymap.use()
  const renderer = useRenderer()
  const vimEnabled = useVimEnabled()
  const vimState = createVimState({
    enabled: vimEnabled,
    initial: () => (opts.copy?.()?.active() ? "copy" : (lastVimMode ?? config.vim_initial_mode ?? "insert")),
  })

  const releaseSelection = keymap.copy.register(() => (vimState.isCopy() ? opts.copy?.()?.selection() : undefined))
  let popCopyMode: (() => void) | undefined
  onCleanup(() => {
    popCopyMode?.()
    releaseSelection()
    if (vimEnabled()) lastVimMode = vimState.isCopy() ? "normal" : vimState.mode()
    vimState.cancelEdit()
  })
  onCleanup(
    keymap.vim.register(
      () => (vimEnabled() && opts.mode() === "normal" ? vimState.mode() : "insert"),
      () =>
        (keymap.mode.current() === "base" && !opts.disabled?.()) ||
        (keymap.mode.current() === "copy" && vimState.isCopy()),
    ),
  )

  createEffect(() => {
    const mode = keymap.mode.current()
    if (vimState.isCopy()) {
      // A newly mounted question/permission must remain underneath an already active copy scope.
      if (popCopyMode && (mode === "form" || mode === "permission")) {
        popCopyMode()
        popCopyMode = undefined
      }
      popCopyMode ??= keymap.mode.push("copy")
      return
    }
    popCopyMode?.()
    popCopyMode = undefined
  })

  const vimIndicator = useVimIndicator({
    enabled: vimEnabled,
    active: () => opts.mode() === "normal",
    state: vimState,
    copyVisual: () => opts.copy?.()?.visualMode(),
    copySearch: () => opts.copy?.()?.searchDisplay(),
  })

  function enterCopyMode() {
    const copy = opts.copy?.()
    if (!vimEnabled() || !copy || opts.disabled?.()) return false
    if (vimState.isInsert()) vim.finishInsertEdit()
    vimState.setMode("copy")
    copy.enter()
    const textarea = opts.textarea()
    if (textarea && !textarea.isDestroyed && !textarea.focused) textarea.focus()
    return true
  }

  function exitCopyMode(scrollToBottom?: boolean) {
    const copy = opts.copy?.()
    if (!copy) return false
    vimState.setMode("normal")
    copy.exit(scrollToBottom)
    return true
  }

  function copyEligible() {
    const textarea = opts.textarea()
    return !!textarea && !textarea.isDestroyed && vimEnabled() && opts.mode() === "normal" && !opts.disabled?.()
  }

  function promptSelectionText() {
    const textarea = opts.textarea()
    if (!textarea || textarea.isDestroyed) return
    return textarea.editorView.getSelectedText() || undefined
  }

  async function copyPromptSelection() {
    const text = promptSelectionText()
    if (!text) return false
    return clipboard.write(text).then(
      () => {
        toast.show({ message: "Copied to clipboard", variant: "info" })
        return true
      },
      (error) => {
        toast.error(error)
        return false
      },
    )
  }

  let clipboardRegister: VimRegister = null
  let flash = 0
  let flashSpan: { start: number; end: number } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })

  function useSystemClipboardRegister() {
    return !!config.vim_system_clipboard_register
  }

  async function setVimRegister(register: VimRegister) {
    if (!useSystemClipboardRegister()) {
      vimState.setRegister(register)
      return
    }
    clipboardRegister = register
    if (!register) return
    await clipboard.write(register.text).catch(toast.error)
  }

  async function syncVimRegisterFromClipboard() {
    if (!useSystemClipboardRegister()) return
    const content = await clipboard.read().catch(() => undefined)
    if (!content) return
    if (content.mime !== "text/plain" || !content.data) {
      clipboardRegister = null
      return
    }
    const previous = clipboardRegister
    clipboardRegister = {
      text: content.data,
      linewise: previous?.text === content.data ? previous.linewise : false,
    }
  }

  function shouldSyncVimRegister(event: {
    name?: string
    shift?: boolean
    ctrl?: boolean
    meta?: boolean
    super?: boolean
    sequence?: string
    raw?: string
  }) {
    if (!useSystemClipboardRegister() || !vimEnabled()) return false
    if (event.ctrl || event.meta || event.super) return false
    if (vimState.isInsert() || vimState.isReplace()) return false
    if (["r", "vr", "f", "F", "t", "T"].includes(vimState.pending())) return false
    const key = vimLangmapKeyName(event)
    if (key.length !== 1) return false
    const mapped =
      config.vim_langmap?.[key] ??
      (event.shift ? config.vim_langmap?.[key.toLowerCase()]?.toUpperCase() : undefined) ??
      key
    return mapped.toLowerCase() === "p"
  }

  function promptJump(action: "top" | "bottom" | "high" | "middle" | "low") {
    const textarea = opts.textarea()
    if (!textarea || textarea.isDestroyed) return
    if (action === "top") return textarea.gotoBufferHome()
    if (action === "bottom") return textarea.gotoBufferEnd()
    const row =
      action === "high"
        ? 0
        : action === "middle"
          ? Math.max(0, Math.floor((textarea.height - 1) / 2))
          : textarea.height - 1
    let previous = -1
    while (textarea.visualCursor.visualRow > row && textarea.cursorOffset !== previous) {
      previous = textarea.cursorOffset
      textarea.moveCursorUp()
    }
    previous = -1
    while (textarea.visualCursor.visualRow < row && textarea.cursorOffset !== previous) {
      previous = textarea.cursorOffset
      textarea.moveCursorDown()
    }
  }

  const vim = createVimHandler({
    enabled: vimEnabled,
    state: vimState,
    textarea: opts.textarea,
    register: () => (useSystemClipboardRegister() ? clipboardRegister : vimState.register()),
    setRegister: setVimRegister,
    pasteOverSelection() {
      const selection = opts.textarea().editorView.getSelection()
      if (!selection) return false
      return !flashSpan || selection.start !== flashSpan.start || selection.end !== flashSpan.end
    },
    langmap: () => config.vim_langmap,
    vimLineMotions: () => config.vim_line_motions,
    vimEscapeSequence: config.vim_escape_sequence,
    submit: opts.submit,
    commandPalette: () => keymap.dispatch("command.palette.show"),
    scroll(action) {
      if (action === "line-down") keymap.dispatch("session.line.down")
      if (action === "line-up") keymap.dispatch("session.line.up")
      if (action === "half-down") keymap.dispatch("session.half.page.down")
      if (action === "half-up") keymap.dispatch("session.half.page.up")
      if (action === "page-down") keymap.dispatch("session.page.down")
      if (action === "page-up") keymap.dispatch("session.page.up")
    },
    jump: promptJump,
    navigate(action) {
      if (action === "up" && !vimState.isCopy()) enterCopyMode()
      if (action === "down" && vimState.isCopy()) exitCopyMode(false)
    },
    copy: (action) => opts.copy?.()?.move(action),
    copyHalfPage: (direction) => opts.copy?.()?.halfPage(direction),
    copyVisual: (mode) => opts.copy?.()?.visual(mode),
    copyExitVisual: () => opts.copy?.()?.exitVisual(),
    copyExit: exitCopyMode,
    copyExitPreserveScroll() {
      opts.copy?.()?.exitPreserveScroll()
      vimState.setMode("normal")
    },
    copyFocusInput: () => opts.copy?.()?.focusInput(),
    copyYank() {
      const register = opts.copy?.()?.yank()
      if (register) void setVimRegister(register)
    },
    copyYankLine() {
      const register = opts.copy?.()?.yankLine()
      if (register) void setVimRegister(register)
    },
    copyYankMatchingBracket() {
      const register = opts.copy?.()?.yankMatchingBracket()
      if (!register) return false
      void setVimRegister(register)
      return true
    },
    copyToggleVisualEnd() {
      opts.copy?.()?.copyToggleVisualEnd()
      return true
    },
    copyCopy: () => opts.copy?.()?.copy(),
    copyToggleCollapsed: () => opts.copy?.()?.toggleCollapsed() ?? false,
    copyActivate: () => opts.copy?.()?.activate() ?? false,
    copyIsVisual: () => opts.copy?.()?.isVisual() ?? false,
    copyJump: (action) => opts.copy?.()?.jump(action),
    copyWordNext: (big) => opts.copy?.()?.wordNext(big) ?? false,
    copyWordPrev: (big) => opts.copy?.()?.wordPrev(big) ?? false,
    copyWordEnd: (big) => opts.copy?.()?.wordEnd(big) ?? false,
    copyMatchingBracket: () => opts.copy?.()?.matchingBracket() ?? false,
    copyNextParagraph: () => opts.copy?.()?.nextParagraph() ?? false,
    copyPreviousParagraph: () => opts.copy?.()?.previousParagraph() ?? false,
    copySearchStart(direction) {
      const copy = opts.copy?.()
      if (!copy) return false
      if (!vimState.isCopy()) {
        vimState.setMode("copy")
        copy.enter()
      }
      copy.searchStart(direction)
    },
    copySearchAppend: (value) => opts.copy?.()?.searchAppend(value) ?? false,
    copySearchBackspace: () => opts.copy?.()?.searchBackspace() ?? false,
    copySearchSubmit: () => opts.copy?.()?.searchSubmit() ?? true,
    copySearchCancel: () => opts.copy?.()?.searchCancel(),
    copySearchClear: () => opts.copy?.()?.searchClear() ?? false,
    copySearchActive: () => opts.copy?.()?.searchActive() ?? false,
    copySearchHighlighted: () => opts.copy?.()?.searchHighlighted() ?? false,
    copySearchNext: () => opts.copy?.()?.searchNext() ?? false,
    copySearchPrevious: () => opts.copy?.()?.searchPrevious() ?? false,
    copyText: () => opts.copy?.()?.text() ?? "",
    copyCol: () => opts.copy?.()?.col() ?? 0,
    setCopyCol: (offset) => opts.copy?.()?.setCol(offset),
    setCopyStick: (stick) => opts.copy?.()?.setStick(stick),
    copyScroll: (action) => opts.copy?.()?.scroll(action),
    autocomplete: opts.autocomplete,
    history: () => true,
    snapshot: opts.snapshot,
    snapshotDataEqual: opts.snapshotDataEqual,
    restore: opts.restore,
    flash(span) {
      const textarea = opts.textarea()
      flash++
      flashSpan = span
      const id = flash
      const cursor = textarea.cursorOffset
      textarea.editorView.setSelection(span.start, span.end)
      textarea.cursorOffset = cursor
      textarea.invalidateIntrinsicSize()
      renderer.requestRender()
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const textarea = opts.textarea()
        if (!textarea || textarea.isDestroyed || id !== flash) return
        if (vimState.isVisual()) {
          flashSpan = undefined
          return
        }
        const selection = textarea.editorView.getSelection()
        if (!selection || selection.start !== span.start || selection.end !== span.end) {
          flashSpan = undefined
          return
        }
        flashSpan = undefined
        clearSelection(textarea)
        textarea.invalidateIntrinsicSize()
        renderer.requestRender()
      }, 70)
    },
  })

  onCleanup(
    keymap.intercept("key", ({ event, consume }) => {
      if (keymap.mode.current() !== "copy" || !vimState.isCopy() || !copyEligible()) return
      if (vim.handleKey(event)) consume()
    }),
  )

  return {
    vim,
    vimState,
    vimIndicator,
    enterCopyMode,
    exitCopyMode,
    copyEligible,
    promptSelectionText,
    copyPromptSelection,
    shouldSyncVimRegister,
    syncVimRegisterFromClipboard,
  }
}
