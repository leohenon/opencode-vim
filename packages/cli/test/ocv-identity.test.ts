import { expect, test } from "bun:test"
import path from "node:path"
import { CLI_NAME, DISPLAY_NAME, INSTALLER_URL, NPM_DIST_TAG, PACKAGE_NAME, PRODUCT_NAME } from "@opencode/util/identity"
import { Global } from "@opencode/util/global"
import { databasePath } from "../src/database-path"
import { ServiceConfig } from "../src/services/service-config"
import { SchemaURL } from "../src/config/schema"
import { ownsPackage, updatePackage } from "../src/services/updater"

declare const OPENCODE_CHANNEL: string | undefined

if (typeof OPENCODE_CHANNEL === "string" && OPENCODE_CHANNEL === "ocv") {
  test("OCV build identity isolates service and storage paths", () => {
    expect(CLI_NAME).toBe("ocv")
    expect(PRODUCT_NAME).toBe("ocv")
    expect(DISPLAY_NAME).toBe("OCV")
    expect(PACKAGE_NAME).toBe("@leohenon/ocv")
    expect(NPM_DIST_TAG).toBe("ocv-v2")
    expect(INSTALLER_URL).toBe("https://raw.githubusercontent.com/leohenon/opencode-vim/ocv/install.sh")
    expect(ownsPackage("@leohenon/ocv")).toBe(true)
    expect(ownsPackage("@opencode/cli")).toBe(false)
    expect(updatePackage("npm")).toBe("@leohenon/ocv")
    expect(updatePackage("brew")).toBe("leohenon/tap/ocv-v2")
    expect(SchemaURL).toBeUndefined()
    expect(Global.Path.data.split(path.sep)).toContain("ocv")
    expect(Global.Path.config.split(path.sep)).toContain("ocv")
    expect(databasePath("/tmp/ocv-data")).toBe(path.resolve("/tmp/ocv-data", "opencode-ocv.db"))
    expect(ServiceConfig.filename()).toBe("service-ocv.json")
    expect(ServiceConfig.defaultPort()).not.toBe(ServiceConfig.defaultPort("latest"))
  })
} else {
  test("compiled OCV identity is internally consistent", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        import.meta.path,
        "--define",
        'OPENCODE_CLI_NAME="ocv"',
        "--define",
        'OPENCODE_PRODUCT_NAME="ocv"',
        "--define",
        'OPENCODE_CHANNEL="ocv"',
        "--define",
        'OPENCODE_VERSION="2.0.25-ocv.4.13"',
        "--test-name-pattern",
        "^OCV build identity isolates service and storage paths$",
      ],
      {
        cwd: path.join(import.meta.dir, ".."),
        stdout: "ignore",
        stderr: "pipe",
        env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      },
    )
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(code, stderr).toBe(0)
    expect(stderr).toContain("1 pass")
  })
}
