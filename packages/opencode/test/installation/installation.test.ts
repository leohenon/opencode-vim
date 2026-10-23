import { describe, expect, test } from "bun:test"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Effect, Exit, Fiber, Layer, Sink, Stream } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import path from "path"

const encoder = new TextEncoder()
const npm = `https://registry.npmjs.org/${encodeURIComponent("@leohenon/ocv")}/latest`
const version = "1.99.9-ocv.4.13"
const v1Script = "https://raw.githubusercontent.com/leohenon/opencode-vim/ocv1/install.sh"
const v2Script = "https://raw.githubusercontent.com/leohenon/opencode-vim/ocv/install.sh"

type SpawnHandler = (
  cmd: string,
  args: readonly string[],
  options: ChildProcess.CommandOptions,
) => string | { code: number; stdout?: string; stderr?: string }

// A handler that returns undefined never responds.
function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response | undefined) {
  const client = HttpClient.make((request) => {
    expect(request.url).not.toContain("opencode.ai")
    expect(request.url).not.toContain("anomalyco")
    expect(request.url).not.toContain("opencode-ai")
    const response = handler(request)
    return response ? Effect.succeed(HttpClientResponse.fromWeb(request, response)) : Effect.never
  })
  return Layer.succeed(HttpClient.HttpClient, client)
}

function mockSpawner(handler: SpawnHandler = () => "") {
  const spawner = ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) throw new Error("Expected a standard command")
    expect(command.args.join(" ")).not.toContain("opencode-ai")
    expect(command.args.join(" ")).not.toContain("@opencode/cli")
    expect(command.args.join(" ")).not.toContain("anomalyco/tap")
    if (command.command === "brew") expect(command.args).not.toContain("opencode")
    const result = handler(command.command, command.args, command.options)
    const output = typeof result === "string" ? { code: 0, stdout: result, stderr: "" } : result
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: output.stdout ? Stream.make(encoder.encode(output.stdout)) : Stream.empty,
        stderr: output.stderr ? Stream.make(encoder.encode(output.stderr)) : Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function testLayer(
  httpHandler: (request: HttpClientRequest.HttpClientRequest) => Response | undefined,
  spawnHandler?: SpawnHandler,
) {
  const spawnerNode = makeGlobalNode({
    service: ChildProcessSpawner.ChildProcessSpawner,
    layer: mockSpawner(spawnHandler),
    deps: [],
  })
  return LayerNode.compile(Installation.node, [
    [httpClient, mockHttpClient(httpHandler)],
    [CrossSpawnSpawner.node, spawnerNode],
  ])
}

