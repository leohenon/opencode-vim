import { NodeFileSystem } from "@effect/platform-node"
import { Flock } from "@opencode/util/flock"
import { Global } from "@opencode/util/global"
import { Effect, FileSystem, Option, Schema } from "effect"
import { expect, test } from "bun:test"
import { parse } from "jsonc-parser"
import path from "path"
import { Config } from "../src/config"
import { tmpdir } from "./fixture/tmpdir"

function run<A, E>(directory: string, effect: Effect.Effect<A, E, Config.Service>) {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(Config.layer),
      Effect.provide(Global.layerWith({ config: directory, state: directory })),
      Effect.provide(NodeFileSystem.layer),
    ),
  )
}

test("generates reusable keybind schemas and preserves descriptions and numeric constraints", () => {
  const document = Schema.toJsonSchemaDocument(Config.Info)
  expect(document).toHaveProperty(["definitions", "TuiKeybind.BindingValue"])
  expect(document).toHaveProperty(["schema", "properties", "keybinds", "anyOf", 0, "properties", "app.exit"], {
    anyOf: [{ $ref: "#/$defs/TuiKeybind.BindingValue" }, { type: "null" }],
    description: "Exit the application",
  })
  expect(document).toHaveProperty(["schema", "properties", "scroll", "anyOf", 0, "properties", "speed", "anyOf", 0], {
    type: "number",
    minimum: 0.001,
  })
  expect(document).toHaveProperty(
    ["schema", "properties", "attention", "anyOf", 0, "properties", "volume", "anyOf", 0],
    { type: "number", minimum: 0, maximum: 1 },
  )
})

test("includes the published schema when creating cli.json", async () => {
  await using directory = await tmpdir()

  const config = await run(
    directory.path,
    Effect.gen(function* () {
      const service = yield* Config.Service
      return yield* service.update((draft) => {
        draft.animations = false
      })
    }),
  )

  expect(config).toEqual({ $schema: "https://opencode.ai/v2/cli.json", animations: false })
  expect(await Bun.file(path.join(directory.path, "cli.json")).json()).toEqual(config)
})

test("preserves the schema in an existing cli.json", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "cli.json")
  await Bun.write(file, JSON.stringify({ $schema: "https://opencode.ai/v2/cli.json", animations: true }))

  const config = await run(
    directory.path,
    Effect.gen(function* () {
      const service = yield* Config.Service
      return yield* service.update((draft) => {
        draft.animations = false
      })
    }),
  )

  expect(config).toEqual({ $schema: "https://opencode.ai/v2/cli.json", animations: false })
  expect(await Bun.file(file).json()).toEqual(config)
})

test("merges inline CLI config content over the global config", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "cli.json")
  const previous = process.env.OPENCODE_CLI_CONFIG_CONTENT
  await Bun.write(
    file,
    JSON.stringify({
      tabs: { mode: "on", scope: "global" },
      keybinds: { "app.exit": "ctrl+q" },
      plugins: ["global"],
      animations: true,
    }),
  )
  process.env.OPENCODE_CLI_CONFIG_CONTENT = JSON.stringify({
    tabs: { enabled: false },
    keybinds: { "help.show": false },
    plugins: ["inline"],
    animations: false,
  })

  try {
    const result = await run(
      directory.path,
      Effect.gen(function* () {
        const service = yield* Config.Service
        const loaded = yield* service.get()
        const updated = yield* service.update((draft) => {
          draft.animations = true
          draft.mouse = false
        })
        return { loaded, updated }
      }),
    )

    expect(result.loaded.tabs).toEqual({ mode: "off", scope: "global" })
    expect(result.loaded.keybinds).toEqual({ "app.exit": "ctrl+q", "help.show": false })
    expect(result.loaded.plugins).toEqual(["inline"])
    expect(result.updated).toMatchObject({ animations: false, mouse: false })
    expect(await Bun.file(file).json()).toMatchObject({ animations: true, mouse: false })
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CLI_CONFIG_CONTENT
    else process.env.OPENCODE_CLI_CONFIG_CONTENT = previous
  }
})

test("reads the legacy tabs toggle without rewriting it", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "cli.json")
  await Bun.write(file, JSON.stringify({ tabs: { enabled: false } }))

  const config = await run(
    directory.path,
    Effect.gen(function* () {
      const service = yield* Config.Service
      expect((yield* service.get()).tabs).toEqual({ mode: "off" })
      return yield* service.update((draft) => {
        draft.animations = false
      })
    }),
  )

  expect(config.tabs).toEqual({ mode: "off" })
  expect(await Bun.file(file).json()).toEqual({ tabs: { enabled: false }, animations: false })
})

