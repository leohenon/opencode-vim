import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "./dialog"
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { Spinner } from "../component/spinner"
import { useTuiConfig } from "../config"
import { OPENCODE_VIM_MODE_KEY, useBindings, useCommandShortcut, useOpencodeKeymap } from "../keymap"
import { useVimEnabled } from "../component/vim"
import {
  createModalInputControls,
  type ModalInputKeyEvent,
  type ModalInputMode,
} from "../component/vim/modal-input-controls"
import { vimCursorStyle } from "../component/vim/cursor-style"

export type DialogPromptProps = {
  title: string
  description?: () => JSX.Element
  placeholder?: string
  value?: string
  busy?: boolean
  busyText?: string
  onConfirm?: (value: string) => void
  onCancel?: () => void
}

export function DialogPrompt(props: DialogPromptProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const keymap = useOpencodeKeymap()
  const vimEnabled = useVimEnabled()
  const previousVimMode = keymap.getData(OPENCODE_VIM_MODE_KEY)
  const submitShortcut = useCommandShortcut("dialog.prompt.submit")
  const [textareaTarget, setTextareaTarget] = createSignal<TextareaRenderable>()
  const [inputMode, setInputMode] = createSignal<ModalInputMode>("insert")
  const modalInputEnabled = createMemo(() => vimEnabled() && tuiConfig.vim_modal_input)
  let textarea: TextareaRenderable

  createEffect(() => {
    keymap.setData(OPENCODE_VIM_MODE_KEY, modalInputEnabled() ? inputMode() : undefined)
  })

  onCleanup(() => {
    keymap.setData(OPENCODE_VIM_MODE_KEY, previousVimMode)
  })

  const modalInput = createModalInputControls({
    mode: inputMode,
    setMode: setInputMode,
    focus: () => textarea?.focus(),
    text: () => textarea?.plainText ?? "",
    cursor: () => textarea?.cursorOffset ?? 0,
    setCursor: (offset) => {
      if (!textarea || textarea.isDestroyed) return
      textarea.cursorOffset = offset
    },
    setText: (text) => {
      if (!textarea || textarea.isDestroyed) return
      textarea.setText(text)
    },
    langmap: () => tuiConfig.vim_langmap,
    vimEscapeSequence: () => tuiConfig.vim_escape_sequence,
  })

  const cursorStyle = createMemo(() => vimCursorStyle(modalInputEnabled() ? inputMode() : undefined, tuiConfig.cursor))

  createEffect(() => {
    if (!textarea || textarea.isDestroyed) return
    textarea.cursorStyle = cursorStyle()
  })

  function enterNormalMode() {
    modalInput.clearPending()
    modalInput.enterNormal()
  }

  function confirm() {
    if (props.busy) return
    modalInput.clearPending()
    props.onConfirm?.(textarea.plainText)
  }

  useBindings(() => ({
    target: textareaTarget,
    enabled: textareaTarget() !== undefined && !props.busy,
    // Dialog form semantics must win over the global managed textarea input layer.
    priority: 1,
    commands: [
      {
        name: "dialog.prompt.submit",
        title: "Submit dialog prompt",
        category: "Dialog",
        run: confirm,
      },
    ],
    bindings: [
      ...tuiConfig.keybinds.gather("dialog.prompt", ["dialog.prompt.submit"]),
      ...(modalInputEnabled() && inputMode() === "insert"
        ? [
            {
              key: "escape",
              desc: "Enter normal mode",
              group: "Dialog",
              cmd: enterNormalMode,
            },
          ]
        : []),
    ],
  }))

  onMount(() => {
    dialog.setSize("medium")
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return
      if (props.busy) return
      textarea.focus()
    }, 1)
    textarea.gotoLineEnd()
  })

  createEffect(() => {
    if (!textarea || textarea.isDestroyed) return
    const traits = props.busy
      ? {
          suspend: true,
          status: "BUSY",
        }
      : {}
    textarea.traits = traits
    if (props.busy) {
      textarea.blur()
      return
    }
    textarea.focus()
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={1}>
        {props.description?.()}
        <textarea
          height={3}
          ref={(val: TextareaRenderable) => {
            textarea = val
            setTextareaTarget(val)
          }}
          initialValue={props.value}
          placeholder={props.placeholder ?? "Enter text"}
          placeholderColor={theme.textMuted}
          textColor={props.busy ? theme.textMuted : theme.text}
          focusedTextColor={props.busy ? theme.textMuted : theme.text}
          cursorColor={props.busy ? theme.backgroundElement : theme.primary}
          cursorStyle={cursorStyle()}
          onKeyDown={(event: ModalInputKeyEvent) => {
            if (modalInputEnabled() && !props.busy && modalInput.handleKey(event)) return
          }}
        />
        <Show when={props.busy}>
          <Spinner color={theme.textMuted}>{props.busyText ?? "Working…"}</Spinner>
        </Show>
      </box>
      <box paddingBottom={1} gap={1} flexDirection="row">
        <Show when={!props.busy} fallback={<text fg={theme.textMuted}>processing…</text>}>
          <Show when={submitShortcut()}>
            <text fg={theme.text}>
              {submitShortcut()} <span style={{ fg: theme.textMuted }}>submit</span>
            </text>
          </Show>
        </Show>
      </box>
    </box>
  )
}

DialogPrompt.show = (dialog: DialogContext, title: string, options?: Omit<DialogPromptProps, "title">) => {
  return new Promise<string | null>((resolve) => {
    dialog.replace(
      () => (
        <DialogPrompt title={title} {...options} onConfirm={(value) => resolve(value)} onCancel={() => resolve(null)} />
      ),
      () => resolve(null),
    )
  })
}
