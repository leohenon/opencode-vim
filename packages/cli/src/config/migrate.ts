export * as ConfigMigration from "./migrate"

import { TuiConfigV1 } from "@opencode/tui/config/v1"
import { TuiKeybind } from "@opencode/tui/config/v1/keybind"
import { Definitions } from "@opencode/tui/config/keybind"
import { Effect, FileSystem, Option, Schema } from "effect"
import { randomUUID } from "crypto"
import { applyEdits, createScanner, modify, parse, parseTree, type Node, type ParseError } from "jsonc-parser"
import path from "path"
import { Info, SchemaURL } from "./schema"

const decodeV1 = Schema.decodeUnknownOption(TuiConfigV1.Info)
const decodeInfo = Schema.decodeUnknownOption(Info)
const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Any))
const LegacyKeybindTargets = new Set<string>(Object.values(TuiKeybind.CommandMap))

export const run = Effect.fn("cli.config.migrate")(function* (input: {
  readonly file: string
  readonly config: string
  readonly state: string
}) {
  const fs = yield* FileSystem.FileSystem
  const persist = Effect.fnUntraced(function* (text: string, info: Info) {
    const temp = `${input.file}.${process.pid}.${randomUUID()}.tmp`
    const cause = yield* Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(input.file), { recursive: true })
      yield* fs.writeFileString(temp, text, { mode: 0o600 })
      yield* fs.rename(temp, input.file)
    }).pipe(
      Effect.as(undefined),
      Effect.catchCause((cause) => Effect.succeed(cause)),
      Effect.ensuring(fs.remove(temp).pipe(Effect.ignore)),
    )
    return cause === undefined ? { info } : { info, cause }
  })

  if (yield* fs.exists(input.file).pipe(Effect.orElseSucceed(() => false))) {
    const text = yield* fs.readFileString(input.file)
    const errors: ParseError[] = []
    const value: any = parse(text, errors, { allowTrailingComma: true })
    if (errors.length) return
    const config = Option.getOrUndefined(decodeRecord(value))
    if (config === undefined) return
    const terminal = Option.getOrUndefined(decodeRecord(config.terminal))
    const legacyCopy = terminal?.copy_on_select
    const copy =
      typeof legacyCopy === "boolean" && terminal?.copy === undefined ? (legacyCopy ? "select" : "manual") : undefined
    const renamed =
      typeof legacyCopy !== "boolean"
        ? text
        : [
            ...(copy === undefined ? [] : [{ path: ["terminal", "copy"], value: copy }]),
            { path: ["terminal", "copy_on_select"], value: undefined },
          ].reduce(
            (text, edit) =>
              applyEdits(
                text,
                modify(text, edit.path, edit.value, { formattingOptions: { tabSize: 2, insertSpaces: true } }),
              ),
            text,
          )
    const keybinds = Option.getOrUndefined(decodeRecord(config.keybinds))
    const scoped = Option.getOrUndefined(decodeRecord(keybinds?.["vim.normal"]))
    const updated =
      keybinds === undefined ? renamed : migrateKeybinds(migrateKeybinds(renamed, keybinds), scoped, "vim.normal")
    if (updated === text) return
    const updatedErrors: ParseError[] = []
    const info = Option.getOrUndefined(decodeInfo(parse(updated, updatedErrors, { allowTrailingComma: true })))
    if (updatedErrors.length || info === undefined) return
    return yield* persist(updated, info)
  }

  const legacyValue = yield* readJsonCandidates([
    path.join(input.config, "tui.json"),
    path.join(input.config, "tui.jsonc"),
  ])
  const legacy = Option.getOrUndefined(decodeV1(legacyValue?.value))
  const kv = yield* readJson(path.join(input.state, "kv.json"))
  const values = migrateV1(legacy, kv ?? {})
  if (!Object.keys(values).length) return
  const migrated = { ...(SchemaURL ? { $schema: SchemaURL } : {}), ...values }

  const result = yield* persist(JSON.stringify(migrated, null, 2) + "\n", migrated)
  if (result.cause === undefined)
    yield* Effect.logInfo("migrated cli config", {
      from: [legacyValue?.file, kv === undefined ? undefined : path.join(input.state, "kv.json")].filter(Boolean),
      to: input.file,
    })
  return result
})