test("explicitly imports only supported V1 TUI settings from separate XDG roots", async () => {
  await using directory = await tmpdir()
  const sourceConfig = path.join(directory.path, "xdg-config", "opencode")
  const sourceState = path.join(directory.path, "xdg-state", "opencode")
  const target = path.join(directory.path, "xdg-config", "ocv")
  await Bun.write(
    path.join(sourceConfig, "tui.jsonc"),
    `{
      // OCV imports this supported TUI setting only when requested.
      "vim": true,
      "theme": "legacy",
      "keybinds": { "prompt_copy_selection": "ctrl+y" },
      "credentials": { "token": "do-not-import" }
    }`,
  )
  await Bun.write(path.join(sourceState, "kv.json"), JSON.stringify({ animations_enabled: false, session: "ignore" }))
  await Bun.write(path.join(sourceConfig, "auth.json"), JSON.stringify({ token: "secret" }))
  await Bun.write(path.join(sourceState, "session.db"), "private session data")
  await Bun.write(path.join(target, "cli.json"), JSON.stringify({ mouse: false, theme: { mode: "dark" } }))

  const imported = await run(
    target,
    Effect.gen(function* () {
      const service = yield* Config.Service
      return yield* service.importV1({ config: sourceConfig, state: sourceState })
    }),
  )

  expect(imported?.info).toMatchObject({
    vim: true,
    animations: false,
    mouse: false,
    theme: { name: "legacy", mode: "dark" },
    keybinds: { "prompt.copy_selection": "ctrl+y" },
  })
  expect(imported?.info).not.toHaveProperty("credentials")
  expect(imported?.info).not.toHaveProperty("session.db")
  expect(await Bun.file(path.join(sourceConfig, "auth.json")).json()).toEqual({ token: "secret" })
  expect(await Bun.file(path.join(sourceState, "session.db")).text()).toBe("private session data")
})

test("migrates tui and kv config into cli.json", async () => {
  await using directory = await tmpdir()
  await Bun.write(
    path.join(directory.path, "tui.json"),
    JSON.stringify({
      theme: "legacy",
      keybinds: {
        leader: "ctrl+o",
        app_exit: "ctrl+q",
        app_heap_snapshot: "ctrl+h",
        input_paste: { key: "ctrl+v", preventDefault: false },
        session_delete: false,
        "dialog.select.next": "ctrl+n",
      },
      leader_timeout: 500,
      scroll_speed: 2,
      scroll_acceleration: { enabled: true },
      diff_style: "stacked",
      diff_viewer: { command: ["git", "difftool", "HEAD"] },
      mouse: false,
    }),
  )
  await Bun.write(
    path.join(directory.path, "kv.json"),
    JSON.stringify({
      theme_mode_lock: "light",
      attention_sound_pack: "custom.pack",
      diff_wrap_mode: "none",
      diff_viewer_show_file_tree: false,
      diff_viewer_single_patch: true,
      diff_viewer_view: "split",
      terminal_title_enabled: false,
      file_context_enabled: false,
      paste_summary_enabled: false,
      sidebar: "hide",
      scrollbar_visible: true,
      thinking_mode: "show",
      exploration_grouping: false,
      dismissed_getting_started: true,
      animations_enabled: false,
      skipped_version: "9.9.9",
      which_key_layout: "overlay",
    }),
  )

  const config = await run(
    directory.path,
    Effect.gen(function* () {
      const service = yield* Config.Service
      return yield* service.get()
    }),
  )

  expect(config).toMatchObject({
    $schema: "https://opencode.ai/v2/cli.json",
    theme: { name: "legacy", mode: "light" },
    keybinds: {
      leader: "ctrl+o",
      "app.exit": "ctrl+q",
      "prompt.paste": { key: "ctrl+v", preventDefault: false },
      "session.delete": false,
      "dialog.select.next": "ctrl+n",
    },
    leader: { timeout: 500 },
    scroll: { speed: 2, acceleration: true },
    attention: { sound_pack: "custom.pack" },
    diffs: { command: ["git", "difftool", "HEAD"], wrap: "none", tree: false, single: true, view: "split" },
    terminal: { title: false },
    prompt: { editor: false, paste: "full" },
    session: { sidebar: "hide", scrollbar: true, thinking: "show", grouping: "none" },
    animations: false,
    mouse: false,
  })
  expect(config).not.toHaveProperty("skipped_version")
  expect(config).not.toHaveProperty("which_key")
  expect(config).not.toHaveProperty("hints")
  expect((await Bun.file(path.join(directory.path, "cli.json")).json()).keybinds).toEqual({
    leader: "ctrl+o",
    "app.exit": "ctrl+q",
    "prompt.paste": { key: "ctrl+v", preventDefault: false },
    "session.delete": false,
    "dialog.select.next": "ctrl+n",
  })
  expect(await Bun.file(path.join(directory.path, "cli.json")).exists()).toBe(true)
  expect(await Bun.file(path.join(directory.path, "tui.json")).exists()).toBe(true)
  expect(await Bun.file(path.join(directory.path, "kv.json")).exists()).toBe(true)
})

