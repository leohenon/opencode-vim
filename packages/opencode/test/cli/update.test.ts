import { describe, expect, test } from "bun:test"
import path from "node:path"
import { latest } from "../../src/cli/cmd/update"

const root = path.resolve(import.meta.dir, "../../../..")

describe("ocv update", () => {
  test("installs the version the V1 lookup resolves", async () => {
    expect(await latest(async () => "1.19.5-ocv.4.15")).toBe("1.19.5-ocv.4.15")
  })

  test("reports a failed lookup instead of installing anything", async () => {
    expect(await latest(() => Promise.reject(new Error("registry returned an OCV V2 version")))).toBeUndefined()
  })

  test("does not follow GitHub's Latest release, which belongs to OCV V2", async () => {
    const source = await Bun.file(path.join(root, "packages/opencode/src/cli/cmd/update.ts")).text()
    expect(source).not.toContain("releases/latest")
    expect(source).toContain('Installation.latest("curl")')
  })
})