function migrateKeybinds(text: string, bindings: Record<string, unknown> | undefined, scope?: string) {
  if (!bindings) return text
  return Object.keys(bindings).reduce(
    (text, name) => {
      const target =
        TuiKeybind.CommandMap[name as keyof typeof TuiKeybind.CommandMap] ??
        (name in Definitions || LegacyKeybindTargets.has(name) ? name : undefined)
      if (target === undefined) return text
      const properties = findKeybindProperties(text, name, scope)
      if (!properties.length) return text
      const remove = !(target in Definitions) || (target !== name && target in bindings)
      // The effective duplicate wins, at both global and Vim-normal scope.
      const cleaned = properties.slice(0, remove ? properties.length : -1).reduce((text) => {
        const property = findKeybindProperties(text, name, scope)[0]
        return property === undefined ? text : removeProperty(text, property)
      }, text)
      if (remove || target === name) return cleaned
      const key = findKeybindProperties(cleaned, name, scope)[0]?.children?.[0]
      if (key === undefined) return text
      return cleaned.slice(0, key.offset) + JSON.stringify(target) + cleaned.slice(key.offset + key.length)
    },
    findKeybindObjects(text, scope)
      .slice(0, -1)
      .reduce((text) => {
        const property = findKeybindObjects(text, scope)[0]
        return property === undefined ? text : removeProperty(text, property)
      }, text),
  )
}

function findKeybindProperties(text: string, name: string, scope?: string) {
  const keybinds = findKeybindObjects(text, scope).at(-1)?.children?.[1]
  return keybinds?.children?.filter((property) => property.children?.[0]?.value === name) ?? []
}

function findKeybindObjects(text: string, scope?: string) {
  const tree = parseTree(text)
  const bindings = tree?.children?.filter((property) => property.children?.[0]?.value === "keybinds") ?? []
  if (scope === undefined) return bindings
  return bindings.at(-1)?.children?.[1]?.children?.filter((property) => property.children?.[0]?.value === scope) ?? []
}

function removeProperty(text: string, property: Node) {
  const properties = property.parent?.children ?? []
  const index = properties.indexOf(property)
  const end = property.offset + property.length
  const next = properties[index + 1]
  if (next) {
    const comma = findComma(text, end, next.offset)
    if (comma !== undefined) return text.slice(0, property.offset) + text.slice(end, comma) + text.slice(comma + 1)
  }
  const previous = properties[index - 1]
  if (previous) {
    const comma = findComma(text, previous.offset + previous.length, property.offset)
    if (comma !== undefined) return text.slice(0, comma) + text.slice(comma + 1, property.offset) + text.slice(end)
  }
  const comma = findComma(text, end, (property.parent?.offset ?? 0) + (property.parent?.length ?? 0))
  if (comma !== undefined) return text.slice(0, property.offset) + text.slice(end, comma) + text.slice(comma + 1)
  return text.slice(0, property.offset) + text.slice(end)
}

function findComma(text: string, start: number, end: number) {
  const scanner = createScanner(text, false)
  scanner.setPosition(start)
  while (true) {
    scanner.scan()
    const offset = scanner.getTokenOffset()
    if (scanner.getTokenLength() === 0 || offset >= end) return
    if (text[offset] === ",") return offset
  }
}

export const readV1 = Effect.fn("cli.config.read-v1")(function* (input: {
  readonly config: string
  readonly state: string
}) {
  const legacy = yield* readJsonCandidates([path.join(input.config, "tui.json"), path.join(input.config, "tui.jsonc")])
  const kvFile = path.join(input.state, "kv.json")
  const kv = yield* readJson(kvFile)
  const info = migrateV1(Option.getOrUndefined(decodeV1(legacy?.value)), kv ?? {})
  const sources = [legacy?.file, kv === undefined ? undefined : kvFile].filter((file): file is string => !!file)
  return Object.keys(info).length ? { info, sources } : undefined
})

export function mergeV1(target: Record<string, any>, source: Record<string, any>) {
  for (const [key, value] of Object.entries(source)) {
    if (isRecord(target[key]) && isRecord(value)) mergeV1(target[key], value)
    else target[key] = value
  }
}

