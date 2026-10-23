import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { EffectFlock } from "@opencode/util/effect-flock"
import { OPENCODE_ARTIFACT, OPENCODE_CHANNEL, OPENCODE_LOCAL, OPENCODE_VERSION } from "../version"
import { Context, Duration, Effect, FileSystem, Layer, Option, Ref, Schema } from "effect"
import { ChildProcess } from "effect/process"
import { parse, type ParseError } from "jsonc-parser"
import path from "node:path"
import { stripVTControlCharacters } from "node:util"
import { RetainedImage } from "./retained-image"
import { action, parseReleaseVersion, type Policy } from "./updater-action"
import { errorMessage } from "../util/error"
import {
  CLI_NAME,
  DISPLAY_NAME,
  HOMEBREW_FORMULA,
  INSTALLER_URL,
  NPM_DIST_TAG,
  PACKAGE_NAME,
  PRODUCT_NAME,
} from "@opencode/util/identity"

export const methods = ["curl", "npm", "pnpm", "bun", "yarn", "vp", "brew", "winget"] as const

export type Method = (typeof methods)[number]
export type RunResult = { readonly type: "available" | "installed"; readonly version: string }
export type CheckResult = RunResult | { readonly type: "unavailable"; readonly message: string }

export class UpgradeError extends Error {
  readonly title: string
  readonly detail: string
  readonly command?: string
  readonly retry: string

  constructor(
    input: {
      readonly title: string
      readonly detail: string
      readonly command?: string
      readonly retry: string
    },
    options?: ErrorOptions,
  ) {
    super(input.detail, options)
    this.name = "UpgradeError"
    this.title = input.title
    this.detail = input.detail
    this.command = input.command
    this.retry = input.retry
  }
}

const decodeVpPackages = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String }))),
)

const installNames: Record<Method, string> = {
  curl: `The ${DISPLAY_NAME} installer`,
  npm: "npm",
  pnpm: "pnpm",
  bun: "Bun",
  yarn: "Yarn",
  vp: "Vite+",
  brew: "Homebrew",
  winget: "WinGet",
}

const wingetPackage = "Anomaly.OpenCode"
const wingetArgs = [
  "--id",
  wingetPackage,
  "--exact",
  "--source",
  "winget",
  "--accept-source-agreements",
  "--disable-interactivity",
]

function conciseDetail(input: string) {
  const lines = stripVTControlCharacters(input)
    .trim()
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
  const tail = lines.slice(-12).join("\n")
  const clipped = tail.length > 2_000
  const detail = clipped ? `…${tail.slice(-1_999)}` : tail
  if (!detail) return
  if (lines.length <= 12 && !clipped) return detail
  return `${detail}\n\nOutput shortened to the last 12 lines.`
}

function errorDetail(cause: unknown): string {
  if (cause instanceof AppProcess.AppProcessError) {
    const stderr = conciseDetail(cause.stderr ?? "")
    if (stderr) return stderr
    if (cause.cause !== undefined) return errorDetail(cause.cause)
    return cause.message
  }
  if (cause instanceof Error) {
    const detail = cause.cause === undefined ? undefined : errorDetail(cause.cause)
    if (!detail || detail === cause.message) return cause.message
    return `${cause.message}: ${detail}`
  }
  return errorMessage(cause)
}

function resultDetail(result: { code: number; stdout: string; stderr: string }) {
  return (
    conciseDetail(result.stderr) ??
    conciseDetail(result.stdout) ??
    `The command exited with code ${result.code} without any error output.`
  )
}

export interface Interface {
  readonly run: (onInstall?: (version: string) => void) => Effect.Effect<RunResult | undefined>
  readonly check: () => Effect.Effect<CheckResult | undefined, Error>
  readonly apply: (version: string) => Effect.Effect<void, Error>
  readonly method: () => Effect.Effect<Method | undefined>
  readonly latest: (method?: Method) => Effect.Effect<string, Error>
  readonly upgrade: (method: Method, version: string) => Effect.Effect<void, Error>
  readonly removal: (
    method: Method,
  ) => { readonly command: ReadonlyArray<string>; readonly run: Effect.Effect<void, Error> } | undefined
}