describe("installation", () => {
  test("retains legacy fork version and channel exports", () => {
    expect(Installation.VERSION).toBe(InstallationVersion)
    expect(Installation.CHANNEL).toBe(InstallationChannel)
    expect(Installation.MAJOR_INSTRUCTIONS).toBe("https://github.com/leohenon/opencode-vim/tree/ocv#installation")
  })

  describe("isUpdate", () => {
    test("only counts newer releases in the installed major version", () => {
      expect(Installation.isUpdate("1.19.0-ocv.4.13", "1.19.1-ocv.4.13")).toBe(true)
      expect(Installation.isUpdate("1.19.0-ocv.4.13", "1.20.0-ocv.4.13")).toBe(true)
      expect(Installation.isUpdate(version, version)).toBe(false)
      expect(Installation.isUpdate(version, "1.18.35-ocv.4.13")).toBe(false)
      expect(Installation.isUpdate(version, "2.0.0-ocv.4.13")).toBe(false)
      expect(Installation.isUpdate("1.9.0-ocv.4.13", "1.10.0-ocv.4.13")).toBe(true)
      expect(Installation.isUpdate("1.19.0-ocv.4.13", "1.19.0-ocv.4.14")).toBe(true)
    })

    test("compares preview builds within their channel", () => {
      expect(Installation.isUpdate("0.0.0-dev-202610110139", "0.0.0-dev-202610120000")).toBe(true)
      expect(Installation.isUpdate("0.0.0-dev-202610120000", "0.0.0-dev-202610110139")).toBe(false)
    })

    test("source builds only accept V1 releases", () => {
      expect(Installation.isUpdate("local", version)).toBe(true)
      expect(Installation.isUpdate("local", "2.0.0-ocv.4.13")).toBe(false)
      expect(Installation.isUpdate(version, "not-a-version")).toBe(false)
    })
  })

  describe("latest", () => {
    const choco = "https://community.chocolatey.org/api/v2/Packages"
    const registry = (found: string, calls: string[], feed: string[] = [found]) =>
      testLayer((request) => {
        calls.push(request.url)
        if (request.url.startsWith(choco))
          return jsonResponse({
            d: { results: feed.filter((v) => request.url.includes(`%27${v}%27`)).map((Version) => ({ Version })) },
          })
        return jsonResponse({ version: found })
      })

    const methods = ["curl", "yarn", "unknown", "npm", "bun", "pnpm", "scoop", "choco", "brew"] as const
    for (const method of methods) {
      const calls: string[] = []
      testEffect(registry(version, calls)).effect(`reads ${method} versions from OCV npm latest`, () =>
        Effect.gen(function* () {
          calls.length = 0
          expect(yield* Installation.use.latest(method)).toBe(version)
          expect(calls[0]).toBe(npm)
          expect(calls.slice(1).every((url) => url.startsWith(choco))).toBe(true)
        }),
      )

      for (const invalid of ["2.0.0-ocv.4.13", "1.18.35", "1.18.35-ocv.4.13\n", "1.18.35-ocv.4.13-extra"]) {
        testEffect(registry(invalid, [])).effect(
          `rejects registry version ${JSON.stringify(invalid)} for ${method}`,
          () =>
            Effect.gen(function* () {
              expect(Exit.isFailure(yield* Installation.use.latest(method).pipe(Effect.exit))).toBe(true)
            }),
        )
      }
    }

    for (const formula of ["leohenon/tap/ocv", "ocv"]) {
      const calls: string[] = []
      testEffect(
        testLayer(
          (request) => {
            calls.push(request.url)
            return jsonResponse({ version })
          },
          (cmd, args) => (cmd === "brew" && args.join(" ") === `list --formula ${formula}` ? "ocv" : ""),
        ),
      ).effect(`discovers V1 updates for brew ${formula} from npm`, () =>
        Effect.gen(function* () {
          calls.length = 0
          expect(yield* Installation.use.latest("brew")).toBe(version)
          expect(calls).toEqual([npm])
        }),
      )
    }

    testEffect(registry(version, [], ["1.19.1-ocv.4.13"])).effect(
      "waits until Chocolatey publishes the npm version",
      () =>
        Effect.gen(function* () {
          expect(yield* Installation.use.latest("choco")).toBe(InstallationVersion)
        }),
    )

    const errorCalls: string[] = []
    testEffect(
      testLayer((request) => {
        errorCalls.push(request.url)
        return new Response("unavailable", { status: 503 })
      }),
    ).live("fails when npm fails without consulting official OpenCode or GitHub releases", () =>
      Effect.gen(function* () {
        errorCalls.length = 0
        expect(Exit.isFailure(yield* Installation.use.latest("curl").pipe(Effect.exit))).toBe(true)
        expect(errorCalls.length).toBeGreaterThan(0)
        expect(errorCalls.every((url) => url === npm)).toBe(true)
      }),
    )

    testEffect(testLayer(() => jsonResponse({ name: "@leohenon/ocv" }))).effect(
      "rejects a missing registry version",
      () =>
        Effect.gen(function* () {
          expect(Exit.isFailure(yield* Installation.use.latest("npm").pipe(Effect.exit))).toBe(true)
        }),
    )

    testEffect(testLayer(() => undefined)).effect("times out when npm does not answer", () =>
      Effect.gen(function* () {
        const fiber = yield* Installation.use
          .latest("curl")
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
        yield* TestClock.adjust("10 seconds")
        expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true)
      }),
    )
  })

  describe("upgrade", () => {
    for (const method of ["npm", "pnpm", "bun", "yarn", "curl", "brew", "scoop", "choco", "unknown"] as const) {
      testEffect(
        testLayer(
          () => {
            throw new Error("Must not fetch for an invalid target")
          },
          () => {
            throw new Error("Must not spawn for an invalid target")
          },
        ),
      ).effect(`rejects non-V1 targets before side effects for ${method}`, () =>
        Effect.gen(function* () {
          for (const target of [
            "2.0.0-ocv.4.13",
            "2.0.27",
            "1.18.35",
            "latest",
            "1.18.35-ocv.4.13\n",
            "1.18.35-ocv.4.13-extra",
          ]) {
            const error = yield* Effect.flip(Installation.use.upgrade(method, target))
            expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
            expect(error.stderr).toContain("Expected a V1 OCV version")
          }
        }),
      )
    }

    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd) => (cmd === "npm" ? { code: 1, stderr: "token=secret command output" } : ""),
      ),
    ).effect("returns sanitized typed package errors", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(Installation.use.upgrade("npm", version))
        expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
        expect(error.stderr).toBe("Upgrade failed for npm (exit code 1).")
        expect(error.message).toBe(error.stderr)
        expect(error.stderr).not.toContain("secret")
      }),
    )

    testEffect(
      testLayer(
        (request) => {
          expect(request.url).toBe(v1Script)
          return new Response("install script with token=secret")
        },
        (cmd, args) => {
          if (cmd === "bash" && args[0] === "--version") return "GNU bash"
          if (cmd === "bash" || cmd === "sh") return { code: 1, stderr: "script output with token=secret" }
          return ""
        },
      ),
    ).effect("returns sanitized typed curl errors", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(Installation.use.upgrade("curl", version))
        expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
        expect(error.stderr).toBe("Upgrade failed for curl (exit code 1).")
        expect(error.message).toBe(error.stderr)
        expect(error.stderr).not.toContain("secret")
      }),
    )

    for (const shell of ["bash", "sh"]) {
      const calls: string[] = []
      testEffect(
        testLayer(
          (request) => {
            expect(request.url).toBe(v1Script)
            return new Response("echo v1")
          },
          (cmd, args, options) => {
            calls.push(cmd)
            if (cmd === "bash" && args[0] === "--version") return shell === "bash" ? "GNU bash" : { code: 1 }
            if (cmd === "bash" || cmd === "sh") {
              expect(cmd).toBe(shell)
              expect(options.env).toEqual({ OCV_VERSION: version, OCV_INSTALL_DIR: path.dirname(process.execPath) })
            }
            return ""
          },
        ),
      ).effect(`runs V1 curl with ${shell}, version and current install location`, () =>
        Effect.gen(function* () {
          calls.length = 0
          yield* Installation.use.upgrade("curl", version)
          expect(calls).toContain(shell)
        }),
      )
    }

    const packageCalls: string[] = []
    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd, args) => {
          packageCalls.push([cmd, ...args].join(" "))
          return ""
        },
      ),
    ).effect("targets only the fork with every package manager", () =>
      Effect.gen(function* () {
        for (const method of ["npm", "pnpm", "bun", "yarn"] as const) {
          packageCalls.length = 0
          yield* Installation.use.upgrade(method, version)
          expect(packageCalls[0]).toBe(
            `${method} ${method === "yarn" ? "global add" : "install -g"} @leohenon/ocv@${version}`,
          )
        }
      }),
    )

    for (const formula of ["leohenon/tap/ocv", "ocv"]) {
      const tap = (stable: string | undefined, calls: string[]) =>
        testLayer(
          () => jsonResponse({}),
          (cmd, args) => {
            calls.push([cmd, ...args].join(" "))
            if (args.join(" ") === `list --formula ${formula}`) return "ocv"
            if (args.join(" ") === "--repo leohenon/tap") return "/tmp/ocv-test-tap"
            if (args.includes("--json=v2")) return JSON.stringify({ formulae: [{ versions: { stable } }] })
            return ""
          },
        )
      const calls: string[] = []
      testEffect(tap(version, calls)).effect(`upgrades V1 brew formula ${formula} when available`, () =>
        Effect.gen(function* () {
          calls.length = 0
          yield* Installation.use.upgrade("brew", version)
          expect(calls).toContain(`brew info --json=v2 ${formula}`)
          expect(calls).toContain(`brew upgrade ${formula}`)
          expect(calls.includes("git pull --ff-only")).toBe(formula.includes("/"))
        }),
      )
      for (const stable of ["1.19.1-ocv.4.13", "2.0.0-ocv.4.13", undefined]) {
        const calls: string[] = []
        testEffect(tap(stable, calls)).effect(`waits for ${formula} when its version is ${stable}`, () =>
          Effect.gen(function* () {
            calls.length = 0
            const error = yield* Effect.flip(Installation.use.upgrade("brew", version))
            expect(error.stderr).toContain("Try again in a few minutes")
            expect(calls.some((call) => call.startsWith("brew upgrade"))).toBe(false)
          }),
        )
      }
    }
  })

  describe("upgradeMajor", () => {
    for (const method of ["npm", "pnpm", "bun", "yarn"] as const) {
      for (const failure of ["none", "remove", "install"] as const) {
        const calls: string[][] = []
        testEffect(
          testLayer(
            () => jsonResponse({}),
            (cmd, args) => {
              calls.push([cmd, ...args])
              if (failure === "remove" && calls.length === 1) return { code: 1 }
              if (failure === "install" && args.includes("@leohenon/ocv@ocv-v2")) return { code: 1 }
              return ""
            },
          ),
        ).effect(`${method} major upgrade with ${failure} failure stays on fork and rolls back`, () =>
          Effect.gen(function* () {
            calls.length = 0
            const outcome = yield* Installation.use.upgradeMajor(method).pipe(Effect.exit)
            expect(Exit.isFailure(outcome)).toBe(failure !== "none")
            expect(calls[0]).toEqual(
              method === "npm"
                ? [method, "uninstall", "-g", "@leohenon/ocv"]
                : method === "yarn"
                  ? [method, "global", "remove", "@leohenon/ocv"]
                  : [method, "remove", "-g", "@leohenon/ocv"],
            )
            if (failure === "remove") {
              expect(calls).toHaveLength(1)
              return
            }
            expect(calls[1]).toEqual(
              method === "pnpm"
                ? [method, "add", "-g", "--allow-build=@leohenon/ocv", "@leohenon/ocv@ocv-v2"]
                : method === "bun"
                  ? [method, "install", "-g", "--trust", "@leohenon/ocv@ocv-v2"]
                  : method === "yarn"
                    ? [method, "global", "add", "@leohenon/ocv@ocv-v2"]
                    : [method, "install", "-g", "@leohenon/ocv@ocv-v2"],
            )
            expect(calls).toHaveLength(failure === "install" ? 3 : 2)
            if (failure === "install")
              expect(calls[2]).toEqual(
                method === "yarn"
                  ? [method, "global", "add", `@leohenon/ocv@${InstallationVersion}`]
                  : [method, method === "pnpm" ? "add" : "install", "-g", `@leohenon/ocv@${InstallationVersion}`],
              )
          }),
        )
      }
    }

    for (const formula of ["leohenon/tap/ocv", "ocv"]) {
      for (const fail of [false, true]) {
        const calls: string[] = []
        testEffect(
          testLayer(
            () => jsonResponse({}),
            (cmd, args) => {
              calls.push([cmd, ...args].join(" "))
              if (args.join(" ") === `list --formula ${formula}`) return "ocv"
              if (fail && args.join(" ") === "install leohenon/tap/ocv-v2") return { code: 1 }
              return ""
            },
          ),
        ).effect(`brew major from ${formula}, failure=${fail}, preserves rollback`, () =>
          Effect.gen(function* () {
            calls.length = 0
            const outcome = yield* Installation.use.upgradeMajor("brew").pipe(Effect.exit)
            expect(Exit.isFailure(outcome)).toBe(fail)
            expect(calls.filter((call) => !call.startsWith("brew list"))).toEqual([
              `brew uninstall ${formula}`,
              "brew install leohenon/tap/ocv-v2",
              ...(fail ? [`brew install ${formula}`] : []),
            ])
          }),
        )
      }
    }

    const calls: string[] = []
    testEffect(
      testLayer(
        (request) => {
          expect(request.url).toBe(v2Script)
          return new Response("echo v2")
        },
        (cmd, args, options) => {
          calls.push(cmd)
          if (cmd === "bash" && args[0] === "--version") return "GNU bash"
          expect(args).toEqual(["-c", "echo v2"])
          expect(options.env).toEqual({ OCV_VERSION: "", OCV_INSTALL_DIR: path.dirname(process.execPath) })
          return ""
        },
      ),
    ).effect("curl major uses the fork V2 installer without forwarding a V1 version", () =>
      Effect.gen(function* () {
        calls.length = 0
        yield* Installation.use.upgradeMajor("curl")
        expect(calls).toEqual(["bash", "bash"])
      }),
    )

    for (const method of ["choco", "scoop", "unknown"] as const) {
      testEffect(
        testLayer(
          () => {
            throw new Error("Unexpected fetch")
          },
          () => {
            throw new Error("Unexpected spawn")
          },
        ),
      ).effect(`leaves unsupported major method ${method} untouched`, () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(Installation.use.upgradeMajor(method))
          expect(error.stderr).toContain(Installation.MAJOR_INSTRUCTIONS)
        }),
      )
    }
  })
})