export function migrateV1(legacy: TuiConfigV1.Info | undefined, kv: Record<string, any>): Info {
  const plugins = [
    ...(legacy?.plugin?.map((plugin) =>
      typeof plugin === "string" ? plugin : { package: plugin[0], options: plugin[1] },
    ) ?? []),
    ...Object.entries(legacy?.plugin_enabled ?? {}).map(([id, enabled]) => (enabled ? id : `-${id}`)),
  ]
  const themeName = legacy?.theme ?? kv.theme
  const themeMode = kv.theme_mode_lock
  const attentionSoundPack = kv.attention_sound_pack
  const diffView = kv.diff_viewer_view ?? (legacy?.diff_style === "stacked" ? "unified" : undefined)
  const thinking =
    kv.thinking_mode ?? (kv.thinking_visibility === undefined ? undefined : kv.thinking_visibility ? "show" : "hide")
  const keybinds =
    legacy?.keybinds === undefined
      ? undefined
      : {
          ...Object.fromEntries(
            Object.entries(legacy.keybinds).flatMap(([name, value]) => {
              if (name === "vim.normal") return []
              const target = TuiKeybind.CommandMap[name as keyof typeof TuiKeybind.CommandMap] ?? name
              if (!(target in Definitions)) return []
              return [[target, value]]
            }),
          ),
          ...(legacy.keybinds["vim.normal"]
            ? {
                "vim.normal": Object.fromEntries(
                  Object.entries(legacy.keybinds["vim.normal"]).flatMap(([name, value]) => {
                    const target = TuiKeybind.CommandMap[name as keyof typeof TuiKeybind.CommandMap] ?? name
                    if (!(target in Definitions)) return []
                    return [[target, value]]
                  }),
                ),
              }
            : {}),
        }

  return {
    ...(themeName !== undefined || themeMode !== undefined
      ? {
          theme: {
            ...(themeName === undefined ? {} : { name: themeName }),
            ...(themeMode === undefined ? {} : { mode: themeMode }),
          },
        }
      : {}),
    ...(keybinds === undefined ? {} : { keybinds }),
    ...(plugins.length ? { plugins } : {}),
    ...(legacy?.leader_timeout === undefined ? {} : { leader: { timeout: legacy.leader_timeout } }),
    ...(legacy?.scroll_speed === undefined && legacy?.scroll_acceleration?.enabled === undefined
      ? {}
      : {
          scroll: {
            ...(legacy.scroll_speed === undefined ? {} : { speed: legacy.scroll_speed }),
            ...(legacy.scroll_acceleration?.enabled === undefined
              ? {}
              : { acceleration: legacy.scroll_acceleration.enabled }),
          },
        }),
    ...(legacy?.attention === undefined && attentionSoundPack === undefined
      ? {}
      : {
          attention: {
            ...(legacy?.attention === undefined
              ? {}
              : {
                  notifications: (legacy.attention.enabled ?? false) && (legacy.attention.notifications ?? true),
                  sound: (legacy.attention.enabled ?? false) && (legacy.attention.sound ?? true),
                  ...(legacy.attention.volume === undefined ? {} : { volume: legacy.attention.volume }),
                  ...(legacy.attention.sound_pack === undefined ? {} : { sound_pack: legacy.attention.sound_pack }),
                  ...(legacy.attention.sounds === undefined ? {} : { sounds: legacy.attention.sounds }),
                }),
            ...(attentionSoundPack === undefined ? {} : { sound_pack: attentionSoundPack }),
          },
        }),
    ...(legacy?.diff_style === undefined &&
    legacy?.diff_viewer === undefined &&
    kv.diff_wrap_mode === undefined &&
    kv.diff_viewer_show_file_tree === undefined &&
    kv.diff_viewer_single_patch === undefined &&
    diffView === undefined
      ? {}
      : {
          diffs: {
            ...(legacy?.diff_viewer === undefined ? {} : { command: legacy.diff_viewer.command }),
            ...(kv.diff_wrap_mode === undefined ? {} : { wrap: kv.diff_wrap_mode }),
            ...(kv.diff_viewer_show_file_tree === undefined ? {} : { tree: kv.diff_viewer_show_file_tree }),
            ...(kv.diff_viewer_single_patch === undefined ? {} : { single: kv.diff_viewer_single_patch }),
            ...(diffView === undefined ? {} : { view: diffView }),
          },
        }),
    ...(kv.terminal_title_enabled === undefined ? {} : { terminal: { title: kv.terminal_title_enabled } }),
    ...(kv.file_context_enabled === undefined && kv.paste_summary_enabled === undefined
      ? {}
      : {
          prompt: {
            ...(kv.file_context_enabled === undefined ? {} : { editor: kv.file_context_enabled }),
            ...(kv.paste_summary_enabled === undefined
              ? {}
              : { paste: kv.paste_summary_enabled ? ("compact" as const) : ("full" as const) }),
          },
        }),
    ...(kv.sidebar === undefined &&
    kv.scrollbar_visible === undefined &&
    thinking === undefined &&
    kv.exploration_grouping === undefined
      ? {}
      : {
          session: {
            ...(kv.sidebar === undefined ? {} : { sidebar: kv.sidebar }),
            ...(kv.scrollbar_visible === undefined ? {} : { scrollbar: kv.scrollbar_visible }),
            ...(thinking === undefined ? {} : { thinking }),
            ...(kv.exploration_grouping === undefined
              ? {}
              : { grouping: kv.exploration_grouping ? ("auto" as const) : ("none" as const) }),
          },
        }),
    ...(kv.animations_enabled === undefined ? {} : { animations: kv.animations_enabled }),
    ...(legacy?.mouse === undefined ? {} : { mouse: legacy.mouse }),
    ...(legacy?.cursor === undefined ? {} : { cursor: legacy.cursor }),
    ...(typeof kv.input_vim_mode === "boolean"
      ? { vim: kv.input_vim_mode }
      : legacy?.vim === undefined
        ? {}
        : { vim: legacy.vim }),
    ...(typeof kv.ui_minimal === "boolean" ? { ui_minimal: kv.ui_minimal } : {}),
    ...(legacy?.vim_modal_input === undefined ? {} : { vim_modal_input: legacy.vim_modal_input }),
    ...(legacy?.vim_enter_submit === undefined ? {} : { vim_enter_submit: legacy.vim_enter_submit }),
    ...(legacy?.vim_insert_after_submit === undefined
      ? {}
      : { vim_insert_after_submit: legacy.vim_insert_after_submit }),
    ...(legacy?.vim_initial_mode === undefined ? {} : { vim_initial_mode: legacy.vim_initial_mode }),
    ...(legacy?.vim_system_clipboard_register === undefined
      ? {}
      : { vim_system_clipboard_register: legacy.vim_system_clipboard_register }),
    ...(legacy?.vim_langmap === undefined ? {} : { vim_langmap: legacy.vim_langmap }),
    ...(legacy?.vim_line_motions === undefined ? {} : { vim_line_motions: legacy.vim_line_motions }),
    ...(legacy?.vim_showbreak === undefined ? {} : { vim_showbreak: legacy.vim_showbreak }),
    ...(legacy?.vim_escape_sequence === undefined ? {} : { vim_escape_sequence: legacy.vim_escape_sequence }),
    ...(legacy?.prompt_max_height === undefined && legacy?.prompt?.max_height === undefined
      ? {}
      : { prompt_max_height: legacy.prompt_max_height ?? Math.min(50, legacy.prompt!.max_height!) }),
    ...(legacy?.prompt_scrollbar === undefined ? {} : { prompt_scrollbar: legacy.prompt_scrollbar }),
  }
}

const readJsonCandidates = Effect.fnUntraced(function* (targets: readonly string[]) {
  for (const file of targets) {
    const value = yield* readJson(file)
    if (value !== undefined) return { file, value }
  }
})

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const readJson = Effect.fnUntraced(function* (target: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(target).pipe(Effect.orElseSucceed(() => undefined))
  if (text === undefined) return undefined
  const errors: ParseError[] = []
  const value: any = parse(text, errors, { allowTrailingComma: true })
  if (errors.length) return undefined
  return Option.getOrUndefined(decodeRecord(value))
})
