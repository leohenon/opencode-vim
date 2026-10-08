export * as TuiConfig from "."

import { createBindingLookup } from "@opentui/keymap/extras"
import { Schema } from "effect"
import { createContext, type JSX, useContext } from "solid-js"
import { TuiKeybind } from "./keybind"

export const AttentionSoundName = Schema.Literals([
  "default",
  "question",
  "permission",
  "error",
  "done",
  "subagent_done",
])
export type AttentionSoundName = Schema.Schema.Type<typeof AttentionSoundName>

export const PluginOptions = Schema.Record(Schema.String, Schema.Unknown)
export const PluginSpec = Schema.Union([Schema.String, Schema.mutable(Schema.Tuple([Schema.String, PluginOptions]))])

export const LeaderTimeoutDefault = 2000
export const LeaderTimeout = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
  description: "Leader key timeout in milliseconds",
})

export const ScrollSpeed = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0.001))
export const ScrollAcceleration = Schema.Struct({
  enabled: Schema.Boolean.annotate({ description: "Enable scroll acceleration" }),
}).annotate({ description: "Scroll acceleration settings" })
export const DiffStyle = Schema.Literals(["auto", "stacked"]).annotate({
  description: "Control diff rendering style: 'auto' adapts to terminal width, 'stacked' always shows single column",
})
export const DiffViewer = Schema.Struct({
  command: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
}).annotate({
  description: "External diff viewer command. The first item is the executable and remaining items are arguments",
})
export const Cursor = Schema.Struct({
  style: Schema.optional(Schema.Literals(["block", "underline", "line", "default"])).annotate({
    description: "Cursor shape. Use 'default' to preserve the terminal setting",
  }),
  blinking: Schema.optional(Schema.Boolean).annotate({
    description: "Whether the cursor blinks. Has no effect when style is 'default'",
  }),
}).annotate({ description: "Terminal cursor settings" })

const VimLangmapCharacter = Schema.String.check(Schema.isPattern(/^.$/u)).annotate({
  description: "A single Vim langmap character",
})

export const VimLangmap = Schema.Record(VimLangmapCharacter, VimLangmapCharacter).annotate({
  description: "Map keyboard-layout characters to Vim command keys in normal, visual, and copy modes",
})

export const VimInitialMode = Schema.Literals(["normal", "insert"]).annotate({
  description: "Initial Vim mode for the prompt",
})
export type VimInitialMode = Schema.Schema.Type<typeof VimInitialMode>

export const VimLineMotions = Schema.Literals(["logical", "display_vertical", "display"]).annotate({
  description: "Use logical lines, display lines for j/k only, or display lines for j/k and 0/^/$ Vim motions",
})
export type VimLineMotions = Schema.Schema.Type<typeof VimLineMotions>

export const VimShowbreak = Schema.Boolean.annotate({
  description: "Show a marker in the prompt gutter for wrapped rows",
})

const PromptMaxHeight = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(50)).annotate({
  description: "Maximum number of rows the prompt input expands to",
})

export const AttentionSounds = Schema.Record(AttentionSoundName, Schema.optionalKey(Schema.String))
export type AttentionSoundPaths = Schema.Schema.Type<typeof AttentionSounds>
export const Attention = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  notifications: Schema.optional(Schema.Boolean),
  sound: Schema.optional(Schema.Boolean),
  volume: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1))),
  sound_pack: Schema.optional(Schema.String),
  sounds: Schema.optional(AttentionSounds),
}).annotate({ description: "Attention notification and sound settings" })

const PromptSize = Schema.Int.check(Schema.isGreaterThan(0))
export const Prompt = Schema.Struct({
  max_height: Schema.optional(PromptMaxHeight).annotate({ description: "Prompt textarea max height" }),
  max_width: Schema.optional(Schema.Union([PromptSize, Schema.Literal("auto")])).annotate({
    description: "Home prompt max width: a positive integer for a fixed cap, or 'auto' to scale with terminal width",
  }),
}).annotate({ description: "Prompt size settings" })