test("migrates OCV Vim, prompt, and scoped keybind settings into cli.json", async () => {
  await using directory = await tmpdir()
  const legacy = {
    vim: false,
    vim_modal_input: false,
    vim_enter_submit: true,
    vim_insert_after_submit: true,
    vim_initial_mode: "normal",
    vim_system_clipboard_register: true,
    vim_langmap: { д: "l" },
    vim_line_motions: "display",
    vim_showbreak: true,
    vim_escape_sequence: "jk",
    prompt_max_height: 24,
    prompt_scrollbar: false,
    keybinds: {
      "vim.normal": {
        leader: "space",
        input_move_down: "j",
        input_move_up: [{ key: "k", preventDefault: false }],
      },
    },
  } as const
  await Bun.write(path.join(directory.path, "tui.json"), JSON.stringify(legacy))

  const config = await run(
    directory.path,
    Effect.gen(function* () {
      const service = yield* Config.Service
      return yield* service.get()
    }),
  )

  expect(config).toEqual({
    $schema: "https://opencode.ai/v2/cli.json",
    ...legacy,
    keybinds: {
      "vim.normal": {
        leader: "space",
        "input.move.down": "j",
        "input.move.up": [{ key: "k", preventDefault: false }],
      },
    },
  })
  expect(await Bun.file(path.join(directory.path, "cli.json")).json()).toEqual(config)
})

test("migrates the legacy nested prompt height", async () => {
  await using directory = await tmpdir()
  await Bun.write(path.join(directory.path, "tui.json"), JSON.stringify({ prompt: { max_height: 80 } }))

  const config = await run(
    directory.path,
    Effect.gen(function* () {
      const service = yield* Config.Service
      return yield* service.get()
    }),
  )

  expect(config.prompt_max_height).toBe(50)
  expect((await Bun.file(path.join(directory.path, "cli.json")).json()).prompt_max_height).toBe(50)
})

test("migrates before the first update and does not remigrate afterward", async () => {
  await using directory = await tmpdir()
  await Bun.write(path.join(directory.path, "tui.json"), JSON.stringify({ theme: "legacy" }))

  const config = await run(
    directory.path,
    Effect.gen(function* () {
      const service = yield* Config.Service
      yield* service.update((draft) => {
        draft.animations = false
        draft.mouse = false
      })
      yield* Effect.promise(() =>
        Bun.write(path.join(directory.path, "tui.json"), JSON.stringify({ theme: "changed" })),
      )
      return yield* service.get()
    }),
  )

  expect(config).toEqual({
    $schema: "https://opencode.ai/v2/cli.json",
    theme: { name: "legacy" },
    animations: false,
    mouse: false,
  })
  expect(await Bun.file(path.join(directory.path, "cli.json")).json()).toEqual({
    $schema: "https://opencode.ai/v2/cli.json",
    theme: { name: "legacy" },
    animations: false,
    mouse: false,
  })
})

test("preserves legacy cursor settings", async () => {
  await using directory = await tmpdir()
  await Bun.write(
    path.join(directory.path, "tui.json"),
    JSON.stringify({ cursor: { style: "underline", blinking: false } }),
  )

  const config = await run(
    directory.path,
    Effect.gen(function* () {
      const service = yield* Config.Service
      return yield* service.get()
    }),
  )

  expect(config.cursor).toEqual({ style: "underline", blinking: false })
  expect((await Bun.file(path.join(directory.path, "cli.json")).json()).cursor).toEqual({
    style: "underline",
    blinking: false,
  })
})

