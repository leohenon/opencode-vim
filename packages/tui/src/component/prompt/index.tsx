import {
  BoxRenderable,
  RGBA,
  TextareaRenderable,
  MouseEvent,
  PasteEvent,
  TextAttributes,
  decodePasteBytes,
  measureEditText,
  stripAnsiSequences,
  type KeyEvent,
  type OptimizedBuffer,
} from "@opentui/core"
import { batch, createEffect, createMemo, onMount, createSignal, onCleanup, on, Show, Switch, Match, For, untrack } from "solid-js"
import path from "path"
import { useLocal } from "../../context/local"
import { useTheme, useThemes } from "../../context/theme"
import { tint } from "../../theme/color"
import { createAnimatable, tween } from "../../ui/animation"
import { EmptyBorder, SplitBorder } from "../../ui/border"
import { useTuiPaths, useTuiTerminalEnvironment } from "../../context/runtime"
import { useClipboard } from "../../context/clipboard"
import { Spinner } from "../spinner"
import { useClient } from "../../context/client"
import { useRoute } from "../../context/route"
import { usePromptRef } from "../../context/prompt"
import { useSessionTabs } from "../../context/session-tabs"
import { useEvent } from "../../context/event"
import { editorSelectionKey, useEditorContext, type EditorSelection } from "../../context/editor"
import { normalizePromptContent, openEditor } from "../../editor"
import { useExit } from "../../context/exit"
import { expandPromptInputPastedText, realignPromptInputMentions } from "../../prompt/mention"
import { parseSlashHead } from "../../prompt/parse"
import { createStore, produce, unwrap } from "solid-js/store"
import { emptyPrompt, usePromptHistory, type PromptInfo, type PromptPartRef } from "../../prompt/history"
import { saveDraft, takeDraft } from "./draft-stash"
import { Skill } from "@opencode/schema/skill"
import { computePromptTraits } from "../../prompt/traits"
import { expandPastedTextPlaceholders, expandTrackedPastedText } from "../../prompt/part"
import { usePromptStash } from "../../prompt/stash"
import { DialogStash } from "../dialog-stash"
import { type AutocompleteOption, type AutocompleteRef, Autocomplete } from "./autocomplete"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { Locale } from "../../util/locale"
import { errorMessage } from "../../util/error"
import { createColors, createFrames } from "../../ui/spinner"
import { useDialog } from "../../ui/dialog"
import { DialogIntegration } from "../dialog-integration"
import { useConnected } from "../use-connected"
import { useToast } from "../../ui/toast"
import { createFadeIn } from "../../util/signal"
import { DialogSkill } from "../dialog-skill"
import { useConfig } from "../../config"
import { usePromptMove } from "./move"
import { resolvePastedAttachments } from "./local-attachment"
import { locationKey, useData } from "../../context/data"
import { useLocation } from "../../context/location"
import { useArgs } from "../../context/args"
import { Keymap, type KeymapCommand } from "../../context/keymap"
import { useInteractivity } from "../../context/interactivity"
import { abbreviateHome } from "../../runtime"
import { Slot } from "../../plugin/render"
import type { SessionInbox } from "@opencode/schema/session-inbox"
import {
  deduplicatePromptImages,
  preserveMentionlessPromptAttachments,
  promptAttachmentLabel,
} from "../../prompt/attachment"
import { DialogImagePreview } from "../dialog-image-preview"
import { useDirectoryRecents } from "../../prompt/directory-recents"
import { directoryRecentValue } from "../../prompt/directory-completion"
import { useWorkingDirectoryActions } from "../../ui/working-directory-actions"
import { truncateFilePath } from "../../ui/file-path"
import { PromptMetadataRow } from "./metadata"
import { useVimEnabled } from "../vim"
import { vimCursorStyle } from "../vim/cursor-style"
import { clearSelection } from "../vim/vim-motions"
import { usePromptVim } from "./vim"
import type { CopyModeAdapter } from "../vim/copy-adapter"
import { drawShowbreak } from "./showbreak"
import { emptyRows } from "./empty-selection"
import { promptSnapshotDataEqual } from "./snapshot"
import { useMinimalUI } from "../../context/ui-state"

export type PromptProps = {
  sessionID?: string
  visible?: boolean
  disabled?: boolean
  muted?: boolean
  copy?: CopyModeAdapter
  onSubmit?: () => void
  onEmptySubmit?: () => boolean | Promise<boolean>
  ref?: (ref: PromptRef | undefined) => void
  placeholders?: {
    normal?: string[]
    shell?: string[]
  }
}

export type PromptRef = {
  focused: boolean
  current: PromptInfo
  mode: "normal" | "shell"
  setMode(mode: "normal" | "shell"): void
  set(prompt: PromptInfo): void
  reset(): void
  blur(): void
  focus(): void
  submit(): void
  enterCopyMode(): boolean
}

const DRAFT_RETENTION_MIN_CHARS = 20
const revealedPromptMetadata = new WeakSet<object>()

function randomIndex(count: number) {
  if (count <= 0) return 0
  return Math.floor(Math.random() * count)
}

export function PromptInterruptStatus(props: {
  armed: boolean
  animations?: boolean
  text: RGBA
  subdued: RGBA
  warning: RGBA
  flash?: RGBA
}) {
  const ignition = createAnimatable(
    { level: 0 },
    { enabled: () => props.animations ?? false, transition: tween({ duration: 0.22 }) },
  )
  createEffect(
    on(
      () => props.armed,
      (armed) => {
        if (!armed || !props.animations) return ignition.jump({ level: 0 })
        ignition.jump({ level: 0.75 })
        ignition.animate({ level: 0 })
      },
      { defer: true },
    ),
  )
  const armedColor = createMemo(() => {
    const level = ignition.value().level
    if (level === 0 || !props.flash) return props.warning
    return tint(props.warning, props.flash, level)
  })

  return (
    <text fg={props.armed ? armedColor() : props.text} wrapMode="none" truncate flexShrink={1}>
      esc{" "}
      <span style={{ fg: props.armed ? armedColor() : props.subdued }}>
        {props.armed ? "again to interrupt" : "interrupt"}
      </span>
    </text>
  )
}

function hasEditorRangeSelection(selection: EditorSelection["ranges"][number]) {
  return (
    selection.selection.start.line !== selection.selection.end.line ||
    selection.selection.start.character !== selection.selection.end.character
  )
}

function getEditorRangeLabel(selection: EditorSelection["ranges"][number]) {
  if (!hasEditorRangeSelection(selection)) return
  if (selection.selection.start.line === selection.selection.end.line) return `#${selection.selection.start.line}`
  return `#${selection.selection.start.line}-${selection.selection.end.line}`
}

function formatEditorContext(selection: EditorSelection) {
  const selected = selection.ranges.filter(hasEditorRangeSelection)
  if (selected.length === 0)
    return `<system-reminder>Note: The user opened the file "${selection.filePath}". This may or may not be relevant to the current task.</system-reminder>\n`

  const ranges = selected.map((range, index) => {
    const prefix = selected.length > 1 ? `Selection ${index + 1}: ` : ""
    return `Note: The user selected ${prefix}${getEditorRangeLabel(range)} from "${selection.filePath}". \`\`\`${range.text}\`\`\`\n\n`
  })

  return `<system-reminder>${ranges.join("\n")} This may or may not be relevant to the current task.</system-reminder>\n`
}

function argumentSlash(input: string, commands: readonly KeymapCommand[]) {
  const head = parseSlashHead(input, /\s/)
  if (!head) return
  const command = commands.find(
    (command) =>
      command.slash?.arguments &&
      (command.slash.name === head.name || command.slash.aliases?.includes(head.name) === true),
  )
  if (!command) return
  return { command, input: head.arguments }
}

