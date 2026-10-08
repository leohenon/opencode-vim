/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { Schema } from "effect"
import {
  AttentionSoundName,
  Info,
  LeaderTimeoutDefault,
  PluginSpec,
  resolve,
  TuiConfigProvider,
  type Info as TuiConfigInfo,
  useTuiConfig,
} from "../src/config"
import { TuiKeybind } from "../src/config/keybind"

const decodeInfo = Schema.decodeUnknownSync(Info)
const decodePlugin = Schema.decodeUnknownSync(PluginSpec)

test("defines package-owned plugin specs and attention sound names", () => {
  expect(decodePlugin("example-plugin")).toBe("example-plugin")
  expect(decodePlugin(["example-plugin", { enabled: true }])).toEqual(["example-plugin", { enabled: true }])
  expect(() => decodePlugin(["example-plugin"])).toThrow()
  expect(AttentionSoundName.literals).toEqual(["default", "question", "permission", "error", "done", "subagent_done"])
})

test("validates config constraints", () => {
  expect(
    decodeInfo({
      leader_timeout: 250,
      attention: { volume: 1, sounds: { done: "done.wav" } },
      prompt: { max_height: 10, max_width: "auto" },
      scroll_speed: 0.001,
      diff_style: "stacked",
      diff_viewer: { command: ["git", "difftool", "--no-prompt", "HEAD"] },
      cursor: { blinking: false },
      plugin: ["example-plugin"],
    }),
  ).toMatchObject({
    leader_timeout: 250,
    attention: { volume: 1 },
    diff_style: "stacked",
    diff_viewer: { command: ["git", "difftool", "--no-prompt", "HEAD"] },
    cursor: { blinking: false },
  })
  expect(() => decodeInfo({ leader_timeout: 0 })).toThrow()
  expect(() => decodeInfo({ attention: { volume: 1.1 } })).toThrow()
  expect(() => decodeInfo({ prompt: { max_width: 0 } })).toThrow()
  expect(() => decodeInfo({ scroll_speed: 0 })).toThrow()
  expect(() => decodeInfo({ diff_viewer: { command: [] } })).toThrow()
  expect(() => decodeInfo({ diff_viewer: { command: "git difftool" } })).toThrow()
  expect(() => decodeInfo({ cursor: { style: "beam" } })).toThrow()
  expect(decodeInfo({ attention: { sounds: { unknown: "sound.wav" } } })).toEqual({ attention: { sounds: {} } })
  expect(decodeInfo({ keybinds: { "vim.normal": { input_move_down: "j" } } })).toEqual({
    keybinds: { "vim.normal": { input_move_down: "j" } },
  })
  expect(() => decodeInfo({ keybinds: { "vim.normal": "j" } })).toThrow()
  expect(decodeInfo({ vim_showbreak: true })).toEqual({ vim_showbreak: true })
  expect(() => decodeInfo({ vim_showbreak: "↪ " })).toThrow()
})

test("drops unknown keybinds without hiding invalid known scopes", () => {
  const keybinds = TuiKeybind.dropUnknown({
    not_a_real_keybind: "ctrl+q",
    "vim.normal": "j",
    "vim.unknown": { input_move_down: "j" },
  })

  expect(keybinds).toEqual({ "vim.normal": "j" })
  expect(() => decodeInfo({ keybinds })).toThrow()
})

test("resolves host-neutral defaults", () => {
  const config = resolve({}, { terminalSuspend: true })

  expect(config.attention).toEqual({
    enabled: false,
    notifications: true,
    sound: true,
    volume: 0.4,
    sound_pack: "opencode.default",
    sounds: {},
  })
  expect(config.leader_timeout).toBe(LeaderTimeoutDefault)
  expect(config.mouse).toBe(true)
  expect(config.vim_showbreak).toBe(false)
  expect(config.keybinds.has("terminal.suspend")).toBe(true)
  expect(config.keybinds.has("session.list")).toBe(true)
  expect(config.cursor).toBeUndefined()
})

