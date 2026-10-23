import { expect, test } from "bun:test"
import { chmod, mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "./fixture/tmpdir"

const unix = process.platform === "win32" ? test.skip : test
const installer = path.resolve(import.meta.dir, "../../../install.sh")

unix("V2 installer selects only the preview tag and installs into the requested directory", async () => {
  await using directory = await tmpdir()
  const tools = path.join(directory.path, "tools")
  const payload = path.join(directory.path, "payload")
  const archive = path.join(directory.path, "release.tar.gz")
  const log = path.join(directory.path, "requests")
  const target = path.join(directory.path, "bin")
  await mkdir(tools)
  await mkdir(payload)
  await Bun.write(path.join(payload, "opencode"), "#!/bin/sh\necho 'ocv v2.0.32-ocv.4.13'\n")
  await chmod(path.join(payload, "opencode"), 0o755)
  const packed = Bun.spawn(["tar", "-czf", archive, "-C", payload, "opencode"], { stderr: "pipe" })
  expect(await packed.exited).toBe(0)
  await Bun.write(path.join(tools, "uname"), '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo aarch64;; esac\n')
  await Bun.write(path.join(tools, "ldd"), "#!/bin/sh\necho 'glibc'\n")
  await Bun.write(
    path.join(tools, "curl"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$REQUEST_LOG"
case "$*" in
  *registry.npmjs.org*) printf '%s' '{"version":"2.0.32-ocv.4.13"}';;
  *releases/download/v2.0.32-ocv.4.13/ocv-linux-arm64.tar.gz) cat "$RELEASE_ARCHIVE";;
  *) echo "Unexpected network request" >&2; exit 1;;
esac
`,
  )
  await Promise.all(["curl", "uname", "ldd"].map((name) => chmod(path.join(tools, name), 0o755)))
  const child = Bun.spawn(["sh", installer, "--no-modify-path"], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${tools}:${process.env.PATH}`,
      OCV_INSTALL_DIR: target,
      OCV_VERSION: "",
      REQUEST_LOG: log,
      RELEASE_ARCHIVE: archive,
    },
  })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(code, stderr).toBe(0)
  expect(await Bun.file(path.join(target, "ocv")).text()).toContain("ocv v2.0.32-ocv.4.13")
  const requests = await Bun.file(log).text()
  expect(requests).toContain("https://registry.npmjs.org/@leohenon%2Focv/ocv-v2")
  expect(requests).not.toContain("releases/latest")
})

unix("V2 installer refuses an explicit V1 target without replacing the executable", async () => {
  await using directory = await tmpdir()
  const target = path.join(directory.path, "bin")
  await mkdir(target)
  await Bun.write(path.join(target, "ocv"), "existing executable")
  const child = Bun.spawn(["sh", installer, "--version", "1.18.35-ocv.4.13", "--no-modify-path"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, OCV_INSTALL_DIR: target },
  })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(code).not.toBe(0)
  expect(stderr).toContain("Expected an OCV V2 version")
  expect(await Bun.file(path.join(target, "ocv")).text()).toBe("existing executable")
})
