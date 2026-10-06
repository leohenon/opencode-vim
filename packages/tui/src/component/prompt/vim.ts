import { createEffect, onCleanup, type Accessor } from "solid-js"
import type { TextareaRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { useClipboard } from "../../context/clipboard"
import { useSync } from "../../context/sync"
import { useDialog } from "../../ui/dialog"
import { useToast } from "../../ui/toast"
import { useTuiConfig } from "../../config"
import { OPENCODE_COPY_MODE, OPENCODE_VIM_MODE_KEY, useOpencodeKeymap, useOpencodeModeStack } from "../../keymap"
import { useVimEnabled } from "../vim"
import { createVimState, type VimMode, type VimRegister, type VimSnapshot } from "../vim/vim-state"
import { createVimHandler, vimLangmapKeyName } from "../vim/vim-handler"
import { clearSelection } from "../vim/vim-motions"
import { useVimIndicator } from "../vim/vim-indicator"
import type { CopyModeAdapter } from "../vim/copy-adapter"

let lastVimMode: VimMode | undefined

// Fork-owned prompt wiring kept out of the upstream prompt component.
export function usePromptVim(opts: {
  textarea: () => TextareaRenderable
  inputTarget: Accessor<TextareaRenderable | undefined>
  mode: () => "normal" | "shell"
  copy: () => CopyModeAdapter | undefined
  disabled: () => boolean | undefined
  copyDuringModal: () => boolean | undefined
  sessionID: () => string | undefined
  submit: () => void
  autocomplete: () => false | "@" | "/"
  snapshot: () => VimSnapshot
  snapshotDataEqual: (before: unknown, after: unknown) => boolean
  restore: (next: VimSnapshot) => void
}) {
  const clipboard = useClipboard()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const cfg = useTuiConfig()
  const keymap = useOpencodeKeymap()
  const modeStack = useOpencodeModeStack()
  const renderer = useRenderer()
  const vimEnabled = useVimEnabled()

  const vimState = createVimState({
    enabled: vimEnabled,
    initial: () => lastVimMode ?? cfg.vim_initial_mode ?? "insert",
  })
  let popCopyMode: (() => void) | undefined
  onCleanup(() => {
    popCopyMode?.()
    keymap.setData(OPENCODE_VIM_MODE_KEY, undefined)
    if (vimEnabled()) lastVimMode = vimState.isCopy() ? "normal" : vimState.mode()
    vimState.cancelEdit()
  })

  createEffect(() => {
    keymap.setData(OPENCODE_VIM_MODE_KEY, vimEnabled() && opts.mode() === "normal" ? vimState.mode() : "insert")
  })

  createEffect(() => {
    if (vimState.isCopy()) {
      if (!popCopyMode) popCopyMode = modeStack.push(OPENCODE_COPY_MODE)
      return
    }
    popCopyMode?.()
    popCopyMode = undefined
  })

  const vimIndicator = useVimIndicator({
    enabled: vimEnabled,
    active: () => opts.mode() === "normal",
    state: vimState,
    copyVisual: () => opts.copy()?.visualMode(),
    copySearch: () => opts.copy()?.searchDisplay(),
  })
  let flash = 0
  let flashSpan: { start: number; end: number } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let clipboardRegister: VimRegister = null
  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })

  function useSystemClipboardRegister() {
    return !!cfg.vim_system_clipboard_register
  }

  function promptActive() {
    const input = opts.textarea()
    if (!input || input.isDestroyed) return false
    return input.plainText.length > 0
  }

  function enterCopyMode() {
    const copy = opts.copy()
    if (!vimEnabled() || !copy) return false
    if (vimState.isInsert()) vim.finishInsertEdit()
    vimState.setMode("copy")
    copy.enter()
    const input = opts.textarea()
    if (input && !input.isDestroyed && !input.focused) input.focus()
    dialog.clear()
    return true
  }

  function exitCopyMode(scrollToBottom?: boolean) {
    const copy = opts.copy()
    if (!copy) return false
    vimState.setMode("normal")
    copy.exit(scrollToBottom)
    dialog.clear()
    return true
  }

  function copyEligible() {
    return (
      opts.inputTarget() !== undefined &&
      vimEnabled() &&
      opts.mode() === "normal" &&
      (!opts.disabled() || opts.copyDuringModal())
    )
  }

  function handleNavigation(action: "up" | "down") {
    if (!opts.copy()) return
    if (action === "up" && !vimState.isCopy()) {
      keymap.dispatchCommand("session.copy_mode")
    }
    if (action === "down" && vimState.isCopy()) {
      const skipExit = vimState.skipExitOnModeChange()
      const scrollToBottom = vimState.exitScrollToBottom()
      vimState.setSkipExitOnModeChange(false)
      vimState.setExitScrollToBottom(true)
      if (!skipExit) {
        exitCopyMode(scrollToBottom)
        return
      }
      vimState.setMode("normal")
    }
  }

  function promptSelectionText() {
    const input = opts.textarea()
    if (!input || input.isDestroyed) return
    const text = input.editorView.getSelectedText()
    if (!text) return
    return text
  }

  async function copyPromptSelection() {
    const text = promptSelectionText()
    if (!text) return false
    return Promise.resolve(clipboard.write?.(text))
      .then(() => {
        toast.show({ message: "Copied to clipboard", variant: "info" })
        return true
      })
      .catch((error: unknown) => {
        toast.error(error)
        return false
      })
  }

  async function setVimRegister(register: VimRegister, notify = false) {
    if (!useSystemClipboardRegister()) {
      vimState.setRegister(register)
      return
    }
    clipboardRegister = register
    if (!register) return

    await Promise.resolve(clipboard.write?.(register.text))
      .then(() => {
        if (notify) toast.show({ message: "Copied to clipboard", variant: "info" })
      })
      .catch(toast.error)
  }

  async function syncVimRegisterFromClipboard() {
    if (!useSystemClipboardRegister()) return
    const content = await (clipboard.read?.() ?? Promise.resolve(undefined)).catch(() => undefined)
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
    if (vimState.isInsert() || vimState.isReplace() || vimState.isCopy()) return false
    if (["r", "vr", "f", "F", "t", "T"].includes(vimState.pending())) return false
    const key = vimLangmapKeyName(event)
    if (key.length !== 1) return false
    const mapped =
      cfg.vim_langmap?.[key] ?? (event.shift ? cfg.vim_langmap?.[key.toLowerCase()]?.toUpperCase() : undefined) ?? key
    return mapped.toLowerCase() === "p"
  }

  function promptJump(action: "top" | "bottom" | "high" | "middle" | "low") {
    const input = opts.textarea()
    if (!input || input.isDestroyed) return
    if (action === "top") {
      input.gotoBufferHome()
      return
    }
    if (action === "bottom") {
      input.gotoBufferEnd()
      return
    }

    const row =
      action === "high" ? 0 : action === "middle" ? Math.max(0, Math.floor((input.height - 1) / 2)) : input.height - 1

    let prev = -1
    while (input.visualCursor.visualRow > row && input.cursorOffset !== prev) {
      prev = input.cursorOffset
      input.moveCursorUp()
    }

    prev = -1
    while (input.visualCursor.visualRow < row && input.cursorOffset !== prev) {
      prev = input.cursorOffset
      input.moveCursorDown()
    }
  }

  const vim = createVimHandler({
    enabled: vimEnabled,
    state: vimState,
    textarea: opts.textarea,
    register: () => (useSystemClipboardRegister() ? clipboardRegister : vimState.register()),
    setRegister: setVimRegister,
    pasteOverSelection() {
      const sel = opts.textarea().editorView.getSelection()
      if (!sel) return false
      return !flashSpan || sel.start !== flashSpan.start || sel.end !== flashSpan.end
    },
    langmap: () => cfg.vim_langmap,
    vimLineMotions: () => cfg.vim_line_motions,
    vimEscapeSequence: cfg.vim_escape_sequence,
    submit: opts.submit,
    commandPalette() {
      keymap.dispatchCommand("command.palette.show")
    },
    scroll(action) {
      if (action === "line-down") keymap.dispatchCommand("session.line.down")
      if (action === "line-up") keymap.dispatchCommand("session.line.up")
      if (action === "half-down") keymap.dispatchCommand("session.half.page.down")
      if (action === "half-up") keymap.dispatchCommand("session.half.page.up")
      if (action === "page-down") keymap.dispatchCommand("session.page.down")
      if (action === "page-up") keymap.dispatchCommand("session.page.up")
    },
    jump(action) {
      if (action === "high" || action === "middle" || action === "low") {
        promptJump(action)
        return
      }
      if (promptActive()) {
        promptJump(action)
        return
      }
      if (action === "top") keymap.dispatchCommand("session.first")
      if (action === "bottom") keymap.dispatchCommand("session.last")
    },
    navigate(action) {
      handleNavigation(action)
    },
    copy(action) {
      opts.copy()?.move(action)
    },
    copyHalfPage(direction) {
      opts.copy()?.halfPage(direction)
    },
    copyVisual(mode) {
      opts.copy()?.visual(mode)
    },
    copyExitVisual() {
      opts.copy()?.exitVisual()
    },
    copyExit(scrollToBottom) {
      exitCopyMode(scrollToBottom)
    },
    copyExitPreserveScroll() {
      opts.copy()?.exitPreserveScroll()
      vimState.setMode("normal")
    },
    copyFocusInput() {
      opts.copy()?.focusInput()
    },
    copyYank() {
      const reg = opts.copy()?.yank()
      if (reg) setVimRegister(reg, true)
    },
    copyYankLine() {
      const reg = opts.copy()?.yankLine()
      if (reg) setVimRegister(reg, true)
    },
    copyYankMatchingBracket() {
      const reg = opts.copy()?.yankMatchingBracket()
      if (!reg) return false
      setVimRegister(reg, true)
      return true
    },
    copyToggleVisualEnd() {
      opts.copy()?.copyToggleVisualEnd()
      return true
    },
    copyCopy() {
      return opts.copy()?.copy()
    },
    copyToggleCollapsed() {
      return opts.copy()?.toggleCollapsed() ?? false
    },
    copyActivate() {
      return opts.copy()?.activate() ?? false
    },
    copyIsVisual() {
      return opts.copy()?.isVisual() ?? false
    },
    copyJump(action) {
      opts.copy()?.jump(action)
    },
    copyWordNext(big) {
      return opts.copy()?.wordNext(big) ?? false
    },
    copyWordPrev(big) {
      return opts.copy()?.wordPrev(big) ?? false
    },
    copyWordEnd(big) {
      return opts.copy()?.wordEnd(big) ?? false
    },
    copyMatchingBracket() {
      return opts.copy()?.matchingBracket() ?? false
    },
    copyNextParagraph() {
      return opts.copy()?.nextParagraph() ?? false
    },
    copyPreviousParagraph() {
      return opts.copy()?.previousParagraph() ?? false
    },
    copySearchStart(direction) {
      const copy = opts.copy()
      if (!copy) return false
      const sessionID = opts.sessionID()
      if (!sessionID || !sync.data.message[sessionID]?.length) return false
      if (!vimState.isCopy()) {
        vimState.setMode("copy")
        copy.enter()
      }
      copy.searchStart(direction)
    },
    copySearchAppend(value) {
      return opts.copy()?.searchAppend(value) ?? false
    },
    copySearchBackspace() {
      return opts.copy()?.searchBackspace() ?? false
    },
    copySearchSubmit() {
      return opts.copy()?.searchSubmit() ?? true
    },
    copySearchCancel() {
      opts.copy()?.searchCancel()
    },
    copySearchClear() {
      return opts.copy()?.searchClear() ?? false
    },
    copySearchActive() {
      return opts.copy()?.searchActive() ?? false
    },
    copySearchHighlighted() {
      return opts.copy()?.searchHighlighted() ?? false
    },
    copySearchNext() {
      return opts.copy()?.searchNext() ?? false
    },
    copySearchPrevious() {
      return opts.copy()?.searchPrevious() ?? false
    },
    copyText() {
      return opts.copy()?.text() ?? ""
    },
    copyCol() {
      return opts.copy()?.col() ?? 0
    },
    setCopyCol(offset: number) {
      opts.copy()?.setCol(offset)
    },
    setCopyStick(stick: "start" | "first" | "end") {
      opts.copy()?.setStick(stick)
    },
    copyScroll(action: "center" | "top" | "bottom") {
      opts.copy()?.scroll(action)
    },
    autocomplete: opts.autocomplete,
    history: () => true,
    snapshot: opts.snapshot,
    snapshotDataEqual: opts.snapshotDataEqual,
    restore: opts.restore,
    flash(span) {
      const input = opts.textarea()
      flash++
      flashSpan = span
      const id = flash
      const cur = input.cursorOffset
      input.editorView.setSelection(span.start, span.end)
      input.cursorOffset = cur
      input.getLayoutNode().markDirty()
      renderer.requestRender()
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const input = opts.textarea()
        if (!input || input.isDestroyed) return
        if (id !== flash) return
        if (vimState.isVisual()) {
          flashSpan = undefined
          return
        }
        const sel = input.editorView.getSelection()
        if (!sel) {
          flashSpan = undefined
          return
        }
        if (sel.start !== span.start || sel.end !== span.end) {
          flashSpan = undefined
          return
        }
        flashSpan = undefined
        clearSelection(input)
        input.getLayoutNode().markDirty()
        renderer.requestRender()
      }, 70)
    },
  })

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
