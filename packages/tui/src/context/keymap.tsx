import type {
  CopySelection,
  KeymapActive,
  KeymapCommand,
  KeymapLayer,
  KeymapPending,
} from "@opencode/plugin/tui/context"
import { InputRenderable, TextareaRenderable, type KeyEvent, type Renderable } from "@opentui/core"
import {
  stringifyKeyStroke,
  type Binding,
  type CommandContext,
  type KeyLike,
  type KeySequencePart,
} from "@opentui/keymap"
import {
  registerBackspacePopsPendingSequence,
  registerBaseLayoutFallback,
  registerCommaBindings,
  registerEscapeClearsPendingSequence,
  registerManagedTextareaLayer,
} from "@opentui/keymap/addons/opentui"
import { formatCommandBindings, formatKeySequence } from "@opentui/keymap/extras"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { KeymapProvider, useBindings, useKeymapSelector } from "@opentui/keymap/solid"
import { useRenderer } from "@opentui/solid"
import {
  createComputed,
  createContext,
  createMemo,
  createSignal,
  onCleanup,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js"
import { useConfig } from "../config"
import { TuiKeybind } from "../config/keybind"
import { resolveInteractivity, useInteractivity } from "./interactivity"

declare module "@opentui/keymap" {
  interface Command {
    opencode?: KeymapCommand
    slash?: {
      name: string
      aliases?: string[]
      arguments?: true
    }
  }
}

const MODE = { key: "opencode.mode", base: "base" } as const
const VIM_MODE_KEY = "opencode.vim.mode"
const COPY_SELECTION_KEY = "opencode.copy.selection"
type CopySelectionProvider = () => CopySelection | undefined
const VIM_WINDOW_TOKEN = "vim-window"
const CopyModeKeys = {
  enter: `<${VIM_WINDOW_TOKEN}>k,<${VIM_WINDOW_TOKEN}>ctrl+k`,
  toggle: `<${VIM_WINDOW_TOKEN}>w,<${VIM_WINDOW_TOKEN}><${VIM_WINDOW_TOKEN}>,<${VIM_WINDOW_TOKEN}>ctrl+w`,
  exit: `<${VIM_WINDOW_TOKEN}>j,<${VIM_WINDOW_TOKEN}>ctrl+j`,
} as const

type OpenTuiKeymap = Parameters<typeof KeymapProvider>[0]["keymap"]
type Mode = ReturnType<typeof createMode>
type KeymapConfig = {
  readonly keybinds: {
    get(command: string): readonly Binding<Renderable, KeyEvent>[]
  }
  readonly leader?: { readonly timeout: number }
  readonly leader_timeout?: number
}

export const COMMAND_PALETTE_COMMAND = "command.palette.show"

const Context = createContext<{
  readonly keymap: OpenTuiKeymap
  readonly config: KeymapConfig
  readonly mode: Mode
  readonly dispatch: (id: string, input?: string) => void
  readonly input: (id: string) => string | undefined
}>()

function Provider(props: ParentProps<{ config?: KeymapConfig }>) {
  const renderer = useRenderer()
  const config: KeymapConfig = props.config ?? useConfig().data
  const keymap = createDefaultOpenTuiKeymap(renderer)
  const mode = createMode(keymap)
  let invocation: { readonly id: string; readonly input?: string } | undefined
  const dispatch = (id: string, input?: string) => {
    const previous = invocation
    invocation = { id, input }
    try {
      keymap.dispatchCommand(id)
    } finally {
      invocation = previous
    }
  }
  const dispose = [
    registerCommaBindings(keymap),
    keymap.registerToken({ name: VIM_WINDOW_TOKEN, key: "ctrl+w" }),
    keymap.appendBindingExpander((context) => {
      const key = Object.entries({ enter: "return", esc: "escape", pgdown: "pagedown", pgup: "pageup" }).reduce(
        (result, [alias, value]) =>
          result.replace(new RegExp(`(^|[+,\\s>])${alias}(?=$|[+,\\s<])`, "gi"), `$1${value}`),
        context.input,
      )
      if (key === context.input) return
      return [{ key, displays: context.displays }]
    }),
    registerBaseLayoutFallback(keymap),
    registerEscapeClearsPendingSequence(keymap),
    registerBackspacePopsPendingSequence(keymap),
    registerManagedTextareaLayer(keymap, renderer, {
      enabled: () => {
        const editor = renderer.currentFocusedEditor
        const vim = keymap.getData(VIM_MODE_KEY)
        return (
          editor instanceof TextareaRenderable &&
          !(editor instanceof InputRenderable) &&
          vim !== "normal" &&
          vim !== "visual" &&
          vim !== "visual-line" &&
          vim !== "copy"
        )
      },
      bindings: [
        "input.move.left",
        "input.move.right",
        "input.move.up",
        "input.move.down",
        "input.select.left",
        "input.select.right",
        "input.select.up",
        "input.select.down",
        "input.line.home",
        "input.line.end",
        "input.select.line.home",
        "input.select.line.end",
        "input.visual.line.home",
        "input.visual.line.end",
        "input.select.visual.line.home",
        "input.select.visual.line.end",
        "input.buffer.home",
        "input.buffer.end",
        "input.select.buffer.home",
        "input.select.buffer.end",
        "input.delete.line",
        "input.delete.to.line.end",
        "input.delete.to.line.start",
        "input.backspace",
        "input.delete",
        "input.newline",
        "input.undo",
        "input.redo",
        "input.word.forward",
        "input.word.backward",
        "input.select.word.forward",
        "input.select.word.backward",
        "input.delete.word.forward",
        "input.delete.word.backward",
        "input.select.all",
        "input.submit",
      ].flatMap((command) => config.keybinds.get(command)),
    }),
  ]
  const leader = config.keybinds.get("leader")?.[0]?.key
  if (leader) {
    dispose.push(
      registerLeader(
        keymap,
        config.keybinds.get("leader"),
        config.leader?.timeout ?? ("leader_timeout" in config ? config.leader_timeout : undefined) ?? 2000,
      ),
    )
  }
  onCleanup(() => {
    dispose.reverse().forEach((item) => item())
    mode.dispose()
    keymap.setData(COPY_SELECTION_KEY, undefined)
  })
  return (
    <KeymapProvider keymap={keymap}>
      <Context.Provider
        value={{
          keymap,
          config,
          mode,
          dispatch,
          input: (id) => (invocation?.id === id ? invocation.input : undefined),
        }}
      >
        {props.children}
      </Context.Provider>
    </KeymapProvider>
  )
}

export type { KeymapCommand, KeymapLayer } from "@opencode/plugin/tui/context"

export interface Keymap {
  /** Dispatches a reachable command by ID. */
  dispatch(id: string, input?: string): void
  /** Controls mutually exclusive OpenCode input modes. */
  readonly mode: {
    /** Returns the active mode. */
    current(): string
    /** Pushes a mode until the returned cleanup is called. */
    push(mode: string): () => void
  }
  /** Publishes Vim's active mode for mode-scoped bindings. */
  readonly vim: {
    current(): string | undefined
    set(mode: string | undefined): void
    /** Registers a reactive publication until cleanup, suspended with its interactive scope. */
    register(mode: Accessor<string | undefined>, active?: Accessor<boolean>): () => void
  }
  readonly copy: {
    selection(): CopySelection | undefined
    register(provider: CopySelectionProvider): () => void
  }
  /** Registers a low-level keymap interceptor. */
  intercept: OpenTuiKeymap["intercept"]
  /** Returns whether an event matches the configured leader key. */
  isLeader(event: KeyEvent): boolean
}

function use(): Keymap {
  const value = useValue()
  const enabled = useInteractivity()
  const leader = value.config.keybinds.get("leader")?.[0]?.key
  const isLeader = leader ? value.keymap.createKeyMatcher(leader) : () => false
  let releaseVim: (() => void) | undefined
  onCleanup(() => releaseVim?.())
  return {
    dispatch(id, input) {
      value.dispatch(id, input)
    },
    mode: {
      current: value.mode.current,
      push: (mode) => value.mode.push(mode, resolveInteractivity(enabled)),
    },
    vim: {
      current: () => value.keymap.getData(VIM_MODE_KEY) as string | undefined,
      set(mode) {
        releaseVim?.()
        releaseVim = mode === undefined ? undefined : value.mode.registerVim(() => mode, enabled)
      },
      register(mode, active = () => true) {
        const scope = resolveInteractivity(enabled)
        return value.mode.registerVim(mode, () => scope() && active())
      },
    },
    copy: {
      selection: () => (value.keymap.getData(COPY_SELECTION_KEY) as CopySelectionProvider | undefined)?.(),
      register(provider) {
        value.keymap.setData(COPY_SELECTION_KEY, provider)
        let disposed = false
        return () => {
          if (disposed) return
          disposed = true
          if (value.keymap.getData(COPY_SELECTION_KEY) === provider) value.keymap.setData(COPY_SELECTION_KEY, undefined)
        }
      },
    },
    intercept: value.keymap.intercept.bind(value.keymap),
    isLeader,
  }
}

function createLayer(input: () => KeymapLayer) {
  const value = useValue()
  const enabled = useInteractivity()
  useBindings(() => {
    const layer = input()
    const { commands, bindings, mode, ...options } = layer
    const grouped = groupCommands(commands)
    return {
      ...options,
      enabled: enabled() ? options.enabled : false,
      ...(mode === "global" ? {} : { mode: mode ?? MODE.base }),
      commands: grouped.named.map((command) => {
        const { id, description, group, palette, bind, run, ...definition } = command
        return {
          ...definition,
          name: id,
          opencode: command,
          run: (context: CommandContext<Renderable, KeyEvent>) => run(value.input(id), context.event),
          ...(description === undefined ? {} : { desc: description }),
          ...(group === undefined ? {} : { category: group }),
          ...(palette === undefined ? {} : { namespace: "palette" }),
        }
      }),
      bindings: [
        ...grouped.inline.map((command) => ({
          key: command.bind,
          cmd: () => {
            if (command.enabled === false) return false
            if (typeof command.enabled === "function" && !command.enabled()) return false
            return command.run()
          },
          ...(command.title === undefined && command.description === undefined
            ? {}
            : { desc: command.title ?? command.description }),
          ...(command.group === undefined ? {} : { group: command.group }),
        })),
        ...grouped.named.flatMap((command) => {
          if (command.bind === false) return []
          const configured = value.config.keybinds.get(command.id)
          if (configured.length) return configured
          if (typeof command.bind !== "string") return []
          return [{ key: command.bind, cmd: command.id }]
        }),
        ...(bindings ?? []).flatMap((id) => value.config.keybinds.get(id)),
      ],
    }
  })
}

function groupCommands(commands: readonly KeymapCommand[] = []) {
  return commands.reduce(
    (result, command) => {
      if (command.id !== undefined) {
        if (!command.id) throw new Error("Keymap command IDs cannot be empty")
        if (typeof command.bind === "string" && !command.bind)
          throw new Error("Keymap command bindings cannot be empty")
        result.named.push({ ...command, id: command.id })
        return result
      }
      if (command.palette) throw new Error("Palette commands require an ID")
      if (command.slash) throw new Error("Slash commands require an ID")
      if (typeof command.bind !== "string") throw new Error("Inline keymap commands require bind")
      if (!command.bind) throw new Error("Keymap command bindings cannot be empty")
      result.inline.push({ ...command, id: undefined, bind: command.bind })
      return result
    },
    {
      named: [] as Array<KeymapCommand & { readonly id: string }>,
      inline: [] as Array<KeymapCommand & { readonly id?: undefined; readonly bind: string }>,
    },
  )
}

function useShortcuts() {
  const value = useValue()
  const shortcuts = useKeymapSelector((keymap) => {
    const commands = keymap.getCommands({ visibility: "registered" }).map((command) => command.name)
    const bindings = keymap.getCommandBindings({ visibility: "registered", commands })
    return new Map(
      commands.map((id) => {
        const current = bindings.get(id) ?? []
        return [
          id,
          {
            first: formatKeySequence(current[0]?.sequence, formatOptions(value.config)),
            all: formatCommandBindings(current, formatOptions(value.config)),
            list: current
              .map((binding) => formatKeySequence(binding.sequence, formatOptions(value.config)))
              .filter((shortcut): shortcut is string => shortcut !== undefined),
          },
        ]
      }),
    )
  })
  return {
    get(id: string) {
      return shortcuts().get(id)?.first
    },
    all(id: string) {
      return shortcuts().get(id)?.all
    },
    list(id: string) {
      return shortcuts().get(id)?.list ?? []
    },
  }
}

function useShortcut(id: string) {
  const shortcuts = useShortcuts()
  return () => shortcuts.get(id)
}

function useLeaderActive() {
  const pending = usePendingSequence()
  return () => pending()[0]?.tokenName === "leader"
}

function useCommands(): Accessor<readonly KeymapCommand[]> {
  const value = useValue()
  return useKeymapSelector((keymap) =>
    keymap
      .getCommandEntries({
        visibility: "reachable",
      })
      .map((entry) => {
        const command = entry.command.opencode ?? {
          id: entry.command.name,
          title: typeof entry.command.title === "string" ? entry.command.title : undefined,
          description: typeof entry.command.desc === "string" ? entry.command.desc : undefined,
          group: typeof entry.command.category === "string" ? entry.command.category : undefined,
          enabled:
            typeof entry.command.enabled === "boolean" || typeof entry.command.enabled === "function"
              ? (entry.command.enabled as boolean | (() => boolean))
              : undefined,
          palette: entry.command.namespace === "palette" ? true : undefined,
          slash: entry.command.slash,
          suggested:
            typeof entry.command.suggested === "boolean" || typeof entry.command.suggested === "function"
              ? (entry.command.suggested as boolean | (() => boolean))
              : undefined,
        }
        return {
          ...command,
          run: (input?: string) => {
            value.dispatch(entry.command.name, input)
          },
        }
      }),
  )
}

function usePendingSequence() {
  useValue()
  return useKeymapSelector((keymap) => keymap.getPendingSequence())
}

function useActiveKeys() {
  useValue()
  return useKeymapSelector((keymap) => keymap.getActiveKeys({ includeMetadata: true }))
}

function useState() {
  const value = useValue()
  const commands = useCommands()
  const pending = usePendingSequence()
  const active = useActiveKeys()
  return {
    commands,
    pending: (): readonly KeymapPending[] =>
      pending().map((item) => ({
        key: formatKeySequence([item], formatOptions(value.config)) ?? "",
        ...(item.tokenName ? { token: item.tokenName } : {}),
      })),
    active: (): readonly KeymapActive[] =>
      active().map((item) => ({
        key:
          formatKeySequence(
            [{ stroke: item.stroke, display: item.display, tokenName: item.tokenName }],
            formatOptions(value.config),
          ) ?? "",
        ...(typeof item.commandAttrs?.title === "string" ? { title: item.commandAttrs.title } : {}),
        ...(typeof item.bindingAttrs?.desc === "string"
          ? { description: item.bindingAttrs.desc }
          : typeof item.commandAttrs?.desc === "string"
            ? { description: item.commandAttrs.desc }
            : {}),
        ...(typeof item.commandAttrs?.category === "string"
          ? { group: item.commandAttrs.category }
          : typeof item.bindingAttrs?.group === "string"
            ? { group: item.bindingAttrs.group }
            : {}),
        continues: item.continues,
      })),
  }
}

function useValue() {
  const value = useContext(Context)
  if (!value) throw new Error("Keymap.Provider is missing")
  return value
}

export const Keymap = {
  CopyModeKeys,
  Provider,
  use,
  createLayer,
  validateCommands: (commands?: readonly KeymapCommand[]) => void groupCommands(commands),
  useShortcuts,
  useShortcut,
  useLeaderActive,
  useCommands,
  usePendingSequence,
  useActiveKeys,
  useState,
} as const

function createMode(keymap: OpenTuiKeymap) {
  const [stack, setStack] = createSignal<
    { readonly id: symbol; readonly mode: string; readonly enabled: Accessor<boolean> }[]
  >([])
  const [vim, setVim] = createSignal<
    { readonly id: symbol; readonly mode: Accessor<string | undefined>; readonly enabled: Accessor<boolean> }[]
  >([])
  createComputed(() =>
    keymap.setData(
      VIM_MODE_KEY,
      vim()
        .findLast((item) => item.enabled())
        ?.mode(),
    ),
  )
  const current = createMemo(() => stack().findLast((item) => item.enabled())?.mode ?? MODE.base)
  // Publish mode changes before another command can be dispatched in the same callback.
  createComputed(() => keymap.setData(MODE.key, current()))
  const unregisterLayerFields = keymap.registerLayerFields({
    mode(value, context) {
      context.require(MODE.key, value)
    },
  })
  const unregisterBindingFields = keymap.registerBindingFields({
    vimMode(value, context) {
      context.require(VIM_MODE_KEY, value)
    },
  })
  let disposed = false

  return {
    current,
    registerVim(mode: Accessor<string | undefined>, enabled: Accessor<boolean>) {
      if (disposed) return () => {}
      const id = Symbol("vim")
      setVim((items) => [...items, { id, mode, enabled }])
      return () => setVim((items) => items.filter((item) => item.id !== id))
    },
    push(mode: string, enabled: Accessor<boolean>) {
      if (disposed) return () => {}
      const id = Symbol(mode)
      // Inactive scopes retain their stack position beneath any newer modes.
      setStack((items) => [...items, { id, mode, enabled }])
      return () => {
        setStack((items) => items.filter((item) => item.id !== id))
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      setStack([])
      setVim([])
      unregisterBindingFields()
      unregisterLayerFields()
      keymap.setData(MODE.key, undefined)
      keymap.setData(VIM_MODE_KEY, undefined)
    },
  }
}

type LeaderBinding = Binding<Renderable, KeyEvent> & { vimMode?: unknown }
const SCOPED_LEADER_TOKEN_KEY = { name: "opencode-scoped-leader" } as const

function registerLeader(keymap: OpenTuiKeymap, input: readonly Binding<Renderable, KeyEvent>[], timeoutMs: number) {
  const bindings = input as readonly LeaderBinding[]
  const global = bindings.find((binding) => binding.vimMode === undefined)
  const scoped = bindings.filter((binding) => binding.vimMode === "normal")
  if (!global && scoped.length === 0) return () => {}

  const tokenKey: KeyLike = global?.key ?? SCOPED_LEADER_TOKEN_KEY
  const unregisterToken = keymap.registerToken({ name: "leader", key: tokenKey })
  const matchers = scoped.map((binding) => keymap.createKeyMatcher(binding.key))
  const unregisterScoped = matchers.length
    ? keymap.prependEventMatchResolver((event, context) => {
        if (keymap.getData(VIM_MODE_KEY) !== "normal") return
        if (!matchers.some((matches) => matches(event))) return
        return [context.resolveKey(tokenKey)]
      })
    : () => {}
  const matchesLeader = keymap.createKeyMatcher(tokenKey)
  let timer: ReturnType<typeof setTimeout> | undefined
  const clearTimer = () => {
    if (!timer) return
    clearTimeout(timer)
    timer = undefined
  }
  const sync = (sequence: readonly KeySequencePart[]) => {
    clearTimer()
    if (matchesLeader(sequence[0])) timer = setTimeout(() => keymap.clearPendingSequence(), timeoutMs)
  }
  const unregisterPending = keymap.on("pendingSequence", sync)
  sync(keymap.getPendingSequence())

  return () => {
    clearTimer()
    unregisterPending()
    unregisterScoped()
    unregisterToken()
  }
}

function formatOptions(config: KeymapConfig) {
  const leader = config.keybinds.get("leader")?.[0]?.key
  return {
    tokenDisplay: {
      leader: leader ? (typeof leader === "string" ? leader : stringifyKeyStroke(leader)) : TuiKeybind.LeaderDefault,
    },
    keyNameAliases: {
      up: "↑",
      down: "↓",
      left: "←",
      right: "→",
      pageup: "pgup",
      pagedown: "pgdn",
      delete: "del",
    },
    modifierAliases: {
      meta: "alt",
    },
  } as const
}