export class Service extends Context.Service<Service, Interface>()("@opencode/cli/Updater") {}

export function ownsPackage(name: string) {
  if (PRODUCT_NAME === "opencode") return /^@opencode(?:-ai)?\/cli(?:-node)?$/.test(name)
  return name === PACKAGE_NAME
}

export function updatePackage(method: Method) {
  if (method === "brew") return HOMEBREW_FORMULA ?? PRODUCT_NAME
  return PACKAGE_NAME
}

export function homebrewVersions(text: string, formula: string) {
  const errors: ParseError[] = []
  const input: unknown = parse(text, errors)
  if (errors.length || typeof input !== "object" || input === null || !("formulae" in input)) return
  if (!Array.isArray(input.formulae)) return
  const item = input.formulae.find(
    (value): value is Record<string, unknown> =>
      typeof value === "object" &&
      value !== null &&
      (value.name === formula.split("/").at(-1) || value.full_name === formula),
  )
  if (!item || typeof item.versions !== "object" || item.versions === null || !("stable" in item.versions)) return
  const stable = item.versions.stable
  const installed = Array.isArray(item.installed) ? item.installed[0] : undefined
  const version =
    typeof installed === "object" && installed !== null && "version" in installed ? installed.version : undefined
  if (typeof stable !== "string") return
  return { stable, installed: typeof version === "string" ? version : undefined }
}

