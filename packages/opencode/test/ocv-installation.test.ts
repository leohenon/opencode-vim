import { describe, expect, test } from "bun:test"
import { chmod, mkdir } from "fs/promises"
import { existsSync } from "fs"
import path from "path"
import { tmpdir } from "../../core/test/fixture/tmpdir"

const installer = path.resolve(import.meta.dir, "../../../install.sh")
const version = "1.18.35-ocv.4.13"

// The installer is POSIX shell; Windows does not supply sh or tar.
describe.skipIf(process.platform === "win32")("V1 shell installer isolation", () => {
  test("installs npm latest and explicit V1 releases from matching fixture archives", async () => {
    await using dir = await tmpdir()
    const env = await fixture(dir.path)
    for (const explicit of ["", version]) {
      const destination = path.join(dir.path, explicit ? "explicit" : "latest")
      const result = Bun.spawnSync(["sh", installer], {
        env: { ...env, OCV_VERSION: explicit, OCV_INSTALL_DIR: destination },
      })
      expect(result.stderr.toString()).toBe("")
      expect(result.exitCode).toBe(0)
      expect(await Bun.file(path.join(destination, "ocv")).text()).toBe("#!/bin/sh\necho fixture\n")
    }
    expect((await Bun.file(env.FIXTURE_REQUESTS).text()).trim().split("\n")).toEqual([
      "https://registry.npmjs.org/@leohenon/ocv/latest",
      `https://github.com/leohenon/opencode-vim/releases/download/v${version}/ocv-linux-x64.tar.gz`,
      `https://github.com/leohenon/opencode-vim/releases/download/v${version}/ocv-linux-x64.tar.gz`,
    ])
    expect(await Bun.file(path.join(dir.path, "home", ".bashrc")).text()).toBe("# untouched\n")
  })

  test("rejects V2 npm latest before downloading or creating the install directory", async () => {
    await using dir = await tmpdir()
    const env = await fixture(dir.path)
    const destination = path.join(dir.path, "install")
    const result = Bun.spawnSync(["sh", installer], {
      env: { ...env, FIXTURE_VERSION: "2.0.0-ocv.4.13", OCV_VERSION: "", OCV_INSTALL_DIR: destination },
    })
    expect(result.stdout.toString()).toContain("Expected a V1 OCV version")
    expect(result.exitCode).not.toBe(0)
    expect(await Bun.file(env.FIXTURE_REQUESTS).text()).toBe("https://registry.npmjs.org/@leohenon/ocv/latest\n")
    expect(existsSync(destination)).toBe(false)
    expect(await Bun.file(path.join(dir.path, "home", ".bashrc")).text()).toBe("# untouched\n")
  })

  test("rejects explicit non-V1 targets without fetching or installing", async () => {
    await using dir = await tmpdir()
    const env = await fixture(dir.path)
    const destination = path.join(dir.path, "install")
    for (const target of ["2.0.0-ocv.4.13", "1.18.35", "latest", "1.18.35-ocv.4.13\n", "1.18.35-ocv.4.13\n2.0.0"]) {
      const result = Bun.spawnSync(["sh", installer], {
        env: { ...env, OCV_VERSION: target, OCV_INSTALL_DIR: destination },
      })
      expect(result.stdout.toString()).toContain("Expected a V1 OCV version")
      expect(result.exitCode).not.toBe(0)
    }
    expect(await Bun.file(env.FIXTURE_REQUESTS).exists()).toBe(false)
    expect(existsSync(destination)).toBe(false)
    expect(await Bun.file(path.join(dir.path, "home", ".bashrc")).text()).toBe("# untouched\n")
  })
})

async function fixture(root: string) {
  await mkdir(path.join(root, "shims"))
  await mkdir(path.join(root, "home"))
  await mkdir(path.join(root, "archive"))
  await mkdir(path.join(root, "tmp"))
  await Bun.write(path.join(root, "home", ".bashrc"), "# untouched\n")
  await Bun.write(path.join(root, "archive", "opencode"), "#!/bin/sh\necho fixture\n")
  await chmod(path.join(root, "archive", "opencode"), 0o755)
  const archive = path.join(root, "fixture.tar.gz")
  const packed = Bun.spawnSync(["tar", "-czf", archive, "-C", path.join(root, "archive"), "opencode"])
  expect(packed.exitCode).toBe(0)
  await Bun.write(
    path.join(root, "shims", "uname"),
    `#!/bin/sh
case "$1" in
  -s) echo Linux ;;
  -m) echo x86_64 ;;
  *) exit 1 ;;
esac
`,
  )
  await Bun.write(
    path.join(root, "shims", "curl"),
    `#!/bin/sh
for arg do url="$arg"; done
printf '%s\\n' "$url" >> "$FIXTURE_REQUESTS"
case "$url" in
  https://registry.npmjs.org/@leohenon/ocv/latest)
    printf '{"name":"@leohenon/ocv","version":"%s","description":"fixture"}\\n' "$FIXTURE_VERSION" ;;
  "https://github.com/leohenon/opencode-vim/releases/download/v$FIXTURE_VERSION/ocv-linux-x64.tar.gz")
    cat "$FIXTURE_ARCHIVE" ;;
  *) echo "Unexpected URL: $url" >&2; exit 1 ;;
esac
`,
  )
  await chmod(path.join(root, "shims", "uname"), 0o755)
  await chmod(path.join(root, "shims", "curl"), 0o755)
  return {
    ...process.env,
    PATH: path.join(root, "shims") + path.delimiter + process.env.PATH,
    HOME: path.join(root, "home"),
    ZDOTDIR: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "home", "config"),
    TMPDIR: path.join(root, "tmp"),
    SHELL: "/bin/bash",
    OCV_NO_MODIFY_PATH: "1",
    FIXTURE_ARCHIVE: archive,
    FIXTURE_REQUESTS: path.join(root, "requests"),
    FIXTURE_VERSION: version,
  }
}