export function Prompt(props: PromptProps) {
  let input: TextareaRenderable
  let anchor: BoxRenderable
  const [inputTarget, setInputTarget] = createSignal<TextareaRenderable | undefined>()

  const enabled = useInteractivity()
  const disabled = () => props.disabled || !enabled()
  const leader = Keymap.useLeaderActive()
  const muted = () => leader() || props.muted
  const local = useLocal()
  const paths = useTuiPaths()
  const terminalEnvironment = useTuiTerminalEnvironment()
  const clipboard = useClipboard()
  const client = useClient()
  const editor = useEditorContext()
  const route = useRoute()
  const promptRef = usePromptRef()
  const sessionTabs = useSessionTabs()
  const data = useData()
  const directoryRecents = useDirectoryRecents()
  const keymapCommands = Keymap.useCommands()
  const currentLocation = useLocation()
  const args = useArgs()
  const config = useConfig().data
  const vimEnabled = useVimEnabled()
  const minimal = useMinimalUI()
  const dialog = useDialog()
  const toast = useToast()
  const status = createMemo(() => data.session.status(props.sessionID ?? ""))
  const history = usePromptHistory()
  const stash = usePromptStash()
  const keymap = Keymap.use()
  const renderer = useRenderer()
  const measure = (text: string) => measureEditText(text, { widthMethod: renderer.widthMethod })
  const exit = useExit()
  const dimensions = useTerminalDimensions()
  const theme = useTheme()
  const { currentSyntax: syntax } = useThemes()
  const animationsEnabled = createMemo(() => config.animations ?? true)
  const list = createMemo(() => props.placeholders?.normal ?? [])
  const shell = createMemo(() => props.placeholders?.shell ?? [])
  const fileContextEnabled = createMemo(() => config.prompt?.editor ?? true)
  const [dismissedEditorSelectionKey, setDismissedEditorSelectionKey] = createSignal<string>()
  const editorContext = createMemo(() => {
    const selection = fileContextEnabled() ? editor.selection() : undefined
    if (!selection) return
    return editorSelectionKey(selection) === dismissedEditorSelectionKey() ? undefined : selection
  })
  const editorPath = createMemo(() => editorContext()?.filePath)
  const editorSelectionLabel = createMemo(() => {
    const ranges = editorContext()?.ranges
    if (!ranges) return
    const first = ranges.find(hasEditorRangeSelection) ?? ranges[0]
    if (!first) return
    return [getEditorRangeLabel(first), ranges.length > 1 ? `+${ranges.length - 1}` : undefined]
      .filter(Boolean)
      .join(" ")
  })
  const editorFileLabel = createMemo(() => {
    const value = editorPath()
    if (!value) return
    const filename = path.basename(value)
    const file = /^index\.[^./]+$/.test(filename)
      ? [path.basename(path.dirname(value)), filename].filter(Boolean).join("/")
      : filename
    return `${file.split(path.sep).join("/")}${editorSelectionLabel() ?? ""}`
  })
  const editorFileLabelDisplay = createMemo(() => {
    const file = editorFileLabel()
    if (!file) return
    return Locale.truncateMiddle(file, Math.max(12, Math.min(48, Math.floor(dimensions().width / 3))))
  })
  const editorContextLabelState = createMemo(() => editor.labelState())
  const [auto, setAuto] = createSignal<AutocompleteRef>()
  const move = usePromptMove({
    projectID: () =>
      (props.sessionID ? data.session.get(props.sessionID)?.projectID : undefined) ?? data.location.info()?.project.id,
    sessionID: () => props.sessionID,
  })
  const [pendingDirectory, setPendingDirectory] = createSignal<string>()
  Keymap.createLayer(() => ({
    mode: "global",
    enabled: !disabled(),
    commands: [
      {
        id: "session.cd",
        title: "Change working directory",
        slash: { name: "cd", arguments: true },
        run: async (input) => {
          if (!input?.trim()) {
            toast.show({ message: "Directory is required", variant: "error" })
            return
          }
          const sessionID = props.sessionID
          const session = sessionID ? data.session.get(sessionID) : undefined
          const sourceProjectID = session?.projectID ?? data.location.info()?.project.id
          const value = input.trim()
          const expanded =
            value === "~" ? paths.home : value.startsWith("~/") ? path.join(paths.home, value.slice(2)) : value
          const directory = path.resolve(
            session?.location.directory ?? currentLocation.current?.directory ?? data.location.default().directory,
            expanded,
          )
          if (!sessionID) {
            setPendingDirectory(directory)
            const location = await client.api.location.get({ location: { directory } }).catch((error) => {
              toast.show({ title: "Failed to change directory", message: errorMessage(error), variant: "error" })
              return undefined
            })
            if (!location) {
              setPendingDirectory(undefined)
              return
            }
            if (sourceProjectID) directoryRecents.touch(sourceProjectID, location.directory)
            currentLocation.set(location)
            setPendingDirectory(undefined)
            return
          }
          const error = await client.api.session.move({ sessionID, directory: input }).then(
            () => undefined,
            (error) => error,
          )
          if (error) {
            toast.show({ title: "Failed to change directory", message: errorMessage(error), variant: "error" })
            return
          }
          if (sourceProjectID) directoryRecents.touch(sourceProjectID, directory)
        },
      },
    ],
  }))
  const [cursorVersion, setCursorVersion] = createSignal(0)
  const connected = useConnected()

  function promptModelWarning() {
    toast.show({
      variant: "warning",
      message: "Connect an integration to send prompts",
      duration: 3000,
    })
    if (!connected()) {
      dialog.replace(() => <DialogIntegration />)
    }
  }

  function dismissEditorContext() {
    setDismissedEditorSelectionKey(editorSelectionKey(editorContext()))
    editor.clearSelection()
  }
  const fileStyleId = syntax().getStyleId("extmark.file")!
  const agentStyleId = syntax().getStyleId("extmark.agent")!
  const skillStyleId = syntax().getStyleId("extmark.skill")!
  const pasteStyleId = syntax().getStyleId("extmark.paste")!
  let promptPartTypeId = 0
  const event = useEvent()

  event.on("tui.prompt.append", (evt, { directory }) => {
    if (directory !== (currentLocation.current?.directory ?? data.location.default().directory)) return
    if (!input || input.isDestroyed || vimState.isCopy()) return
    input.insertText(evt.data.text)
    setTimeout(() => {
      // setTimeout is a workaround and needs to be addressed properly
      if (!input || input.isDestroyed) return
      input.invalidateIntrinsicSize()
      input.gotoBufferEnd()
      renderer.requestRender()
    }, 0)
  })

  const [store, setStore] = createStore<{
    prompt: PromptInfo
    mode: "normal" | "shell"
    extmarkToPart: Map<number, PromptPartRef>
    interrupt: number
    placeholder: number
  }>({
    placeholder: randomIndex(list().length),
    prompt: emptyPrompt(),
    mode: "normal",
    extmarkToPart: new Map(),
    interrupt: 0,
  })

  const {
    vim,
    vimState,
    vimIndicator,
    enterCopyMode,
    copyEligible,
    promptSelectionText,
    copyPromptSelection,
    shouldSyncVimRegister,
    syncVimRegisterFromClipboard,
  } = usePromptVim({
    textarea: () => input,
    mode: () => store.mode,
    copy: () => props.copy,
    disabled,
    submit: () => void submit(),
    autocomplete: () => {
      const visible = auto()?.visible
      if (visible === "reference") return "@"
      if (visible === "command") return "/"
      return false
    },
    snapshot: promptSnapshot,
    snapshotDataEqual: promptSnapshotDataEqual,
    restore(next) {
      const prompt = next.data as PromptInfo | undefined
      input.setText(next.text)
      input.cursorOffset = Math.max(0, Math.min(next.cursor, next.text.length))
      setStore("prompt", prompt ? { ...prompt, text: next.text } : { ...emptyPrompt(), text: next.text })
      restoreExtmarksFromPrompt(store.prompt)
    },
  })

  createEffect((active: boolean | undefined) => {
    const next = props.copy?.active() ?? false
    if (active && !next && vimState.isCopy()) vimState.setMode("normal")
    return next
  })

  function cursorStyle() {
    if (!vimEnabled() || store.mode !== "normal") return vimCursorStyle(undefined, config.cursor)
    if (vimState.isInsert()) return vimCursorStyle("insert", config.cursor)
    if (vimState.isReplace()) return vimCursorStyle("replace", config.cursor)
    return vimCursorStyle("normal", config.cursor)
  }

  createEffect(() => {
    if (!input || input.isDestroyed) return
    input.cursorColor = disabled() || vimState.isCopy() ? theme.background.raised.base : theme.text.base
    input.cursorStyle = cursorStyle()
    const block = vimEnabled() && store.mode === "normal" && vimState.mode() === "normal"
    input.showCursor = !disabled() && !vimState.isVisual() && !vimState.isCopy() && !block
    input.selectionBg = vimState.isVisual() ? theme.background.selection.base : undefined
    input.selectionFg = vimState.isVisual() ? theme.text.selection.base : undefined
  })

  const renderPromptDecorations = (buffer: OptimizedBuffer) => {
    if (!input || input.isDestroyed || props.visible === false || dialog.stack.length > 0) return
    drawShowbreak(buffer, input, config.vim_showbreak, theme.text.muted, promptBg())
    if (disabled() || !input.focused) return
    const visual = vimState.isVisual()
    const selectionBg = input.selectionBg ?? input.textColor
    const selectionFg = input.selectionFg ?? promptBg()
    if (visual) {
      emptyRows(input.plainText, input.editorView.getSelection(), input.lineInfo, input.scrollY, input.height).forEach((row) => {
        buffer.setCell(input.x, input.y + row, " ", selectionFg, selectionBg)
      })
    }
    const block = vimEnabled() && store.mode === "normal" && vimState.mode() === "normal"
    const cursor = input.visualCursor
    if (!(visual || block)) return
    if (cursor.visualRow < 0 || cursor.visualRow >= input.height) return
    if (cursor.visualCol < 0 || cursor.visualCol >= input.width) return
    const x = input.x + cursor.visualCol
    const y = input.y + cursor.visualRow
    buffer.withBuffers((cells) => {
      if (x < 0 || y < 0 || x >= cells.width || y >= cells.height) return
      const offset = (y * cells.width + x) * 4
      cells.fg.set(promptBg().buffer.subarray(0, 4), offset)
      cells.bg.set(theme.text.base.buffer.subarray(0, 4), offset)
    })
  }
  renderer.addPostProcessFn(renderPromptDecorations)
  onCleanup(() => renderer.removePostProcessFn(renderPromptDecorations))

  function resetVimHistory() {
    vimState.resetHistory()
    if (vimEnabled() && store.mode === "normal" && vimState.isInsert()) vim.beginInsertEdit()
  }

  createEffect<boolean>((previous) => {
    const enabled = vimEnabled()
    if (enabled && previous === false) resetVimHistory()
    return enabled
  }, vimEnabled())

  createEffect<"normal" | "shell">((previous) => {
    const mode = store.mode
    if (mode !== previous) resetVimHistory()
    return mode
  }, store.mode)

  let disposed = false
  let pasteQueue = Promise.resolve()

  function enqueuePaste(run: (changed: () => boolean) => Promise<void>) {
    pasteQueue = pasteQueue
      .then(async () => {
        if (disposed || input.isDestroyed || disabled()) return
        const before = { sessionID: props.sessionID, mode: store.mode, text: input.plainText }
        await run(
          () =>
            disposed ||
            input.isDestroyed ||
            disabled() ||
            props.sessionID !== before.sessionID ||
            store.mode !== before.mode ||
            input.plainText !== before.text,
        )
      })
      .catch((error) => {
        if (!disposed) toast.error(error)
      })
    return pasteQueue
  }

  const imageAttachments = createMemo(() =>
    (deduplicatePromptImages(store.prompt.files) ?? []).filter((file) => file.uri.startsWith("data:image/")),
  )
  const imagePreviewHeight = createMemo(() => Math.max(4, Math.min(8, Math.floor(dimensions().height / 4))))
  const imagePreviewWidth = createMemo(() => imagePreviewHeight() * 2)
  const visibleImageAttachments = createMemo(() => imageAttachments().slice(0, 3))

  function openImagePreview(initial: number) {
    const images = imageAttachments()
    if (images.length === 0) return
    dialog.replace(() => <DialogImagePreview images={images} initial={initial} />)
  }

  createEffect(
    on(
      () => props.sessionID,
      () => {
        setStore("placeholder", randomIndex(list().length))
      },
      { defer: true },
    ),
  )

  const promptCommands = createMemo(() =>
    [
      {
        title: "Clear prompt",
        name: "prompt.clear",
        category: "Prompt",
        palette: undefined,
        run: () => {
          clearPrompt()
          dialog.clear()
        },
      },
      {
        title: "Submit prompt",
        name: "prompt.submit",
        category: "Prompt",
        palette: undefined,
        run: async (_input: string | undefined, event?: KeyEvent) => {
          event?.preventDefault()
          event?.stopPropagation()
          if (!input.focused) return
          const handled = await submit()
          if (!handled) return

          dialog.clear()
        },
      },
      {
        title: "Copy prompt selection",
        name: "prompt.copy_selection",
        category: "Prompt",
        enabled: () => !!promptSelectionText(),
        run: async () => {
          if (!(await copyPromptSelection())) return
          dialog.clear()
        },
      },
      {
        title: "Queue prompt",
        name: "prompt.queue",
        category: "Prompt",
        run: async (_input: string | undefined, event?: KeyEvent) => {
          event?.preventDefault()
          event?.stopPropagation()
          if (!input.focused) return
          if (auto()?.visible && !auto()?.completeQueueableCommand()) return
          const handled = await submit("queue")
          if (!handled) return
          dialog.clear()
        },
      },
      {
        title: "Remove editor context",
        name: "prompt.editor_context.clear",
        category: "Prompt",
        enabled: Boolean(editorContext()),
        run: () => {
          dismissEditorContext()
          dialog.clear()
        },
      },
      {
        title: "Paste",
        name: "prompt.paste",
        category: "Prompt",
        palette: undefined,
        run: (_input: string | undefined, event?: KeyEvent) => {
          event?.preventDefault()
          event?.stopPropagation()
          return enqueuePaste(async (changed) => {
            const content = await clipboard.read()
            if (changed()) return
            if (content?.mime.startsWith("image/")) {
              pasteAttachment({
                filename: "clipboard",
                uri: `data:${content.mime};base64,${content.data}`,
              })
              return
            }
            if (content?.mime === "text/plain") {
              await pasteInputText(content.data, changed)
            }
          })
        },
      },
      {
        title: "View image attachments",
        name: "prompt.images.view",
        category: "Prompt",
        enabled: imageAttachments().length > 0,
        run: () => openImagePreview(0),
      },
      {
        title: "Interrupt session",
        name: "session.interrupt",
        category: "Session",
        palette: undefined,
        enabled: status() === "running",
        run: () => {
          if (auto()?.visible) return
          if (!input.focused) return
          if (vimEnabled() && store.mode === "normal" && vimState.mode() !== "normal") {
            if (vimState.isVisual()) clearSelection(input)
            vimState.cancelEdit()
            vimState.setMode("normal")
            setStore("interrupt", 0)
            dialog.clear()
            return
          }
          // TODO: this should be its own command
          if (store.mode === "shell") {
            setStore("mode", "normal")
            vimState.clearPending()
            return
          }
          if (!props.sessionID) return

          setStore("interrupt", store.interrupt + 1)

          setTimeout(() => {
            setStore("interrupt", 0)
          }, 5000)

          if (store.interrupt >= 2) {
            void client.api.session.interrupt({
              sessionID: props.sessionID,
              resume: true,
            })
            setStore("interrupt", 0)
          }
          dialog.clear()
        },
      },
      {
        title: "Background blocking tools",
        name: "session.background",
        category: "Session",
        palette: undefined,
        enabled: status() === "running",
        run: () => {
          if (auto()?.visible) return
          if (!input.focused) return
          if (!props.sessionID) return

          void client.api.session.background({
            sessionID: props.sessionID,
          })
          dialog.clear()
        },
      },
      {
        title: "Open editor",
        category: "Session",
        name: "prompt.editor",
        slash: { name: "editor" },
        run: async () => {
          dialog.clear()

          const editorPrompt = expandPromptInputPastedText(store.prompt, store.prompt.pasted, renderer.widthMethod)
          const value = editorPrompt.text
          const content = await openEditor({
            renderer,
            value,
            cwd:
              (data.location.info()?.project.directory === "/" ? undefined : data.location.info()?.project.directory) ||
              data.location.default().directory ||
              paths.cwd,
          }).catch((error) => {
            toast.show({ title: "Failed to open editor", message: errorMessage(error), variant: "error" })
          })
          if (!content) return
          const normalized = normalizePromptContent(content)

          input.setText(normalized)

          setStore("prompt", {
            ...realignPromptInputMentions(normalized, editorPrompt, renderer.widthMethod),
            pasted: [],
          })
          restoreExtmarksFromPrompt(store.prompt)
          input.cursorOffset = measure(normalized)
          resetVimHistory()
        },
      },
      {
        title: "Skills",
        name: "prompt.skills",
        category: "Prompt",
        slash: { name: "skills" },
        run: () => {
          dialog.replace(() => (
            <DialogSkill
              location={currentLocation.ref}
              onSelect={(skill) => {
                if (store.prompt.skills?.some((item) => item.id === skill)) return
                const text = `@${skill}`
                const start = input.cursorOffset
                const end = start + measure(text)
                input.insertText(text + " ")
                const extmarkId = input.extmarks.create({
                  start,
                  end,
                  virtual: true,
                  styleId: skillStyleId,
                  typeId: promptPartTypeId,
                })
                setStore(
                  produce((draft) => {
                    draft.prompt.text = input.plainText
                    const skills = (draft.prompt.skills ??= [])
                    const index = skills.length
                    skills.push({
                      id: Skill.ID.make(skill),
                      mention: { start, end, text },
                    })
                    draft.extmarkToPart.set(extmarkId, { type: "skill", index })
                  }),
                )
              }}
            />
          ))
        },
      },
      {
        title: "Manage workspaces",
        desc: "Manage workspaces",
        name: "session.move",
        category: "Session",
        slash: { name: "worktrees" },
        run: () => {
          move.open()
        },
      },
    ].map(
      ({ name, category, ...command }) =>
        ({
          id: name,
          group: category,
          bind: false,
          palette: true as const,
          ...command,
        }) satisfies KeymapCommand,
    ),
  )

  Keymap.createLayer(() => ({
    mode: "global",
    enabled: !disabled(),
    commands: promptCommands(),
  }))

  Keymap.createLayer(() => ({
    priority: 1,
    enabled: !disabled(),
    bindings: ["prompt.queue"],
  }))

  Keymap.createLayer(() => ({
    target: inputTarget,
    priority: 100,
    enabled:
      inputTarget() !== undefined &&
      !disabled() &&
      vimEnabled() &&
      store.mode === "normal" &&
      vimState.mode() === "normal",
    commands: [
      {
        id: "prompt.vim.redo",
        bind: "ctrl+r",
        title: "Redo",
        group: "Prompt",
        run: (_input, event) => {
          if (!event) return false
          vim.handleKey(event)
        },
      },
    ],
  }))

  Keymap.createLayer(() => ({
    target: inputTarget,
    priority: 200,
    enabled: copyEligible() && vimState.isCopy(),
    commands: ["ctrl+d", "ctrl+u", "ctrl+f", "ctrl+b", "ctrl+e", "ctrl+y"].map((bind) => ({
      id: `prompt.copy.scroll.${bind}`,
      bind,
      title: "Scroll copy mode",
      group: "Copy mode",
      run: (_input: string | undefined, event?: KeyEvent) => {
        if (!event) return false
        vim.handleKey(event)
      },
    })),
  }))

  Keymap.createLayer(() => ({
    enabled: !disabled(),
    bindings: [
      "prompt.submit",
      "prompt.copy_selection",
      "prompt.editor",
      "prompt.editor_context.clear",
      "prompt.images.view",
      "prompt.stash",
      "prompt.stash.pop",
      "prompt.stash.list",
      "prompt.skills",
      "session.interrupt",
      "session.background",
      "session.move",
    ],
  }))

  const ref: PromptRef = {
    get focused() {
      return !disabled() && input.focused
    },
    get current() {
      return store.prompt
    },
    get mode() {
      return store.mode
    },
    focus() {
      if (disabled()) return
      input.focus()
    },
    blur() {
      input.blur()
    },
    setMode(mode) {
      setStore("mode", mode)
    },
    set(prompt) {
      input.setText(prompt.text)
      setStore("prompt", prompt)
      restoreExtmarksFromPrompt(prompt)
      input.gotoBufferEnd()
      resetVimHistory()
    },
    reset() {
      resetComposer()
    },
    submit() {
      void submit()
    },
    enterCopyMode,
  }

  function resetComposer() {
    // An explicit reset supersedes the frozen copy-mode draft.
    if (vimState.isCopy()) {
      props.copy?.exitPreserveScroll()
      vimState.setMode("normal")
    }
    input.extmarks.clear()
    setStore("prompt", emptyPrompt())
    setStore("extmarkToPart", new Map())
    input.clear()
    resetVimHistory()
  }

  // Captured once: the session route is keyed by sessionID, so this Prompt
  // instance belongs to exactly one tab. Reading props.sessionID lazily would
  // observe the *next* route during onCleanup and stash under the wrong tab.
  const stashSessionID = props.sessionID

  onMount(() => {
    const saved = takeDraft(stashSessionID)
    if (store.prompt.text) return
    if (saved && saved.prompt.text) {
      input.setText(saved.prompt.text)
      setStore("prompt", saved.prompt)
      setStore("mode", saved.prompt.mode ?? "normal")
      restoreExtmarksFromPrompt(saved.prompt)
      input.cursorOffset = Math.min(saved.cursor, measure(saved.prompt.text))
    }
    if (vimEnabled() && vimState.isInsert()) vim.beginInsertEdit()
  })

  onCleanup(() => {
    disposed = true
    if (store.prompt.text) {
      saveDraft(stashSessionID, { prompt: { ...unwrap(store.prompt), mode: store.mode }, cursor: input.cursorOffset })
    }
    setInputTarget(undefined)
    props.ref?.(undefined)
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    if (props.visible === false || disabled() || dialog.stack.length > 0) {
      if (input.focused) input.blur()
      input.focusable = false
      if (!vimState.isCopy() || dialog.stack.length > 0) untrack(() => vimState.clearPending())
      return
    }

    input.focusable = true
    // Slot/plugin updates can remount the background prompt while a dialog is open.
    // Keep focus with the dialog and let the prompt reclaim it after the dialog closes.
    if (!input.focused) input.focus()
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    input.traits = {
      ...input.traits,
      ...computePromptTraits({
        mode: store.mode,
        autocompleteVisible: !!auto()?.visible,
      }),
    }
  })

  const copyModePrompt = {
    snapshot: undefined as { prompt: PromptInfo; cursor: number } | undefined,
    restoring: false,
  }
  function restoreCopyModePrompt() {
    const snapshot = copyModePrompt.snapshot
    if (!vimState.isCopy() || !snapshot) return false
    if (copyModePrompt.restoring) return true
    copyModePrompt.restoring = true
    try {
      batch(() => {
        if (input.plainText !== snapshot.prompt.text) input.setText(snapshot.prompt.text)
        setStore("prompt", structuredClone(snapshot.prompt))
        restoreExtmarksFromPrompt(store.prompt)
        input.cursorOffset = snapshot.cursor
      })
    } finally {
      copyModePrompt.restoring = false
    }
    return true
  }
  const copyModeSuspend = { owns: false, previous: false }
  const restoreCopyModeSuspend = () => {
    if (!copyModeSuspend.owns || !input || input.isDestroyed) return
    const traits = { ...input.traits }
    if (copyModeSuspend.previous) traits.suspend = true
    else delete traits.suspend
    input.traits = traits
    copyModeSuspend.owns = false
  }
  createEffect(() => {
    if (!input || input.isDestroyed) return
    if (!vimState.isCopy()) {
      copyModePrompt.snapshot = undefined
      restoreCopyModeSuspend()
      return
    }
    copyModePrompt.snapshot ??= {
      prompt: structuredClone(unwrap(store.prompt)),
      cursor: input.cursorOffset,
    }
    if (store.prompt.text !== copyModePrompt.snapshot.prompt.text || input.plainText !== copyModePrompt.snapshot.prompt.text)
      restoreCopyModePrompt()
    if (!copyModeSuspend.owns) {
      copyModeSuspend.previous = input.traits.suspend === true
      copyModeSuspend.owns = true
    }
    if (input.traits.suspend !== true) input.traits = { ...input.traits, suspend: true }
  })
  onCleanup(restoreCopyModeSuspend)

  function restoreExtmarksFromPrompt(prompt: PromptInfo) {
    input.extmarks.clear()
    setStore("extmarkToPart", new Map())

    const parts = [
      ...(prompt.files ?? []).map((part, index) => ({
        mention: part.mention,
        ref: { type: "file" as const, index },
        styleId: fileStyleId,
      })),
      ...(prompt.agents ?? []).map((part, index) => ({
        mention: part.mention,
        ref: { type: "agent" as const, index },
        styleId: agentStyleId,
      })),
      ...(prompt.skills ?? []).map((part, index) => ({
        mention: part.mention,
        ref: { type: "skill" as const, index },
        styleId: skillStyleId,
      })),
      ...prompt.pasted.map((part, index) => ({
        mention: part.source,
        ref: { type: "pasted" as const, index },
        styleId: pasteStyleId,
      })),
    ]

    parts.forEach(({ mention, ref, styleId }) => {
      if (mention?.text) {
        const extmarkId = input.extmarks.create({
          start: mention.start,
          end: mention.end,
          virtual: true,
          styleId,
          typeId: promptPartTypeId,
        })
        setStore("extmarkToPart", (map: Map<number, PromptPartRef>) => {
          const newMap = new Map(map)
          newMap.set(extmarkId, ref)
          return newMap
        })
      }
    })
  }

  function syncExtmarksWithPromptParts() {
    const allExtmarks = input.extmarks.getAllForTypeId(promptPartTypeId)
    setStore(
      produce((draft) => {
        const newMap = new Map<number, PromptPartRef>()
        const fileExtmarks = new Map<number, NonNullable<PromptInfo["files"]>[number]>()
        const files: NonNullable<PromptInfo["files"]> = []
        const agents: NonNullable<PromptInfo["agents"]> = []
        const skills: NonNullable<PromptInfo["skills"]> = []
        const pasted: PromptInfo["pasted"] = []

        for (const extmark of allExtmarks) {
          const ref = draft.extmarkToPart.get(extmark.id)
          if (!ref) continue
          if (ref.type === "file") {
            const part = draft.prompt.files?.[ref.index]
            if (!part?.mention) continue
            part.mention.start = extmark.start
            part.mention.end = extmark.end
            files.push(part)
            fileExtmarks.set(extmark.id, part)
            continue
          }
          if (ref.type === "agent") {
            const part = draft.prompt.agents?.[ref.index]
            if (!part?.mention) continue
            part.mention.start = extmark.start
            part.mention.end = extmark.end
            const index = agents.length
            agents.push(part)
            newMap.set(extmark.id, { type: "agent", index })
            continue
          }
          if (ref.type === "skill") {
            const part = draft.prompt.skills?.[ref.index]
            if (!part?.mention) continue
            part.mention.start = extmark.start
            part.mention.end = extmark.end
            const index = skills.length
            skills.push(part)
            newMap.set(extmark.id, { type: "skill", index })
            continue
          }
          const part = draft.prompt.pasted[ref.index]
          if (!part) continue
          part.source.start = extmark.start
          part.source.end = extmark.end
          const index = pasted.length
          pasted.push(part)
          newMap.set(extmark.id, { type: "pasted", index })
        }

        const nextFiles = preserveMentionlessPromptAttachments(draft.prompt.files, files)
        const fileIndices = new Map(nextFiles.map((file, index) => [file, index]))
        for (const [extmark, file] of fileExtmarks) {
          const index = fileIndices.get(file)
          if (index !== undefined) newMap.set(extmark, { type: "file", index })
        }

        draft.extmarkToPart = newMap
        if (
          nextFiles.length !== draft.prompt.files?.length ||
          nextFiles.some((file, index) => file !== draft.prompt.files?.[index])
        )
          draft.prompt.files = nextFiles
        draft.prompt.agents = agents
        draft.prompt.skills = skills
        draft.prompt.pasted = pasted
      }),
    )
  }

  const stashCommands = createMemo(() =>
    [
      {
        title: "Stash prompt",
        name: "prompt.stash",
        category: "Prompt",
        enabled: !!store.prompt.text,
        run: () => {
          if (!store.prompt.text) return
          stash.push({ prompt: store.prompt })
          resetComposer()
          dialog.clear()
        },
      },
      {
        title: "Stash pop",
        name: "prompt.stash.pop",
        category: "Prompt",
        enabled: stash.list().length > 0,
        run: () => {
          const entry = stash.pop()
          if (entry) {
            input.setText(entry.prompt.text)
            setStore("prompt", entry.prompt)
            restoreExtmarksFromPrompt(entry.prompt)
            input.gotoBufferEnd()
            resetVimHistory()
          }
          dialog.clear()
        },
      },
      {
        title: "Stash list",
        name: "prompt.stash.list",
        category: "Prompt",
        enabled: stash.list().length > 0,
        run: () => {
          dialog.replace(() => (
            <DialogStash
              onSelect={(entry) => {
                input.setText(entry.prompt.text)
                setStore("prompt", entry.prompt)
                restoreExtmarksFromPrompt(entry.prompt)
                input.gotoBufferEnd()
                resetVimHistory()
              }}
            />
          ))
        },
      },
    ].map(
      ({ name, category, ...command }) =>
        ({
          id: name,
          group: category,
          bind: false,
          palette: true as const,
          ...command,
        }) satisfies KeymapCommand,
    ),
  )

  Keymap.createLayer(() => ({
    mode: "global",
    enabled: !disabled(),
    commands: stashCommands(),
  }))

  Keymap.createLayer(() => {
    return {
      target: inputTarget,
      enabled: inputTarget() !== undefined && !disabled(),
      bindings: ["prompt.paste"],
    }
  })

  Keymap.createLayer(() => {
    return {
      target: inputTarget,
      enabled: inputTarget() !== undefined && !disabled() && store.prompt.text !== "",
      bindings: ["prompt.clear"],
    }
  })

  Keymap.createLayer(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return (
          inputTarget() !== undefined &&
          !disabled() &&
          store.mode === "normal" &&
          !auto()?.visible &&
          input?.visualCursor.offset === 0
        )
      })(),
      commands: [
        {
          bind: "!",
          title: "Shell mode",
          group: "Prompt",
          run: () => {
            setStore("placeholder", randomIndex(shell().length))
            setStore("mode", "shell")
          },
        },
      ],
    }
  })

  Keymap.createLayer(() => {
    return {
      priority: 1,
      target: inputTarget,
      enabled: inputTarget() !== undefined && !disabled() && store.mode === "shell",
      commands: [
        { bind: "escape", title: "Exit shell mode", group: "Prompt", run: () => setStore("mode", "normal") },
        {
          bind: "ctrl+c",
          title: "Exit shell mode",
          group: "Prompt",
          enabled: () => store.prompt.text === "",
          run: () => setStore("mode", "normal"),
        },
      ],
    }
  })

  Keymap.createLayer(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && !disabled() && store.mode === "shell" && input?.visualCursor.offset === 0
      })(),
      commands: [
        { bind: "backspace", title: "Exit shell mode", group: "Prompt", run: () => setStore("mode", "normal") },
      ],
    }
  })

  Keymap.createLayer(() => {
    return {
      priority: 1,
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && !disabled() && !auto()?.visible && input !== undefined
      })(),
      commands: [
        {
          id: "prompt.history.previous",
          title: "Previous prompt history",
          group: "Prompt",
          run() {
            if (input.cursorOffset !== 0) {
              if (input.scrollY + input.visualCursor.visualRow === 0) {
                input.cursorOffset = 0
                return
              }
              input.moveCursorUp()
              return
            }

            const item = history.move(-1, input.plainText)
            if (!item) return false
            input.setText(item.text)
            setStore("prompt", item)
            setStore("mode", item.mode ?? "normal")
            restoreExtmarksFromPrompt(item)
            input.cursorOffset = 0
            resetVimHistory()
          },
        },
      ],
    }
  })

  Keymap.createLayer(() => {
    return {
      priority: 1,
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && !disabled() && !auto()?.visible && input !== undefined
      })(),
      commands: [
        {
          id: "prompt.history.next",
          title: "Next prompt history",
          group: "Prompt",
          run() {
            const end = measure(input.plainText)
            if (input.cursorOffset !== end) {
              if (
                input.scrollY + input.visualCursor.visualRow ===
                Math.max(0, input.editorView.getTotalVirtualLineCount() - 1)
              ) {
                input.cursorOffset = end
                return
              }
              input.moveCursorDown()
              return
            }

            const item = history.move(1, input.plainText)
            if (!item) return false
            input.setText(item.text)
            setStore("prompt", item)
            setStore("mode", item.mode ?? "normal")
            restoreExtmarksFromPrompt(item)
            input.cursorOffset = measure(item.text)
            resetVimHistory()
          },
        },
      ],
    }
  })

  let submitting = false
  async function submit(delivery: SessionInbox.Delivery = "steer") {
    if (disabled()) return false
    // Prevent overlapping invocations (e.g. a double-pressed Enter, or the
    // input's native onSubmit racing another dispatch). Without this guard,
    // a second call slips past the empty-input check before the first call
    // clears `store.prompt.text`, then awaits its own `session.create` and
    // ultimately reads the now-empty store — sending a phantom empty prompt
    // to a freshly created session.
    if (submitting) return false
    submitting = true
    try {
      return await submitInner(delivery)
    } finally {
      submitting = false
    }
  }

  async function submitInner(delivery: SessionInbox.Delivery) {
    // IME: double-defer may fire before onContentChange flushes the last
    // composed character (e.g. Korean hangul) to the store, so read
    // plainText directly and sync before any downstream reads.
    if (input && !input.isDestroyed && input.plainText !== store.prompt.text) {
      setStore("prompt", "text", input.plainText)
      syncExtmarksWithPromptParts()
    }
    if (move.creating()) return false
    if (auto()?.visible) return false
    const trimmed = store.prompt.text.trim()
    if (!trimmed && (!props.sessionID || store.mode === "shell" || delivery === "queue"))
      return delivery === "steer" ? (await props.onEmptySubmit?.()) === true : false
    const exitWord = trimmed === "exit" || trimmed === "quit" || trimmed === ":q"
    const inputText = expandTrackedPastedText(
      store.prompt.text,
      input.extmarks.getAllForTypeId(promptPartTypeId).flatMap((extmark) => {
        const ref = store.extmarkToPart.get(extmark.id)
        if (ref?.type !== "pasted") return []
        const part = store.prompt.pasted[ref.index]
        if (!part) return []
        return [{ start: extmark.start, end: extmark.end, text: part.text }]
      }),
      renderer.widthMethod,
    )
    const slash = argumentSlash(inputText, keymapCommands())
    if (delivery === "queue" && (store.mode === "shell" || exitWord || slash)) {
      toast.show({ message: "This prompt cannot be queued", variant: "warning" })
      return false
    }
    if (exitWord) {
      void exit()
      return true
    }
    if (slash) {
      clearPrompt()
      await slash.command.run(slash.input)
      return true
    }
    const slashHead = parseSlashHead(inputText, /\s/)
    const isCommand =
      slashHead !== undefined &&
      (data.location.command.list(currentLocation.ref) ?? []).some((command) => command.name === slashHead.name)
    const editorSelection = editorContext()
    const pendingEditorSelection = editorSelection && editor.labelState() === "pending" ? editorSelection : undefined
    if (delivery === "queue" && pendingEditorSelection) {
      toast.show({ message: "Editor context cannot be queued", variant: "warning" })
      return false
    }
    const agent = local.agent.current()
    if (!agent) return false
    const selection = local.model.selection()
    if (!selection) {
      void promptModelWarning()
      return false
    }
    const usesModel = !props.sessionID || store.mode !== "shell"
    if (usesModel && !local.model.available(selection)) {
      toast.show({
        title: "Model unavailable",
        message: `${selection.providerID}/${selection.modelID} is not available in this session's location`,
        variant: "warning",
      })
      return false
    }

    // Snapshot the composer and clear it synchronously, before the first await.
    // Everything below reads the snapshot: text typed while a request is in
    // flight lands in the already-empty composer and survives, and prompt
    // history records exactly what was submitted instead of the live store
    // (which may have absorbed mid-flight typing). Failure paths restore the
    // snapshot unless the user has started typing something new.
    const currentMode = store.mode
    const entry = { ...store.prompt, mode: currentMode }
    if (trimmed) {
      resetComposer()
      if (config.vim_insert_after_submit && vimEnabled()) {
        vimState.setMode("insert")
        vim.beginInsertEdit()
      }
      props.onSubmit?.()
    }
    const restoreEntry = () => {
      if (disposed || input.isDestroyed || input.plainText !== "") return
      input.setText(entry.text)
      setStore("prompt", entry)
      setStore("mode", entry.mode ?? "normal")
      restoreExtmarksFromPrompt(entry)
      input.cursorOffset = measure(entry.text)
      resetVimHistory()
    }
    const fail = (title: string, error: unknown) => {
      toast.show({ title, message: errorMessage(error), variant: "error" })
      restoreEntry()
    }
    const attempt = async (title: string, run: () => Promise<unknown>) => {
      return run().then(
        () => true,
        (error: unknown) => {
          fail(title, error)
          return false
        },
      )
    }

    const variant = selection.variant
    let sessionID = props.sessionID
    let session = sessionID ? data.session.get(sessionID) : undefined
    let finishMoveProgress = false
    // New-session sends wait for creation and environment setup.
    let newSession: { gate: Promise<unknown>; recover: (error: unknown) => void } | undefined
    if (sessionID == null) {
      const directory = await move.getDirectory()
      if (move.pending() && !directory) {
        restoreEntry()
        return false
      }
      finishMoveProgress = Boolean(move.progress())
      // The location context is where the next session is created: seeded by the home
      // route (launch cwd, inherited session location, or picked project) and updated
      // by /cd before a session exists.
      const location = currentLocation.ref ?? data.location.default()

      // Optimistic create: the data layer mints the ID client-side and admits
      // a local session record synchronously, so the navigation below happens
      // immediately — enter feels sent even while the create round-trip is in
      // flight. Sends against the new session gate on the request.
      const newSessionID = args.takeNewSessionID()
      const created = data.session.create({
        id: newSessionID,
        location: directory ? { directory } : location,
        agent: agent.id,
        model: {
          providerID: selection.providerID,
          id: selection.modelID,
          variant,
        },
      })
      if (newSessionID !== undefined) created.request.catch(() => args.restoreNewSessionID(newSessionID))
      sessionID = created.id
      session = data.session.get(created.id)
      newSession = {
        gate: created.request.then(async (info) => {
          if (terminalEnvironment.variables !== undefined) {
            await client.api.session.environment({ sessionID: created.id, variables: terminalEnvironment.variables })
          }
        }),
        recover: (error) => {
          toast.show({
            title: data.session.get(created.id) ? "Failed to set up session" : "Creating a session failed",
            message: errorMessage(error),
            variant: "error",
          })
          const active =
            route.data.type === "session" && route.data.sessionID === created.id ? promptRef.current : undefined
          const current = active?.current
          const draft = current?.text
            ? { prompt: { ...unwrap(current), mode: active?.mode ?? "normal" }, cursor: Infinity }
            : (takeDraft(created.id) ?? { prompt: entry, cursor: Infinity })
          saveDraft(undefined, draft)
          active?.reset()
          if (sessionTabs.enabled()) {
            sessionTabs.close(created.id)
          } else if (route.data.type === "session" && route.data.sessionID === created.id) {
            route.navigate({ type: "home" })
          }
        },
      }
    }

    const target = sessionID
    const prepareAgent = async () => {
      if (!session) {
        await data.session.sync(target)
        session = data.session.get(target)
      }
      if (session?.agent !== agent.id) {
        await client.api.session.switchAgent({ sessionID: target, agent: agent.id })
      }
    }
    const commitModel = () => {
      const model = { providerID: selection.providerID, id: selection.modelID, variant }
      const cancelCommit = local.model.trackSessionCommit(target, model, agent.id)
      return client.api.session.switchModel({ sessionID: target, model }).catch((error) => {
        cancelCommit()
        throw new Error(`Failed to switch model: ${errorMessage(error)}`, { cause: error })
      })
    }
    const commitSelection = async () => {
      await prepareAgent()
      await commitModel()
    }
    if (!trimmed) {
      // Blank Enter in an existing session commits the composer's agent and
      // model selection, then hands off to the route (queued prompt promotion).
      await attempt("Failed to prepare session", async () => {
        await commitSelection()
        await props.onEmptySubmit?.()
      })
      return true
    }
    history.append(entry)
    if (currentMode === "shell") {
      move.startSubmit()
      const send = () => client.api.session.shell({ sessionID: target, command: inputText })
      void (newSession ? newSession.gate.then(send) : send()).catch((error) =>
        newSession ? newSession.recover(error) : fail("Failed to run shell command", error),
      )
      setStore("mode", "normal")
    } else if (slashHead && isCommand) {
      const send = async () => {
        // Commands inherit the composer selection; command-specific overrides
        // remain server-owned and run after this preparation.
        await commitSelection()
        return client.api.session.command({
          sessionID: target,
          name: slashHead.name,
          text: slashHead.arguments,
          files: entry.files,
          agents: entry.agents,
          skills: entry.skills?.length ? entry.skills : undefined,
          delivery,
        })
      }
      void (newSession ? newSession.gate.then(send) : send()).catch((error) =>
        newSession ? newSession.recover(error) : fail("Failed to run command", error),
      )
    } else {
      move.startSubmit()
      if (!(await attempt("Failed to prepare session", prepareAgent))) return true
      // Revert must settle before optimistic admission: its committed echo
      // splices every local row at or after the boundary, which would include
      // a freshly admitted prompt.
      if (
        session?.revert &&
        !(await attempt("Failed to commit revert", () => client.api.session.revert.commit({ sessionID: target })))
      )
        return false
      if (pendingEditorSelection) {
        // Keep editor context hidden while admitting it before the corresponding user prompt.
        const send = () =>
          client.api.session.synthetic({
            sessionID: target,
            text: formatEditorContext(pendingEditorSelection),
            resume: false,
          })
        // Fold into the setup gate so the context still admits before the
        // user prompt once the session exists.
        if (newSession) newSession.gate = newSession.gate.then(send)
        else if (!(await attempt("Failed to send editor context", send))) return false
      }
      // The data layer admits optimistically: the prompt renders immediately
      // and rolls back if the server rejects it, so submission does not wait
      // on the network. On rejection the row is already rolled back; restore
      // the composer unless the user has started typing something new.
      data.session
        .prompt({
          sessionID: target,
          text: inputText,
          files: entry.files,
          agents: entry.agents,
          skills: entry.skills?.length ? entry.skills : undefined,
          delivery,
          gate: newSession?.gate,
          // Commit the captured selection after earlier admissions, including
          // compaction setup. Cached state may still precede their SSE echoes;
          // the server makes an unchanged selection a no-op.
          prepare: commitModel,
        })
        .catch((error) => (newSession ? newSession.recover(error) : fail("Failed to send prompt", error)))
      if (pendingEditorSelection) editor.markSelectionSent()
    }

    // Optimistic admission puts the message in the store synchronously, so
    // the session view renders it on arrival.
    if (!props.sessionID) {
      if (pendingEditorSelection) editor.preserveSelectionFromNewSession()
      // Text typed while session creation was in flight lives in this (home)
      // prompt, which unmounts on navigation and would stash it under the
      // home key. Re-stash it under the new session so that composer restores
      // it, and clear it here so onCleanup does not also stash it for home.
      if (!disposed && !input.isDestroyed && store.prompt.text) {
        // Copy before clearing: unwrap returns the live store target, and the
        // resetComposer store write merges into that same object.
        saveDraft(sessionID, { prompt: { ...unwrap(store.prompt), mode: store.mode }, cursor: input.cursorOffset })
        resetComposer()
      }
      route.navigate({
        type: "session",
        sessionID,
      })
    }
    if (finishMoveProgress) move.finishSubmit()
    return true
  }

  function pasteText(text: string, virtualText: string) {
    const currentOffset = input.cursorOffset
    const extmarkStart = currentOffset
    const extmarkEnd = extmarkStart + measure(virtualText)

    input.insertText(virtualText + " ")

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    setStore(
      produce((draft) => {
        const index = draft.prompt.pasted.length
        draft.prompt.pasted.push({
          text,
          source: { start: extmarkStart, end: extmarkEnd, text: virtualText },
        })
        draft.extmarkToPart.set(extmarkId, { type: "pasted", index })
      }),
    )
  }

  function expandPastedText(extmarkId: number) {
    const extmark = input.extmarks.get(extmarkId)
    const ref = store.extmarkToPart.get(extmarkId)
    if (!extmark || ref?.type !== "pasted") return false
    const part = store.prompt.pasted[ref.index]
    if (!part) return false

    input.extmarks.delete(extmarkId)
    input.setSelection(extmark.start, extmark.end)
    input.insertText(part.text)
    return true
  }

  async function pasteInputText(text: string, changed: () => boolean) {
    const normalizedText = stripAnsiSequences(text).replace(/\r\n?/g, "\n")
    const pastedContent = normalizedText.trim()
    const attachments = await resolvePastedAttachments(pastedContent, terminalEnvironment.platform)
    if (changed()) return
    if (attachments) {
      attachments.forEach((attachment) => {
        if (attachment.type === "text") {
          pasteText(attachment.content, `[SVG: ${attachment.filename || "image"}]`)
          return
        }
        pasteAttachment(attachment)
      })
      return
    }

    const lineCount = (pastedContent.match(/\n/g)?.length ?? 0) + 1
    if ((lineCount >= 3 || pastedContent.length > 150) && config.prompt?.paste !== "full") {
      const extmark = input.extmarks.getAllForTypeId(promptPartTypeId).find((extmark) => {
        const ref = store.extmarkToPart.get(extmark.id)
        return (
          (extmark.end === input.cursorOffset || extmark.end + 1 === input.cursorOffset) &&
          ref?.type === "pasted" &&
          store.prompt.pasted[ref.index]?.text === pastedContent
        )
      })
      if (extmark && expandPastedText(extmark.id)) return
      pasteText(pastedContent, `[Pasted ~${lineCount} lines]`)
      return
    }

    input.insertText(normalizedText)

    setTimeout(() => {
      if (!input || input.isDestroyed) return
      input.invalidateIntrinsicSize()
      renderer.requestRender()
    }, 0)
  }

  function pasteAttachment(file: { filename?: string; uri: string }) {
    const currentOffset = input.cursorOffset
    const extmarkStart = currentOffset
    const virtualText = promptAttachmentLabel(store.prompt.files, { uri: file.uri, name: file.filename })
    const extmarkEnd = extmarkStart + virtualText.length
    const textToInsert = virtualText + " "

    input.insertText(textToInsert)

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    const part: NonNullable<PromptInfo["files"]>[number] = {
      uri: file.uri,
      name: file.filename,
      mention: {
        start: extmarkStart,
        end: extmarkEnd,
        text: virtualText,
      },
    }
    setStore(
      produce((draft) => {
        const files = (draft.prompt.files ??= [])
        const index = files.length
        files.push(part)
        draft.extmarkToPart.set(extmarkId, { type: "file", index })
      }),
    )
  }

  function promptSnapshot() {
    syncExtmarksWithPromptParts()
    return {
      text: input.plainText,
      cursor: input.cursorOffset,
      data: structuredClone(unwrap(store.prompt)),
    }
  }

  function clearPrompt() {
    if (
      store.prompt.text.trim().length >= DRAFT_RETENTION_MIN_CHARS ||
      store.prompt.pasted.length > 0 ||
      (store.prompt.files?.length ?? 0) > 0 ||
      (store.prompt.agents?.length ?? 0) > 0
    ) {
      history.append({
        ...store.prompt,
        mode: store.mode,
      })
    }
    resetComposer()
  }

  // Keep the last resolved prompt display visible while destination catalogs load;
  // availability and submission still use the live location-scoped catalog.
  const promptDisplay = createMemo<{
    agentLabel: string | undefined
    agentColor: RGBA | undefined
    modelLabel: string
    providerLabel: string
    variant: string | undefined
  }>(
    (previous) => {
      const location = currentLocation.ref ?? data.location.default()
      const sessionLocation = props.sessionID ? data.session.get(props.sessionID)?.location : location
      if (!sessionLocation || locationKey(sessionLocation) !== locationKey(location)) return previous

      const loading = data.location.agent.list(location) === undefined || !local.model.catalogReady
      const error = currentLocation.error
      const failed = error && locationKey(error.location) === locationKey(location)
      if (loading && !failed) return previous

      const agent = local.agent.current()
      const model = local.model.parsed()
      return {
        agentLabel: agent ? Locale.titlecase(agent.id) : undefined,
        agentColor: agent ? local.agent.color(agent.id) : undefined,
        modelLabel: model.model,
        providerLabel: model.provider,
        variant: local.model.variant.current(),
      }
    },
    {
      agentLabel: undefined,
      agentColor: undefined,
      modelLabel: local.model.parsed().model,
      providerLabel: local.model.parsed().provider,
      variant: undefined,
    },
  )
  const highlight = createMemo(() => {
    if (muted()) return theme.border.base
    if (store.mode === "shell") return theme.text.action.primary.selected
    return promptDisplay().agentColor ?? theme.border.base
  })
  const agentLabel = createMemo(() => (store.mode === "shell" ? "Shell" : promptDisplay().agentLabel))
  const animateMetadata = !revealedPromptMetadata.has(local)
  const metadataAnimationsEnabled = () => animationsEnabled() && animateMetadata
  const agentMetaAlpha = createFadeIn(() => !!agentLabel(), metadataAnimationsEnabled)
  const modelMetaAlpha = createFadeIn(
    () => !!promptDisplay().agentLabel && store.mode === "normal",
    metadataAnimationsEnabled,
  )
  const variantMetaAlpha = createFadeIn(
    () => !!promptDisplay().agentLabel && store.mode === "normal" && !!promptDisplay().variant,
    metadataAnimationsEnabled,
  )
  createEffect(() => {
    if (agentLabel()) revealedPromptMetadata.add(local)
  })
  const borderHighlight = createMemo(() => tint(theme.border.base, highlight(), agentMetaAlpha()))
  const footerInput = () => ({
    sessionID: props.sessionID,
    mode: store.mode,
    showDetails: store.interrupt === 0 || dimensions().width >= 80,
  })

  const placeholderText = createMemo(() => {
    if (minimal()) return undefined
    const value = (() => {
      if (store.mode === "shell") {
        if (!shell().length) return undefined
        return `Run a command… "${shell()[store.placeholder % shell().length]}"`
      }
      if (!list().length) return undefined
      return `Ask anything… "${list()[store.placeholder % list().length]}"`
    })()
    if (!value) return undefined
    const width = dimensions().width < 44 ? dimensions().width - 5 : Math.min(75, dimensions().width - 4) - 5
    return Locale.takeWidth(value, Math.max(1, width)).trimEnd()
  })
  const footerLocation = createMemo(() => {
    if (!props.sessionID) {
      // No session yet: show where the next session will be created.
      return currentLocation.ref ?? data.location.default()
    }
    if (status() !== "idle") return
    return data.session.get(props.sessionID)?.location
  })
  const locationLabel = createMemo(() => {
    const pending = pendingDirectory()
    const location = pending ? { directory: pending } : footerLocation()
    if (!location) return
    const directory = abbreviateHome(location.directory, paths.home)
    const branch = data.location.vcs.info(location)?.branch.current
    return branch ? `${directory}:${branch}` : directory
  })
  const [locationWidth, setLocationWidth] = createSignal(dimensions().width)
  const locationLabelDisplay = createMemo(() => {
    const label = locationLabel()
    if (!label) return
    return truncateFilePath(label, locationWidth())
  })
  const locationActions = useWorkingDirectoryActions({
    directory: () => footerLocation()?.directory,
    onMove: () => void move.open(),
  })

  const spinnerDef = createMemo(() => {
    const color = promptDisplay().agentColor ?? theme.border.base
    return {
      frames: createFrames({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
      color: createColors({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
    }
  })
  const maxHeight = createMemo(() => config.prompt_max_height ?? Math.max(6, Math.floor(dimensions().height / 3)))
  const showScrollbar = createMemo(() => config.prompt_scrollbar !== false)
  const [scrollbar, setScrollbar] = createSignal<string[] | null>(null)

  function syncScrollbar() {
    queueMicrotask(() => {
      if (!input || input.isDestroyed || !showScrollbar()) {
        setScrollbar(null)
        return
      }
      const total = input.editorView.getTotalVirtualLineCount()
      const height = input.height
      if (total <= height) {
        setScrollbar(null)
        return
      }
      const range = total - height
      const virtual = height * 2
      const size = Math.max(1, Math.floor(virtual * (height / total)))
      const start = Math.round((input.scrollY / range) * (virtual - size))
      setScrollbar(
        Array.from({ length: height }, (_, row) => {
          const cellStart = row * 2
          const overlap = Math.min(start + size, cellStart + 2) - Math.max(start, cellStart)
          if (overlap >= 2) return "█"
          if (overlap > 0) return start <= cellStart ? "▀" : "▄"
          return " "
        }),
      )
      renderer.requestRender()
    })
  }

  createEffect(() => {
    showScrollbar()
    syncScrollbar()
  })

  function submitFromTextarea() {
    if (disabled()) return
    if (vimState.isCopy()) {
      if (!props.copy?.isVisual() && (props.copy?.toggleCollapsed() || props.copy?.activate())) return
      void props.copy?.copy()
      props.copy?.exitPreserveScroll()
      vimState.setMode("normal")
      return
    }
    if (
      store.mode === "normal" &&
      vimEnabled() &&
      (vimState.isInsert() || vimState.isReplace()) &&
      !config.vim_enter_submit
    ) {
      input.insertText("\n")
      return
    }
    setTimeout(() => setTimeout(() => submit(), 0), 0)
  }

  function VimIndicator() {
    return (
      <Show when={vimIndicator()}>
        {(indicator) => (
          <text
            fg={vimState.isVisual() ? theme.text.base : theme.text.muted}
            attributes={vimState.pending() || vimState.isVisual() ? TextAttributes.BOLD : undefined}
            wrapMode="none"
          >
            {indicator()}
          </text>
        )}
      </Show>
    )
  }

  const promptBg = createMemo(() => theme.decrease(theme.background.raised.base))

  return (
    <>
      <box ref={(r: BoxRenderable) => (anchor = r)} visible={props.visible !== false} width="100%">
        <box
          width="100%"
          border={["left"]}
          borderColor={borderHighlight()}
          customBorderChars={{
            ...SplitBorder.customBorderChars,
            bottomLeft: "╹",
          }}
        >
          <box
            paddingLeft={dimensions().width < 44 ? 1 : 2}
            paddingRight={dimensions().width < 44 ? 1 : 2}
            paddingTop={1}
            flexShrink={0}
            backgroundColor={promptBg()}
            flexGrow={1}
            width="100%"
          >
            <Show when={config.prompt?.image_preview && visibleImageAttachments().length > 0}>
              <box
                width="100%"
                height={imagePreviewHeight() + 1}
                flexDirection="row"
                flexShrink={0}
                justifyContent="flex-start"
                gap={1}
                paddingBottom={1}
              >
                <For each={visibleImageAttachments()}>
                  {(file, index) => {
                    const [failed, setFailed] = createSignal(false)
                    return (
                      <box
                        width={imagePreviewWidth()}
                        height={imagePreviewHeight()}
                        flexBasis={imagePreviewWidth()}
                        flexShrink={1}
                        onMouseUp={(event: MouseEvent) => {
                          if (event.button !== 0) return
                          event.stopPropagation()
                          openImagePreview(index())
                        }}
                      >
                        <Show
                          when={!failed()}
                          fallback={
                            <box width="100%" height="100%" alignItems="center" justifyContent="center">
                              <text fg={theme.text.muted}>No preview</text>
                            </box>
                          }
                        >
                          <image
                            id={`prompt-image-preview-${index()}`}
                            source={file.uri}
                            fit="cover"
                            protocol="auto"
                            width="100%"
                            height="100%"
                            onError={() => setFailed(true)}
                          />
                        </Show>
                      </box>
                    )
                  }}
                </For>
                <Show when={imageAttachments().length > visibleImageAttachments().length}>
                  <box
                    width={8}
                    height={imagePreviewHeight()}
                    flexBasis={8}
                    flexShrink={1}
                    alignItems="center"
                    justifyContent="center"
                    onMouseUp={(event: MouseEvent) => {
                      if (event.button !== 0) return
                      event.stopPropagation()
                      openImagePreview(visibleImageAttachments().length)
                    }}
                  >
                    <text fg={theme.text.muted} wrapMode="none" truncate>
                      +{imageAttachments().length - visibleImageAttachments().length} more
                    </text>
                  </box>
                </Show>
              </box>
            </Show>
            <box flexDirection="row" flexGrow={1}>
              <textarea
              flexGrow={1}
              width="100%"
              placeholder={placeholderText()}
              placeholderColor={theme.text.muted}
              textColor={muted() ? theme.text.muted : theme.text.base}
              focusedTextColor={muted() ? theme.text.muted : theme.text.base}
              minHeight={1}
              maxHeight={maxHeight()}
              cursorStyle={cursorStyle()}
              onContentChange={() => {
                // Restore the whole frozen draft before extmark synchronization can discard its parts.
                if (restoreCopyModePrompt()) return
                const value = input.plainText
                setStore("prompt", "text", value)
                auto()?.onInput(value)
                syncExtmarksWithPromptParts()
                syncScrollbar()
                setCursorVersion((value) => value + 1)
              }}
              onCursorChange={() => {
                syncScrollbar()
                setCursorVersion((value) => value + 1)
              }}
              onKeyDown={async (event: KeyEvent) => {
                if (disabled()) {
                  event.preventDefault()
                  return
                }
                if (vimState.isCopy() && !copyEligible()) {
                  event.preventDefault()
                  return
                }
                if (store.mode !== "normal") return
                if (shouldSyncVimRegister(event)) {
                  event.preventDefault()
                  await syncVimRegisterFromClipboard()
                  vim.handleKey(event)
                  return
                }
                vim.handleKey(event)
              }}
              onSubmit={submitFromTextarea}
              onPaste={(event: PasteEvent) => {
                if (disabled() || vimState.isCopy()) {
                  event.preventDefault()
                  return
                }

                // Normalize line endings at the boundary
                // Windows ConPTY/Terminal often sends CR-only newlines in bracketed paste
                // Replace CRLF first, then any remaining CR
                const normalizedText = decodePasteBytes(event.bytes).replace(/\r\n/g, "\n").replace(/\r/g, "\n")

                // Windows Terminal <1.25 can surface image-only clipboard as an
                // empty bracketed paste. Windows Terminal 1.25+ does not.
                if (event.bytes.byteLength === 0) {
                  keymap.dispatch("prompt.paste")
                  return
                }

                // Once we cross an async boundary below, the terminal may perform its
                // default paste unless we suppress it first and handle insertion ourselves.
                event.preventDefault()

                void enqueuePaste((changed) => pasteInputText(normalizedText, changed))
              }}
              ref={(r: TextareaRenderable) => {
                input = r
                Object.assign(r, {
                  getClipboardText: (text: string) => expandPastedTextPlaceholders(text, store.prompt.pasted),
                })
                setInputTarget(r)
                if (promptPartTypeId === 0) {
                  promptPartTypeId = input.extmarks.registerType("prompt-part")
                }
                props.ref?.(ref)
                setTimeout(() => {
                  // setTimeout is a workaround and needs to be addressed properly
                  if (!input || input.isDestroyed) return
                  input.cursorColor = disabled() ? theme.background.raised.base : theme.text.base
                  input.cursorStyle = cursorStyle()
                  syncScrollbar()
                }, 0)
              }}
              onMouseDown={(r: MouseEvent) => {
                if (disabled()) {
                  r.preventDefault()
                  return
                }
                if (r.button !== 0) return
                r.target?.focus()
                const extmark = input.extmarks
                  .getAtOffset(input.cursorOffset)
                  .find((item) => store.extmarkToPart.get(item.id)?.type === "pasted")
                if (!extmark || !expandPastedText(extmark.id)) return
                r.preventDefault()
                r.stopPropagation()
              }}
              focusedBackgroundColor="transparent"
              cursorColor={disabled() ? theme.background.raised.base : theme.text.base}
              syntaxStyle={syntax()}
              />
              <Show when={showScrollbar()}>
                <box
                  width={1}
                  flexShrink={0}
                  marginLeft={1}
                  backgroundColor={scrollbar() ? theme.background.raised.high : promptBg()}
                >
                  <Show when={scrollbar()}>
                    {(chars) => (
                      <text>
                        {chars().map((char, index) => (
                          <>{index > 0 ? "\n" : ""}<span style={{ fg: theme.border.base }}>{char}</span></>
                        ))}
                      </text>
                    )}
                  </Show>
                </box>
              </Show>
            </box>
            <box flexDirection="row" flexShrink={0} paddingTop={1} gap={1} justifyContent="space-between">
              <PromptMetadataRow
                mode={store.mode}
                agent={agentLabel()}
                auto={local.permission.mode === "autoaccept"}
                model={promptDisplay().modelLabel}
                provider={promptDisplay().providerLabel}
                variant={promptDisplay().variant}
                muted={!!muted()}
                highlight={highlight()}
                agentAlpha={agentMetaAlpha()}
                modelAlpha={modelMetaAlpha()}
                variantAlpha={variantMetaAlpha()}
              />
            </box>
          </box>
        </box>
        <box
          height={1}
          border={["left"]}
          borderColor={borderHighlight()}
          customBorderChars={{
            ...EmptyBorder,
            vertical: promptBg().a !== 0 ? "╹" : " ",
          }}
        >
          <box
            height={1}
            border={["bottom"]}
            borderColor={promptBg()}
            customBorderChars={
              promptBg().a !== 0
                ? {
                    ...EmptyBorder,
                    horizontal: "▀",
                  }
                : {
                    ...EmptyBorder,
                    horizontal: " ",
                  }
            }
          />
        </box>
        <box width="100%" flexDirection="row" justifyContent="space-between" gap={2}>
          <VimIndicator />
          <Slot path="prompt.footer" input={footerInput()}>
            <Slot path="prompt.footer.status" input={footerInput()}>
              <box
                flexGrow={1}
                flexShrink={1}
                minWidth={0}
                onSizeChange={function (this: BoxRenderable) {
                  const width = this.width
                  queueMicrotask(() => setLocationWidth(width))
                }}
              >
                <Switch>
                  <Match when={status() === "running"}>
                    <box flexDirection="row" gap={1} flexGrow={1} justifyContent="flex-start">
                      <box marginLeft={1}>
                        <Show when={config.animations ?? true} fallback={<text fg={theme.text.muted}>[⋯]</text>}>
                          <spinner color={spinnerDef().color} frames={spinnerDef().frames} interval={40} />
                        </Show>
                      </box>
                      <PromptInterruptStatus
                        armed={store.interrupt > 0}
                        animations={animationsEnabled()}
                        text={theme.text.base}
                        subdued={theme.text.muted}
                        warning={theme.text.feedback.warning.base}
                        flash={theme.decrease(theme.text.feedback.warning.base, 2)}
                      />
                    </box>
                  </Match>
                  <Match when={move.progress()}>
                    {(progress) => (
                      <box paddingLeft={3} height={1} minHeight={0} flexShrink={1}>
                        <Spinner color={theme.hue.accent[500]}>
                          {progress()}
                          <span style={{ fg: theme.text.muted }}>{".".repeat(move.creatingDots())}</span>
                        </Spinner>
                      </box>
                    )}
                  </Match>
                  <Match when={move.pendingNew()}>
                    <box paddingLeft={3} height={1} minHeight={0} flexShrink={1}>
                      <text fg={theme.hue.accent[500]} wrapMode="none" truncate>
                        (new worktree)
                      </text>
                    </box>
                  </Match>
                  <Match when={true}>
                    <Show when={locationLabelDisplay()} fallback={<text />}>
                      {(location) => (
                        <text
                          id="prompt.footer.location"
                          fg={locationActions.hovered() ? theme.text.base : theme.text.muted}
                          wrapMode="none"
                          truncate
                          flexGrow={1}
                          flexShrink={1}
                          onMouseOver={locationActions.onMouseOver}
                          onMouseOut={locationActions.onMouseOut}
                          onMouseUp={locationActions.onMouseUp}
                        >
                          {location()}
                        </text>
                      )}
                    </Show>
                  </Match>
                </Switch>
              </box>
            </Slot>
            <Slot path="prompt.footer.file" input={footerInput()}>
              <Show when={!minimal() && editorContextLabelState() !== "none" ? editorFileLabelDisplay() : undefined}>
                {(file) => (
                  <text
                    wrapMode="none"
                    truncate
                    flexShrink={1}
                    fg={editorContextLabelState() === "pending" ? theme.hue.accent[500] : theme.text.muted}
                  >
                    {file()}
                  </text>
                )}
              </Show>
            </Slot>
          </Slot>
        </box>
      </box>
      <Autocomplete
        sessionID={props.sessionID}
        argumentAutocomplete={(command) => (command.id === "session.cd" ? "directory" : undefined)}
        directoryOptions={(query): AutocompleteOption[] => {
          if (query !== "") return []
          const projectID =
            (props.sessionID ? data.session.get(props.sessionID)?.projectID : undefined) ??
            data.location.info()?.project.id
          if (!projectID) return []
          return directoryRecents.list(projectID).map((item) => {
            const value = directoryRecentValue(item.directory, paths.home)
            return {
              display: value,
              value,
              description: "recent",
              isDirectory: true,
              path: value,
              absolute: item.directory,
              destructive: {
                id: item.directory,
                confirm: "Press ctrl+d to confirm",
                run: () => directoryRecents.remove(projectID, item.directory),
              },
            }
          })
        }}
        ref={(r) => {
          setAuto(() => r)
        }}
        anchor={() => anchor}
        input={() => input}
        setPrompt={(cb) => {
          setStore("prompt", produce(cb))
        }}
        setExtmark={(part, extmarkId) => {
          setStore("extmarkToPart", (map: Map<number, PromptPartRef>) => {
            const newMap = new Map(map)
            newMap.set(extmarkId, part)
            return newMap
          })
        }}
        value={store.prompt.text}
        fileStyleId={fileStyleId}
        agentStyleId={agentStyleId}
        skillStyleId={skillStyleId}
        hasSkill={(id) => store.prompt.skills?.some((skill) => skill.id === id) ?? false}
        promptPartTypeId={() => promptPartTypeId}
      />
    </>
  )
}