export function decodePolicy(text: string): Policy | undefined {
  // The CLI only projects this host-level preference instead of initializing
  // the location-scoped server configuration graph.
  const errors: ParseError[] = []
  const input: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || typeof input !== "object" || input === null) return
  if ("update" in input) {
    const value = input.update
    if (value === "disable" || value === "notify" || value === "auto") return value
    return
  }
  if (!("autoupdate" in input)) return
  if (input.autoupdate === false) return "disable"
  if (input.autoupdate === "notify") return "notify"
  if (input.autoupdate === true) return "auto"
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const global = yield* Global.Service
  const appProcess = yield* AppProcess.Service
  const flock = yield* EffectFlock.Service
  const installedVersion = yield* Ref.make(OPENCODE_VERSION)
  const channel = OPENCODE_CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")
  const executable = yield* fs.realPath(process.execPath).pipe(Effect.orElseSucceed(() => process.execPath))
  const installedPackage = yield* Effect.gen(function* () {
    const directory = path.dirname(path.dirname(executable))
    const manifest: { name: string; bin?: Record<string, string> } = yield* fs
      .readFileString(path.join(directory, "package.json"))
      .pipe(Effect.flatMap((text) => Effect.try(() => JSON.parse(text))))
    // The OCV wrapper runs a native dependency without a bin manifest entry.
    // Package managers must still manage the root wrapper, not that dependency.
    if (
      PRODUCT_NAME === "ocv" &&
      /^@leohenon\/ocv-cli-(?:(?:darwin|windows)-(?:arm64|x64(?:-baseline)?)|linux-(?:arm64|x64(?:-baseline)?)(?:-musl)?)$/.test(
        manifest.name,
      ) &&
      executable ===
        path.join(
          directory,
          "bin",
          manifest.name.startsWith("@leohenon/ocv-cli-windows-") ? "opencode.exe" : "opencode",
        )
    )
      return PACKAGE_NAME
    // Source invocations run inside Bun or Node, which may themselves be npm packages.
    if (!ownsPackage(manifest.name)) return
    if (Object.values(manifest.bin ?? {}).some((bin) => path.resolve(directory, bin) === executable))
      return manifest.name
  }).pipe(Effect.orElseSucceed(() => undefined))
  const installedFormula = HOMEBREW_FORMULA
    ? executable.includes(`${path.sep}Cellar${path.sep}${HOMEBREW_FORMULA.split("/").at(-1)}${path.sep}`)
      ? HOMEBREW_FORMULA
      : undefined
    : ["opencode", "opencode-beta", "opencode-v2"].find((name) =>
        executable.includes(`${path.sep}Cellar${path.sep}${name}${path.sep}`),
      )
  // WinGet extracts portable packages into a directory named after the package identifier.
  const installedWinget =
    PRODUCT_NAME === "opencode" && /[\\/]winget[\\/]packages[\\/]anomaly\.opencode_/i.test(executable)

  const readPolicy = Effect.fnUntraced(function* () {
    const values = yield* Effect.forEach(["config.json", "opencode.json", "opencode.jsonc"], (name) =>
      fs.readFileString(path.join(global.config, name)).pipe(
        Effect.map(decodePolicy),
        Effect.orElseSucceed(() => undefined),
      ),
    )
    return values.findLast((value) => value !== undefined) ?? "notify"
  })

  const exec = Effect.fnUntraced(function* (command: string[], timeout: Duration.Input = "30 seconds") {
    return yield* appProcess
      .run(ChildProcess.make(command[0], command.slice(1)), {
        timeout,
        maxOutputBytes: 100_000,
        maxErrorBytes: 100_000,
      })
      .pipe(
        Effect.map((result) => ({
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        })),
      )
  })

  const brewInfo = Effect.fnUntraced(function* (formula: string) {
    const result = yield* exec(["brew", "info", "--json=v2", formula])
    const versions = result.code === 0 ? homebrewVersions(result.stdout, formula) : undefined
    if (versions) return versions
    return yield* Effect.fail(
      new UpgradeError({
        title: `Could not read the ${DISPLAY_NAME} Homebrew formula`,
        detail: result.code === 0 ? "Homebrew returned incomplete formula information." : resultDetail(result),
        command: `brew info --json=v2 ${formula}`,
        retry: `Update Homebrew and the formula tap, then run ${CLI_NAME} upgrade again.`,
      }),
    )
  })

  const curlPath = path.resolve(
    global.home,
    `.${PRODUCT_NAME}`,
    "bin",
    process.platform === "win32" ? `${CLI_NAME}.exe` : CLI_NAME,
  )
  const curlBinary = yield* fs.realPath(curlPath).pipe(Effect.orElseSucceed(() => curlPath))

  // On Windows a bare `bash` may be the WSL launcher, which cannot run the installer against Windows paths.
  const installerBash = Effect.fnUntraced(function* () {
    if (process.platform !== "win32") return "bash"
    if (process.env.OPENCODE_GIT_BASH_PATH) return process.env.OPENCODE_GIT_BASH_PATH
    const git = yield* exec(["git", "--exec-path"]).pipe(Effect.orElseSucceed(() => undefined))
    const bash = git?.code === 0 ? path.resolve(git.stdout.trim(), "..", "..", "..", "bin", "bash.exe") : undefined
    if (bash && (yield* fs.exists(bash).pipe(Effect.orElseSucceed(() => false)))) return bash
    return yield* Effect.fail(
      new UpgradeError({
        title: `Git Bash is required to update ${DISPLAY_NAME}`,
        detail: `The ${DISPLAY_NAME} installer runs with Git Bash on Windows, and it was not found.`,
        retry: `Install Git for Windows or set OPENCODE_GIT_BASH_PATH, then run ${CLI_NAME} upgrade again.`,
      }),
    )
  })

  const method = Effect.fnUntraced(function* () {
    if (executable === curlBinary) return "curl"
    if (installedFormula) return "brew"
    if (installedWinget) return "winget"
    if (!installedPackage) return

    const parts = executable
      .toLowerCase()
      .split(path.sep)
      .map((part) => part.replace(/^\./, ""))
    const checks: Array<{ method: Method; command: string[] }> = [
      { method: "npm", command: ["npm", "list", "-g", "--depth=0", installedPackage] },
      { method: "pnpm", command: ["pnpm", "list", "-g", "--depth=0", installedPackage] },
      { method: "bun", command: ["bun", "pm", "ls", "-g"] },
      { method: "yarn", command: ["yarn", "global", "list"] },
      { method: "vp", command: ["vp", "list", "-g", "--json", installedPackage] },
    ]
    checks.sort((a, b) => Number(parts.includes(b.method)) - Number(parts.includes(a.method)))
    const results = yield* Effect.forEach(
      checks,
      (check) =>
        exec(check.command).pipe(
          Effect.orElseSucceed(() => ({ code: 1, stdout: "", stderr: "" })),
          Effect.map((result) => ({ check, result })),
        ),
      { concurrency: "unbounded" },
    )
    return results.find((result) => {
      if (result.check.method !== "vp") return result.result.stdout.includes(installedPackage)
      // Vite+ repeats the filter in its successful no-match message, so substring detection would be a false positive.
      return Option.exists(decodeVpPackages(result.result.stdout), (packages) =>
        packages.some((item) => item.name === installedPackage),
      )
    })?.check.method
  })

  const removalCommand = (method: Method) => {
    if (method === "winget") return PRODUCT_NAME === "ocv" ? undefined : ["winget", "uninstall", ...wingetArgs]
    if (method === "curl" || method === "brew" || !installedPackage) return undefined
    const commands = {
      npm: ["npm", "uninstall", "--global", installedPackage],
      pnpm: ["pnpm", "remove", "--global", installedPackage],
      bun: ["bun", "remove", "--global", installedPackage],
      yarn: ["yarn", "global", "remove", installedPackage],
      vp: ["vp", "uninstall", "-g", installedPackage],
    }
    return commands[method]
  }

  const removal = (method: Method) => {
    const command = removalCommand(method)
    if (!command) return undefined
    return {
      command,
      run: retaining(
        method,
        exec(command, "5 minutes").pipe(
          Effect.flatMap((result) => (result.code === 0 ? Effect.void : Effect.fail(new Error(resultDetail(result))))),
        ),
        global.tmp,
      ),
    }
  }

  const release = Effect.fnUntraced(function* (method?: Method) {
    if (PRODUCT_NAME === "ocv" && method === "brew") {
      const formula = installedFormula ?? HOMEBREW_FORMULA
      if (!formula) return yield* Effect.fail(new Error("OCV Homebrew formula is not configured"))
      const versions = yield* brewInfo(formula)
      return { package: formula, version: versions.stable }
    }
    const core = PRODUCT_NAME === "opencode" && method === "brew" && installedFormula === "opencode"
    const distribution = method === "brew" ? "homebrew" : "npm"
    const url =
      PRODUCT_NAME === "ocv"
        ? `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/${NPM_DIST_TAG}`
        : core
          ? "https://formulae.brew.sh/api/formula/opencode.json"
          : `https://opencode.ai/update/api/${encodeURIComponent(channel)}/${encodeURIComponent(OPENCODE_ARTIFACT)}/${distribution}?current=${encodeURIComponent(OPENCODE_VERSION)}`
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(url, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        }),
      catch: (cause) =>
        new UpgradeError(
          {
            title: `Could not check for ${DISPLAY_NAME} updates`,
            detail: errorDetail(cause),
            retry: `Check your network, then run ${CLI_NAME} upgrade again.`,
          },
          { cause },
        ),
    })
    if (!response.ok)
      return yield* Effect.fail(
        new UpgradeError({
          title: `Could not check for ${DISPLAY_NAME} updates`,
          detail: `The update source returned HTTP ${response.status}.`,
          retry: "Try again in a few minutes.",
        }),
      )
    const data: { version?: string; metadata?: { package?: string }; versions?: { stable?: string } } =
      yield* Effect.tryPromise({
        try: () => response.json(),
        catch: (cause) =>
          new UpgradeError(
            {
              title: `Could not read the ${DISPLAY_NAME} update information`,
              detail: errorDetail(cause),
              retry: "Try again in a few minutes.",
            },
            { cause },
          ),
      })
    const version = core ? data.versions?.stable : data.version
    const packageName =
      PRODUCT_NAME === "ocv" ? updatePackage(method ?? "npm") : core ? "opencode" : data.metadata?.package
    if (!version || !packageName)
      return yield* Effect.fail(
        new UpgradeError({
          title: `Could not read the ${DISPLAY_NAME} update information`,
          detail: "The update source returned incomplete release information.",
          retry: "Try again in a few minutes.",
        }),
      )
    return { package: packageName, version }
  })

  // WinGet moderates every submission, so only its own index knows which release it can install.
  const wingetVersion = Effect.fnUntraced(function* () {
    if (PRODUCT_NAME === "ocv")
      return yield* Effect.fail(new Error("OCV is not distributed through WinGet. Use npm, Bun, or the OCV installer."))
    const failure = (detail: string, cause?: unknown) =>
      new UpgradeError(
        {
          title: "Could not check for OpenCode updates",
          detail,
          command: ["winget", "search", ...wingetArgs].join(" "),
          retry: "Fix the issue above, then run opencode upgrade again.",
        },
        cause === undefined ? undefined : { cause },
      )
    const result = yield* exec(["winget", "search", ...wingetArgs], "1 minute").pipe(
      Effect.mapError((cause) => failure(errorDetail(cause), cause)),
    )
    // Column headers are localized, but the result row always lists the identifier followed by the version.
    const version = result.stdout
      .split(/\r?\n|\r/)
      .map((line) => line.trim().split(/\s+/))
      .flatMap((tokens) => {
        const index = tokens.findIndex((token) => token.toLowerCase() === wingetPackage.toLowerCase())
        return index === -1 ? [] : tokens.slice(index + 1, index + 2)
      })
      .find((token) => parseReleaseVersion(token))
    if (result.code !== 0 || !version) return yield* Effect.fail(failure(resultDetail(result)))
    return version
  })

  const latest = (selected?: Method) =>
    (selected ? Effect.succeed(selected) : method()).pipe(
      Effect.flatMap((method) =>
        method === "winget" ? wingetVersion() : release(method).pipe(Effect.map((data) => data.version)),
      ),
    )

  const temporaryDirectory = (prefix: string) =>
    Effect.acquireRelease(fs.makeTempDirectory({ directory: global.cache, prefix }), (directory) =>
      fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
    )

  // On Windows the installer must delete or replace the running binary, which only works
  // while another link to it exists (see RetainedImage). Upgrades keep that link in the
  // cache; uninstall has already removed the cache, so it uses the temporary directory.
  const retaining = <A, E, R>(method: Method, effect: Effect.Effect<A, E, R>, directory = global.cache) => {
    if (process.platform !== "win32" || method === "brew") return effect
    // Only the installed binary is at stake; source checkouts run inside bun or node.
    const owned =
      method === "curl"
        ? executable === curlBinary
        : method === "winget"
          ? installedWinget
          : installedPackage !== undefined
    if (!owned) return effect
    return Effect.scoped(RetainedImage.retain(directory, "upgrade").pipe(Effect.andThen(effect))).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    )
  }

  const runUpgrade = (input: {
    readonly method: Method
    readonly command: string[]
    readonly displayCommand?: string[]
    readonly title?: string
    readonly retry?: string
  }) => {
    const failure = (detail: string, cause?: unknown) =>
      new UpgradeError(
        {
          title: input.title ?? `${installNames[input.method]} could not install ${DISPLAY_NAME}`,
          detail,
          command: (input.displayCommand ?? input.command).join(" "),
          retry: input.retry ?? `Fix the issue above, then run ${CLI_NAME} upgrade again.`,
        },
        cause === undefined ? undefined : { cause },
      )
    return exec(input.command, "5 minutes").pipe(
      Effect.flatMap((result) =>
        result.code === 0 ? Effect.succeed(result) : Effect.fail(failure(resultDetail(result))),
      ),
      Effect.mapError((cause) =>
        cause instanceof UpgradeError
          ? cause
          : failure(
              cause instanceof AppProcess.AppProcessError && cause.stderr === undefined && cause.cause === undefined
                ? `Failed to update with ${input.method}`
                : errorDetail(cause),
              cause,
            ),
      ),
    )
  }

  const upgrade = Effect.fnUntraced(function* (method: Method, input: string) {
    if (!parseReleaseVersion(input)) return yield* Effect.fail(new Error(`Invalid version: ${input}`))
    if (PRODUCT_NAME === "ocv" && method === "winget")
      return yield* Effect.fail(new Error("OCV is not distributed through WinGet. Use npm, Bun, or the OCV installer."))
    const version = input.trim().replace(/^v/, "")
    const packageName =
      method === "winget"
        ? wingetPackage
        : method === "brew" && installedFormula && (PRODUCT_NAME === "ocv" || installedFormula === "opencode")
          ? installedFormula
          : (yield* release(method)).package
    const target = `${packageName}@${version}`
    if (installedPackage && packageName !== installedPackage && (method === "pnpm" || method === "yarn")) {
      return yield* Effect.fail(new Error(`Reinstall ${target} with ${method} to migrate from ${installedPackage}.`))
    }
    const commands: Record<Exclude<Method, "bun" | "curl" | "brew" | "winget">, string[]> = {
      // Keep the old package: uninstalling it can unlink the replacement command.
      npm: [
        "npm",
        "install",
        "--global",
        ...((OPENCODE_ARTIFACT === "cli" && !installedPackage?.endsWith("/cli-node")) ||
        (installedPackage && packageName !== installedPackage)
          ? ["--force"]
          : []),
        target,
      ],
      pnpm: ["pnpm", "add", "--global", `--allow-build=${packageName}`, target],
      yarn: ["yarn", "global", "add", target],
      vp:
        installedPackage && packageName !== installedPackage
          ? ["vp", "install", "-g", "--force", target]
          : ["vp", "update", "-g", target],
    }
    yield* Effect.scoped(
      Effect.gen(function* () {
        // Other OpenCode processes may be installing at the same time. Wait longer than the
        // slowest install (curl runs two 5-minute commands).
        yield* flock.acquire("cli-upgrade", undefined, { timeoutMs: Duration.toMillis("15 minutes") })
        if (method === "bun") {
          // Bun does not prune old versions from its shared package cache.
          yield* fs.makeDirectory(global.cache, { recursive: true })
          const cache = yield* temporaryDirectory("update-")
          return yield* retaining(
            method,
            runUpgrade({
              method,
              command: ["bun", "install", "--global", "--trust", "--cache-dir", cache, target],
              displayCommand: ["bun", "install", "--global", "--trust", target],
            }),
          )
        }
        if (method === "curl") {
          const bash = yield* installerBash()
          yield* fs.makeDirectory(global.cache, { recursive: true })
          const directory = yield* temporaryDirectory("update-")
          const installer = path.join(directory, "install")
          yield* runUpgrade({
            method,
            command: ["curl", "-fsSL", "-o", installer, INSTALLER_URL],
            displayCommand: ["curl", "-fsSL", INSTALLER_URL],
            title: `Could not download the ${DISPLAY_NAME} installer`,
            retry: `Check your network, then run ${CLI_NAME} upgrade again.`,
          })
          return yield* retaining(
            method,
            runUpgrade({
              method,
              command: [bash, installer, "--version", version, "--no-modify-path"],
              displayCommand: [CLI_NAME, "upgrade", version, "--method", "curl"],
              title: `The ${DISPLAY_NAME} installer failed`,
            }),
          )
        }
        if (method === "brew") {
          yield* runUpgrade({ method, command: ["brew", "upgrade", packageName] })
          if (PRODUCT_NAME !== "ocv") return
          const installed = (yield* brewInfo(packageName)).installed
          if (installed === version) return
          return yield* Effect.fail(
            new UpgradeError({
              title: `Homebrew did not install ${DISPLAY_NAME} ${version}`,
              detail: installed
                ? `The installed ${packageName} formula is ${installed}.`
                : `Homebrew does not report ${packageName} as installed.`,
              command: `brew info --json=v2 ${packageName}`,
              retry: `Update leohenon/tap and run ${CLI_NAME} upgrade again.`,
            }),
          )
        }
        if (method === "winget")
          return yield* retaining(
            method,
            runUpgrade({
              method,
              command: [
                "winget",
                "upgrade",
                ...wingetArgs,
                "--version",
                version,
                "--silent",
                "--accept-package-agreements",
              ],
            }),
          )
        return yield* retaining(method, runUpgrade({ method, command: commands[method] }))
      }),
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof UpgradeError
          ? cause
          : new UpgradeError(
              {
                title: `Could not prepare the ${DISPLAY_NAME} upgrade`,
                detail: errorDetail(cause),
                retry: `Fix the issue above, then run ${CLI_NAME} upgrade again.`,
              },
              { cause },
            ),
      ),
      Effect.asVoid,
    )
  })

  const inspect = Effect.fnUntraced(function* () {
    if (OPENCODE_LOCAL || ["1", "true"].includes(process.env.OPENCODE_DISABLE_AUTOUPDATE?.toLowerCase() ?? "")) {
      yield* Effect.logInfo("update check skipped", {
        reason: OPENCODE_LOCAL ? "local-install" : "disabled",
        version: OPENCODE_VERSION,
        channel: OPENCODE_CHANNEL,
      })
      return undefined
    }
    const policy = yield* readPolicy()
    if (policy === "disable") {
      yield* Effect.logInfo("update check skipped", { reason: "policy-disabled" })
      return undefined
    }

    const current = yield* Ref.get(installedVersion)
    const version = yield* latest()
    yield* Effect.logInfo("update check", {
      current,
      latest: version,
    })
    const next = action(current, version, policy)
    if (next === "none") {
      yield* Effect.logInfo("update check done", { action: "up-to-date" })
      return undefined
    }
    yield* Effect.logInfo(`${DISPLAY_NAME} update available`, { current, latest: version, action: next })
    return { policy, version }
  })

  const install = Effect.fnUntraced(function* (version: string) {
    const detected = yield* method()
    if (!detected) {
      yield* Effect.logWarning("update skipped: installation method not found")
      return false
    }
    const current = yield* Ref.get(installedVersion)
    yield* upgrade(detected, version)
    yield* Ref.set(installedVersion, version)
    yield* Effect.logInfo(`updated ${DISPLAY_NAME}`, { from: current, to: version, method: detected })
    return true
  })

  const apply = Effect.fn("cli.updater.apply")(function* (version: string) {
    if (!(yield* install(version)))
      return yield* Effect.fail(
        new Error(
          "Could not detect the installation method. Update with your package manager or download the latest release.",
        ),
      )
  })

  const check = Effect.fn("cli.updater.check")(function* () {
    if (OPENCODE_LOCAL)
      return {
        type: "unavailable" as const,
        message: `This build runs from a source checkout. Use an installed ${DISPLAY_NAME} release to check for updates.`,
      }
    const detected = yield* method()
    if (!detected)
      return {
        type: "unavailable" as const,
        message:
          "Could not detect the installation method. Update with your package manager or download the latest release.",
      }
    const version = yield* latest(detected)
    if (!parseReleaseVersion(version)) return yield* Effect.fail(new Error(`Invalid version: ${version}`))
    const current = yield* Ref.get(installedVersion)
    if (action(current, version, "auto") === "none") {
      // An earlier check may have installed the update while this client is still running.
      return action(OPENCODE_VERSION, current, "auto") === "none"
        ? undefined
        : { type: "installed" as const, version: current }
    }
    return { type: "available" as const, version }
  })

  const run = Effect.fn("cli.updater.run")(
    function* (onInstall: (version: string) => void = () => {}) {
      const result = yield* inspect()
      if (!result) return undefined
      if (result.policy === "notify") return { type: "available" as const, version: result.version }
      onInstall(result.version)
      if (!(yield* install(result.version))) return yield* Effect.fail(new Error("Installation method not found"))
      return { type: "installed" as const, version: result.version }
    },
    Effect.catch((error) => Effect.logWarning("update check failed", { error }).pipe(Effect.as(undefined))),
  )

  return Service.of({ run, check, apply, method, latest, upgrade, removal })
})

export const layer = Layer.effect(Service, make)

export * as Updater from "./updater"
export { action, type Action, type Policy } from "./updater-action"
