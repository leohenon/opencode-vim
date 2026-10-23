import { describe, expect, test } from "bun:test"
import { latestV1 } from "./raw-changelog"

describe("raw changelog", () => {
  test("starts from the newest published OpenCode 1 release", () => {
    expect(
      latestV1([
        { tag_name: "v2.0.28", draft: false },
        { tag_name: "v1.19.2", draft: true },
        { tag_name: "v2.0.27", draft: false },
        { tag_name: "v1.19.1", draft: false },
        { tag_name: "v1.19.0", draft: false },
      ]),
    ).toBe("1.19.1")
  })

  test("ignores OpenCode 2 releases entirely", () => {
    expect(latestV1([{ tag_name: "v2.0.0", draft: false }])).toBeUndefined()
  })
})