test("migrates legacy keybind names in an existing cli.json", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "cli.json")
  await Bun.write(
    file,
    `{
  // Preserve this comment
  "keybinds": {
    // Session list shortcut
    "session_list": "ctrl+l",
    "app_heap_snapshot": "ctrl+h",
    // Legacy delete shortcut
    "session_delete": "ctrl+d",
    // Canonical delete shortcut
    "session.delete": "ctrl+x",
    "app.heap_snapshot": "ctrl+shift+h"
  }
}
`,
  )

  const config = await run(
    directory.path,
    Effect.gen(function* () {
      const service = yield* Config.Service
      return yield* service.get()
    }),
  )

  expect(config.keybinds).toEqual({
    "session.list": "ctrl+l",
    "session.delete": "ctrl+x",
  })
  const text = await Bun.file(file).text()
  expect(text).toContain("// Preserve this comment")
  expect(text).toContain("// Session list shortcut")
  expect(text).toContain("// Legacy delete shortcut")
  expect(text).toContain("// Canonical delete shortcut")
  expect(parse(text).keybinds).toEqual({
    "session.list": "ctrl+l",
    "session.delete": "ctrl+x",
  })
})

test("migrates copy_on_select in an existing cli.json", async () => {
  for (const item of [
    { legacy: true, expected: "select" },
    { legacy: false, expected: "manual" },
    { legacy: true, copy: "manual", expected: "manual" },
  ] as const) {
    await using directory = await tmpdir()
    const file = path.join(directory.path, "cli.json")
    await Bun.write(
      file,
      `{
  // Preserve this comment
  "terminal": {
    ${item.copy === undefined ? "" : `"copy": ${JSON.stringify(item.copy)},`}
    "copy_on_select": ${item.legacy}
  }
}
`,
    )

    const config = await run(
      directory.path,
      Effect.gen(function* () {
        const service = yield* Config.Service
        return yield* service.get()
      }),
    )

    expect(config.terminal).toEqual({ copy: item.expected })
    const text = await Bun.file(file).text()
    expect(text).toContain("// Preserve this comment")
    expect(text).not.toContain("copy_on_select")
    expect(parse(text).terminal).toEqual({ copy: item.expected })
  }
})

test("uses migrated keybinds when persistence fails", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "cli.json")
  await Bun.write(file, `{"keybinds":{"session_list":"ctrl+l"}}`)
  const node = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)))
  const fs = new Proxy(node, {
    get(target, property, receiver) {
      if (property === "rename") return () => Effect.die(new Error("read-only config"))
      // oxlint-disable-next-line no-restricted-globals -- Proxy forwarding requires receiver-aware property access.
      return Reflect.get(target, property, receiver)
    },
  })

  const config = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* Config.Service
      return yield* service.get()
    }).pipe(
      Effect.provide(Config.layer),
      Effect.provide(Global.layerWith({ config: directory.path, state: directory.path })),
      Effect.provideService(FileSystem.FileSystem, fs),
    ),
  )

  expect(config.keybinds).toEqual({ "session.list": "ctrl+l" })
  expect(await Bun.file(file).json()).toEqual({ keybinds: { session_list: "ctrl+l" } })
  expect(await Array.fromAsync(new Bun.Glob("*.tmp").scan(directory.path))).toEqual([])
})

test("preserves the effective value when migrating duplicate legacy keybinds", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "cli.json")
  await Bun.write(file, `{"keybinds":{"session_delete":"ctrl+a","session_delete":"ctrl+b"}}`)

  const config = await run(
    directory.path,
    Effect.gen(function* () {
      const service = yield* Config.Service
      return yield* service.get()
    }),
  )

  expect(config.keybinds).toEqual({ "session.delete": "ctrl+b" })
  expect(parse(await Bun.file(file).text()).keybinds).toEqual({ "session.delete": "ctrl+b" })
})

test("migrates and updates the effective duplicate top-level keybinds", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "cli.json")
  await Bun.write(file, `{"keybinds":{"session_delete":"first"},"keybinds":{"session_delete":"last"}}`)

  const config = await run(
    directory.path,
    Effect.gen(function* () {
      const service = yield* Config.Service
      expect((yield* service.get()).keybinds).toEqual({ "session.delete": "last" })
      return yield* service.update((draft) => {
        draft.keybinds = { ...draft.keybinds, "session.delete": "changed" }
      })
    }),
  )

  expect(config.keybinds).toEqual({ "session.delete": "changed" })
  expect(parse(await Bun.file(file).text()).keybinds).toEqual({ "session.delete": "changed" })
})