export const Info = Schema.Struct({
  $schema: Schema.optional(Schema.String),
  theme: Schema.optional(Schema.String),
  keybinds: Schema.optional(TuiKeybind.KeybindOverrides),
  plugin: Schema.optional(Schema.Array(PluginSpec)),
  plugin_enabled: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  leader_timeout: Schema.optional(LeaderTimeout),
  attention: Schema.optional(Attention),
  prompt: Schema.optional(Prompt),
  scroll_speed: Schema.optional(ScrollSpeed).annotate({ description: "TUI scroll speed" }),
  scroll_acceleration: Schema.optional(ScrollAcceleration),
  diff_style: Schema.optional(DiffStyle),
  diff_viewer: Schema.optional(DiffViewer),
  cursor: Schema.optional(Cursor),
  vim: Schema.optional(Schema.Boolean).annotate({ description: "Enable vim-style input for the prompt" }),
  vim_modal_input: Schema.optional(Schema.Boolean).annotate({
    description: "Enable Vim-style modal controls for command palette and small dialog inputs",
  }),
  prompt_max_height: Schema.optional(PromptMaxHeight),
  prompt_scrollbar: Schema.optional(Schema.Boolean).annotate({ description: "Show a scrollbar for the prompt input" }),
  vim_enter_submit: Schema.optional(Schema.Boolean).annotate({
    description: "Submit prompt with Enter in vim insert and replace modes",
  }),
  vim_insert_after_submit: Schema.optional(Schema.Boolean).annotate({
    description: "Return prompt to Vim insert mode after submitting",
  }),
  vim_initial_mode: Schema.optional(VimInitialMode),
  vim_system_clipboard_register: Schema.optional(Schema.Boolean).annotate({
    description: "Use the system clipboard instead of Vim's internal register for yank and paste",
  }),
  vim_langmap: Schema.optional(VimLangmap),
  vim_line_motions: Schema.optional(VimLineMotions),
  vim_showbreak: Schema.optional(VimShowbreak),
  vim_escape_sequence: Schema.optional(Schema.String.check(Schema.isPattern(/^.{2}$/u))).annotate({
    description: "Two-character sequence to exit vim insert mode (e.g., 'jk')",
  }),
  mouse: Schema.optional(Schema.Boolean).annotate({ description: "Enable or disable mouse capture (default: true)" }),
})
export type Info = Schema.Schema.Type<typeof Info>

export type Resolved = Omit<Info, "attention" | "keybinds" | "leader_timeout" | "mouse" | "cursor" | "vim_showbreak"> & {
  attention: {
    enabled: boolean
    notifications: boolean
    sound: boolean
    volume: number
    sound_pack: string
    sounds: AttentionSoundPaths
  }
  keybinds: TuiKeybind.BindingLookupView
  leader_timeout: number
  mouse: boolean
  cursor?: {
    style: "block" | "underline" | "line" | "default"
    blinking: boolean
  }
  vim_showbreak: boolean
}

export const ResolveOptions = Schema.Struct({
  terminalSuspend: Schema.Boolean,
})
export type ResolveOptions = Schema.Schema.Type<typeof ResolveOptions>

export function resolve(input: Info, options: ResolveOptions): Resolved {
  const keybinds: TuiKeybind.KeybindOverrides = { ...input.keybinds }
  if (!options.terminalSuspend) {
    keybinds.terminal_suspend = "none"
    if (keybinds.input_undo === undefined) {
      const inputUndo = TuiKeybind.defaultValue("input_undo")
      keybinds.input_undo = ["ctrl+z", ...(typeof inputUndo === "string" ? inputUndo.split(",") : [])]
        .filter((value, index, values) => values.indexOf(value) === index)
        .join(",")
    }
  }

  return {
    ...input,
    attention: {
      enabled: input.attention?.enabled ?? false,
      notifications: input.attention?.notifications ?? true,
      sound: input.attention?.sound ?? true,
      volume: input.attention?.volume ?? 0.4,
      sound_pack: input.attention?.sound_pack ?? "opencode.default",
      sounds: input.attention?.sounds ?? {},
    },
    keybinds: createBindingLookup(TuiKeybind.toBindingConfig(TuiKeybind.parse(keybinds)), {
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    }),
    leader_timeout: input.leader_timeout ?? LeaderTimeoutDefault,
    mouse: input.mouse ?? true,
    cursor: input.cursor
      ? {
          style: input.cursor.style ?? "block",
          blinking: input.cursor.blinking ?? true,
        }
      : undefined,
    vim_modal_input: input.vim_modal_input ?? true,
    vim_line_motions: input.vim_line_motions ?? "logical",
    vim_showbreak: input.vim_showbreak ?? false,
  }
}

const ConfigContext = createContext<Resolved>()

export function TuiConfigProvider(props: { config: Resolved; children: JSX.Element }) {
  return <ConfigContext.Provider value={props.config}>{props.children}</ConfigContext.Provider>
}

export function useTuiConfig() {
  const value = useContext(ConfigContext)
  if (!value) throw new Error("TuiConfigProvider is missing")
  return value
}
