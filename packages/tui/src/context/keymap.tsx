import type { KeymapActive, KeymapCommand, KeymapLayer, KeymapPending } from "@opencode/plugin/tui/context"
import { InputRenderable, TextareaRenderable, type KeyEvent, type Renderable } from "@opentui/core"
import {
  stringifyKeyStroke,
  type Binding,
  type CommandContext,
  type KeyLike,
  type Keymap as OpentuiKeymap,
  type KeymapEvent,
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

// ocv: copy mode runs the session transcript as a vim window. The window token
// lets the fork bind the same commands under ctrl+w as under the leader key.
export const VIM_WINDOW_TOKEN = "vim-window"
export const OPENCODE_COPY_MODE = "copy"
export const OPENCODE_VIM_MODE_KEY = "opencode.vim.mode"
// ocv: the prompt enters, toggles and leaves copy mode through the window
// token, so the same keys work with or without a leader prefix.
export const OPENCODE_COPY_MODE_ENTER_KEYS = `<${VIM_WINDOW_TOKEN}>k,<${VIM_WINDOW_TOKEN}>ctrl+k`
export const OPENCODE_COPY_MODE_TOGGLE_KEYS = `<${VIM_WINDOW_TOKEN}>w,<${VIM_WINDOW_TOKEN}><${VIM_WINDOW_TOKEN}>,<${VIM_WINDOW_TOKEN}>ctrl+w`
export const OPENCODE_COPY_MODE_EXIT_KEYS = `<${VIM_WINDOW_TOKEN}>j,<${VIM_WINDOW_TOKEN}>ctrl+j`

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
        return editor instanceof TextareaRenderable && !(editor instanceof InputRenderable)
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
  // ocv: the leader key can be scoped to an input mode, so it is registered
  // through the fork's own leader registration instead of the plain addon.
  dispose.push(registerOpencodeLeader(keymap, config))
  // ocv: the vim window token makes ctrl+w a prefix for the same commands the
  // leader key reaches, so copy mode can be entered and left from the prompt.
  dispose.push(keymap.registerToken({ name: VIM_WINDOW_TOKEN, key: "ctrl+w" }))
  // ocv: bindings may declare a vim mode. They stay inactive until the prompt
  // publishes the matching mode through the vim mode data key.
  dispose.push(
    keymap.registerBindingFields({
      vimMode(value, ctx) {
        ctx.require(OPENCODE_VIM_MODE_KEY, value)
      },
    }),
  )
  onCleanup(() => {
    dispose.reverse().forEach((item) => item())
    mode.dispose()
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

// ocv: the leader key can be bound per input mode. A binding scoped to
// "vim.normal" only becomes the leader key while the prompt is in vim normal
// mode, so the same physical key can lead different commands per mode.
type LeaderBinding = Binding<Renderable, KeyEvent> & { vimMode?: unknown }

const SCOPED_LEADER_TOKEN_KEY = { name: "opencode-scoped-leader" } as const

export function registerOpencodeLeader<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: OpentuiKeymap<TTarget, TEvent>,
  config: {
    readonly keybinds: { get(command: string): readonly Binding<Renderable, KeyEvent>[] }
    readonly leader?: { readonly timeout: number }
    readonly leader_timeout?: number
  },
) {
  const bindings = config.keybinds.get("leader") as readonly LeaderBinding[]
  const global = bindings.find((binding) => binding.vimMode === undefined)
  const scoped = bindings.filter((binding) => binding.vimMode === "normal")
  if (!global && scoped.length === 0) return () => {}

  const tokenKey = global?.key ?? SCOPED_LEADER_TOKEN_KEY
  const offToken = keymap.registerToken({ name: "leader", key: tokenKey })
  const offScoped = scoped.length
    ? registerScopedLeaderMatches(keymap, tokenKey, scoped.map((binding) => binding.key))
    : () => {}
  const offTimeout = registerLeaderTimeout(
    keymap,
    tokenKey,
    config.leader?.timeout ?? ("leader_timeout" in config ? config.leader_timeout : undefined) ?? 2000,
  )

  return () => {
    offTimeout()
    offScoped()
    offToken()
  }
}

function registerScopedLeaderMatches<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: OpentuiKeymap<TTarget, TEvent>,
  tokenKey: KeyLike,
  triggers: readonly KeyLike[],
) {
  const matchers = triggers.map((trigger) => keymap.createKeyMatcher(trigger))
  return keymap.prependEventMatchResolver((event, ctx) => {
    if (keymap.getData(OPENCODE_VIM_MODE_KEY) !== "normal") return
    if (!matchers.some((matches) => matches(event))) return
    return [ctx.resolveKey(tokenKey)]
  })
}

function registerLeaderTimeout<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: OpentuiKeymap<TTarget, TEvent>,
  tokenKey: KeyLike,
  timeoutMs: number,
) {
  const matchesLeader = keymap.createKeyMatcher(tokenKey)
  let timeout: ReturnType<typeof setTimeout> | undefined

  function clearTimer() {
    if (!timeout) return
    clearTimeout(timeout)
    timeout = undefined
  }

  function sync(sequence: readonly KeySequencePart[]) {
    if (matchesLeader(sequence[0])) {
      clearTimer()
      timeout = setTimeout(() => keymap.clearPendingSequence(), timeoutMs)
      return
    }
    clearTimer()
  }

  const offPendingSequence = keymap.on("pendingSequence", sync)
  sync(keymap.getPendingSequence())

  return () => {
    clearTimer()
    offPendingSequence()
  }
}

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
  /** Registers a low-level keymap interceptor. */
  intercept: OpenTuiKeymap["intercept"]
  /** Returns whether an event matches the configured leader key. */
  isLeader(event: KeyEvent): boolean
  /** Reads and writes keymap scoped data. */
  readonly data: {
    get(key: string): unknown
    set(key: string, value: unknown): void
  }
}

function use(): Keymap {
  const value = useValue()
  const enabled = useInteractivity()
  const leader = value.config.keybinds.get("leader")?.[0]?.key
  const isLeader = leader ? value.keymap.createKeyMatcher(leader) : () => false
  return {
    dispatch(id, input) {
      value.dispatch(id, input)
    },
    mode: {
      current: value.mode.current,
      push: (mode) => value.mode.push(mode, resolveInteractivity(enabled)),
    },
    intercept: value.keymap.intercept.bind(value.keymap),
    isLeader,
    data: {
      get: (key) => value.keymap.getData(key),
      set: (key, data) => value.keymap.setData(key, data),
    },
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
  const current = createMemo(() => stack().findLast((item) => item.enabled())?.mode ?? MODE.base)
  // Publish mode changes before another command can be dispatched in the same callback.
  createComputed(() => keymap.setData(MODE.key, current()))
  const unregister = keymap.registerLayerFields({
    mode(value, context) {
      context.require(MODE.key, value)
    },
  })
  let disposed = false

  return {
    current,
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
      unregister()
      keymap.setData(MODE.key, undefined)
    },
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