test("resolves overrides without mutating input", () => {
  const input: TuiConfigInfo = {
    theme: "custom",
    mouse: false,
    leader_timeout: 750,
    attention: {
      enabled: true,
      notifications: false,
      sound: false,
      volume: 0.8,
      sound_pack: "custom.pack",
      sounds: { question: "/sounds/question.wav" },
    },
    keybinds: { session_list: "ctrl+l" },
    cursor: { blinking: false },
  }
  const config = resolve(input, { terminalSuspend: true })

  expect(config).toMatchObject({
    theme: "custom",
    mouse: false,
    leader_timeout: 750,
    attention: input.attention,
    cursor: { style: "block", blinking: false },
  })
  expect(config.keybinds.get("session.list")).toHaveLength(1)
  expect(input.keybinds).toEqual({ session_list: "ctrl+l" })
})

test("resolves a session move keybind", () => {
  const config = resolve({ keybinds: { session_move: "ctrl+o" } }, { terminalSuspend: true })

  expect(config.keybinds.get("session.move")).toMatchObject([{ key: "ctrl+o" }])
})

test("resolves vim normal leader without default global leader", () => {
  const config = resolve({ keybinds: { "vim.normal": { leader: "space" } } }, { terminalSuspend: true })

  expect(config.keybinds.get("leader")).toMatchObject([{ key: "space", cmd: "leader", vimMode: "normal" }])
})

test("resolves vim mode-scoped keybinds", () => {
  const config = resolve(
    {
      keybinds: {
        input_move_down: "down",
        "vim.normal": {
          input_move_down: "j",
          input_move_up: [{ key: "k", preventDefault: false }],
        },
      },
    },
    { terminalSuspend: true },
  )

  expect(config.keybinds.get("input.move.down")).toMatchObject([
    { key: "down", cmd: "input.move.down" },
    { key: "j", cmd: "input.move.down", vimMode: "normal" },
  ])
  expect(config.keybinds.get("input.move.up")).toMatchObject([
    { key: "up", cmd: "input.move.up" },
    { key: "k", cmd: "input.move.up", vimMode: "normal", preventDefault: false },
  ])
})

test("vim mode-scoped keybinds re-enable a globally disabled command", () => {
  const config = resolve(
    {
      keybinds: {
        input_move_down: "none",
        "vim.normal": {
          input_move_down: "j",
        },
      },
    },
    { terminalSuspend: true },
  )

  expect(config.keybinds.get("input.move.down")).toMatchObject([{ key: "j", cmd: "input.move.down", vimMode: "normal" }])
})

test("disables suspend and assigns ctrl+z to undo when unsupported", () => {
  const config = resolve({}, { terminalSuspend: false })

  expect(config.keybinds.has("terminal.suspend")).toBe(false)
  expect(config.keybinds.get("input.undo")).toMatchObject([{ key: "ctrl+z,ctrl+-,super+z" }])
})

test("preserves an explicit undo binding when suspend is unsupported", () => {
  const config = resolve({ keybinds: { input_undo: "ctrl+u", terminal_suspend: "ctrl+s" } }, { terminalSuspend: false })

  expect(config.keybinds.has("terminal.suspend")).toBe(false)
  expect(config.keybinds.get("input.undo")).toHaveLength(1)
  expect(config.keybinds.get("input.undo")).toMatchObject([{ key: "ctrl+u" }])
})

test("provides resolved config through Solid context", async () => {
  const config = resolve({ theme: "custom" }, { terminalSuspend: true })

  function Consumer() {
    const value = useTuiConfig()
    return <text>{`${value.theme} ${value.mouse} ${value.leader_timeout}`}</text>
  }

  const app = await testRender(() => (
    <TuiConfigProvider config={config}>
      <Consumer />
    </TuiConfigProvider>
  ))
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(`custom true ${LeaderTimeoutDefault}`)
  } finally {
    app.renderer.destroy()
  }
})

test("requires the config provider", () => {
  expect(() => useTuiConfig()).toThrow("TuiConfigProvider is missing")
})