test("serializes migration and updates across processes", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "cli.json")
  const started = path.join(directory.path, "started")
  const release = path.join(directory.path, "release")
  const migrateReady = path.join(directory.path, "migrate-ready")
  const updateReady = path.join(directory.path, "update-ready")
  await Bun.write(file, `{"keybinds":{"session_delete":"ctrl+d"}}`)
  const worker = path.join(import.meta.dir, "fixture/config-concurrency.ts")
  const migrate = Bun.spawn([process.execPath, worker, "migrate", directory.path, started, release, migrateReady], {
    stdout: "ignore",
    stderr: "pipe",
  })

  try {
    await waitForFile(started, migrate.exited)
    const update = Bun.spawn([process.execPath, worker, "update", directory.path, started, release, updateReady], {
      stdout: "ignore",
      stderr: "pipe",
    })
    try {
      await waitForFile(updateReady, update.exited)
      await Bun.write(release, "")
      const [migrateCode, updateCode] = await Promise.all([migrate.exited, update.exited])
      expect(await new Response(migrate.stderr).text()).toBe("")
      expect(await new Response(update.stderr).text()).toBe("")
      expect([migrateCode, updateCode]).toEqual([0, 0])
      expect(await Bun.file(file).json()).toEqual({ keybinds: { "session.delete": "ctrl+d" }, mouse: false })
    } finally {
      update.kill()
      await update.exited
    }
  } finally {
    await Bun.write(release, "")
    migrate.kill()
    await migrate.exited
  }
})

test("config reads remain interruptible while waiting for the file lock", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "cli.json")
  const locks = path.join(directory.path, "locks")
  const held = await Flock.acquire(file, { dir: locks })

  try {
    const service = await Effect.runPromise(
      Config.Service.pipe(
        Effect.provide(Config.layer),
        Effect.provide(Global.layerWith({ config: directory.path, state: directory.path })),
        Effect.provide(NodeFileSystem.layer),
      ),
    )
    const result = Effect.runPromise(service.get().pipe(Effect.timeoutOption("50 millis")))
    expect(await Promise.race([result, Bun.sleep(250).then(() => "blocked" as const)])).toEqual(Option.none())
  } finally {
    await held.release()
  }
})

test("updates effective duplicate canonical keybinds", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "cli.json")
  await Bun.write(
    file,
    `{"keybinds":{"session.delete":"first","session.delete":"last","opencode.settings":"off","opencode.settings":"on"}}`,
  )

  const config = await run(
    directory.path,
    Effect.gen(function* () {
      const service = yield* Config.Service
      expect((yield* service.get()).keybinds).toEqual({ "session.delete": "last", "opencode.settings": "on" })
      return yield* service.update((draft) => {
        draft.keybinds = { ...draft.keybinds, "session.delete": "changed", "opencode.settings": "changed" }
      })
    }),
  )

  expect(config.keybinds).toEqual({ "session.delete": "changed", "opencode.settings": "changed" })
  expect(parse(await Bun.file(file).text()).keybinds).toEqual({
    "session.delete": "changed",
    "opencode.settings": "changed",
  })
})

test("removes orphaned keybinds without deleting trailing comments", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "cli.json")
  await Bun.write(
    file,
    `{
  "keybinds": {
    "app_heap_snapshot": "ctrl+h" /* Keep legacy explanation */,
    "app.heap_snapshot": "ctrl+shift+h" /* Keep canonical explanation */,
  },
}
`,
  )

  const config = await run(
    directory.path,
    Effect.gen(function* () {
      const service = yield* Config.Service
      return yield* service.get()
    }),
  )

  expect(config.keybinds).toEqual({})
  const text = await Bun.file(file).text()
  expect(text).toContain("/* Keep legacy explanation */")
  expect(text).toContain("/* Keep canonical explanation */")
  expect(parse(text).keybinds).toEqual({})
})

test("updates a config draft while preserving JSONC comments", async () => {
  await using directory = await tmpdir()
  await Bun.write(path.join(directory.path, "cli.json"), '{\n  // Keep this comment\n  "animations": true\n}\n')

  const config = await run(
    directory.path,
    Effect.gen(function* () {
      const service = yield* Config.Service
      return yield* service.update((draft) => {
        draft.prompt = { paste: "compact" }
        draft.mini = {
          thinking: "hide",
          shell_output: "hide",
          turn_summary: "hide",
          splash: "hide",
          work_spinner: "block-low-comet",
          mono: true,
        }
      })
    }),
  )

  expect(config).toEqual({
    animations: true,
    prompt: { paste: "compact" },
    mini: {
      thinking: "hide",
      shell_output: "hide",
      turn_summary: "hide",
      splash: "hide",
      work_spinner: "block-low-comet",
      mono: true,
    },
  })
  expect(await Bun.file(path.join(directory.path, "cli.json")).text()).toContain("// Keep this comment")
})

async function waitForFile(file: string, exited: Promise<number>) {
  const found = await Promise.race([
    (async () => {
      while (!(await Bun.file(file).exists())) await Bun.sleep(10)
      return true
    })(),
    exited.then(() => false),
    Bun.sleep(5000).then(() => false),
  ])
  if (!found) throw new Error(`timed out waiting for ${file}`)
}
