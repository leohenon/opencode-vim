import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@opencode/util/global"
import { TuiConfigV1 } from "@opencode/tui/config/v1"
import { Effect, Schema } from "effect"
import { expect, test } from "bun:test"
import path from "node:path"
import { Config } from "../src/config"
import { ConfigMigration } from "../src/config/migrate"
import { tmpdir } from "./fixture/tmpdir"

const decodeV1 = Schema.decodeUnknownSync(TuiConfigV1.Info)

test("imports current V1 navigation, plugin, conceal and which-key overrides in both scopes", () => {
  const bindings = {
    copy_mode: "ctrl+v",
    session_child_cycle: "alt+l",
    session_child_cycle_reverse: "alt+h",
    plugin_manager: "ctrl+p",
    messages_toggle_conceal: "ctrl+h",
    which_key_toggle: "alt+k",
    which_key_layout_toggle: "alt+shift+k",
    which_key_pending_toggle: "alt+p",
    which_key_group_previous: "alt+left",
    which_key_group_next: "alt+right",
    which_key_scroll_up: "alt+up",
    which_key_scroll_down: "alt+down",
    which_key_page_up: "alt+pageup",
    which_key_page_down: "alt+pagedown",
    which_key_home: "alt+home",
    which_key_end: "alt+end",
  }
  const expected = {
    "session.copy_mode": "ctrl+v",
    "session.child.next": "alt+l",
    "session.child.previous": "alt+h",
    "plugins.list": "ctrl+p",
    "session.toggle.conceal": "ctrl+h",
    "which-key.toggle": "alt+k",
    "which-key.layout.toggle": "alt+shift+k",
    "which-key.pending.toggle": "alt+p",
    "which-key.group.previous": "alt+left",
    "which-key.group.next": "alt+right",
    "which-key.scroll.up": "alt+up",
    "which-key.scroll.down": "alt+down",
    "which-key.page.up": "alt+pageup",
    "which-key.page.down": "alt+pagedown",
    "which-key.home": "alt+home",
    "which-key.end": "alt+end",
  }
  const legacy = decodeV1({ keybinds: { ...bindings, "vim.normal": { leader: "space", ...bindings } } })
  expect(ConfigMigration.migrateV1(legacy, {}).keybinds).toEqual({
    ...expected,
    "vim.normal": { leader: "space", ...expected },
  })
})

test("imports persisted Vim and minimal-UI toggles without enabling absent preferences", () => {
  expect(ConfigMigration.migrateV1(decodeV1({ vim: true }), { input_vim_mode: false, ui_minimal: true })).toEqual({
    vim: false,
    ui_minimal: true,
  })
  expect(ConfigMigration.migrateV1(undefined, { input_vim_mode: true, ui_minimal: false })).toEqual({
    vim: true,
    ui_minimal: false,
  })
  expect(ConfigMigration.migrateV1(undefined, {})).toEqual({})
})

test.each([
  { attention: { enabled: true }, notifications: true, sound: true },
  { attention: { enabled: false, notifications: true, sound: true }, notifications: false, sound: false },
  { attention: { enabled: true, notifications: false, sound: true }, notifications: false, sound: true },
  { attention: { sound: true }, notifications: false, sound: false },
])("preserves V1 attention master-switch semantics: $attention", ({ attention, notifications, sound }) => {
  const result = ConfigMigration.migrateV1(decodeV1({ attention: { ...attention, volume: 0.2 } }), {})
  expect(result.attention).toEqual({ notifications, sound, volume: 0.2 })
  expect(result.attention).not.toHaveProperty("enabled")
})

test("renames legacy bindings inside an existing Vim-normal scope without losing comments or canonical precedence", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "cli.json")
  await Bun.write(
    file,
    `{
    "keybinds": {
      "app_exit": "ctrl+q",
      "vim.normal": {
        // Keep this scope and its comments.
        "which_key_toggle": "alt+k",
        "session_child_cycle": "alt+l",
        "input_move_left": "h",
        "input.move.left": "left",
        "input_move_right": "old",
        "input_move_right": "l"
      }
    }
  }`,
  )
  const config = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* Config.Service
      return yield* service.get()
    }).pipe(
      Effect.provide(Config.layer),
      Effect.provide(Global.layerWith({ config: directory.path, state: directory.path })),
      Effect.provide(NodeFileSystem.layer),
    ),
  )
  expect(config.keybinds).toEqual({
    "app.exit": "ctrl+q",
    "vim.normal": {
      "which-key.toggle": "alt+k",
      "session.child.next": "alt+l",
      "input.move.left": "left",
      "input.move.right": "l",
    },
  })
  const text = await Bun.file(file).text()
  expect(text).toContain("// Keep this scope and its comments.")
  expect(text).not.toContain("which_key_toggle")
  expect(text).not.toContain('"old"')
})
