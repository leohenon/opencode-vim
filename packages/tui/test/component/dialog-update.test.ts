import { describe, expect, test } from "bun:test"
import { updateTarget, V2_ANNOUNCEMENT_URL } from "../../src/component/dialog-update"
import {
  DISMISS_DURATION,
  isVersionGreater,
  MAJOR_INSTRUCTIONS,
  visibleNotice,
} from "../../src/context/update-notification"

describe("dialog update", () => {
  test("V2 migration instructions stay on the OCV fork", () => {
    expect(V2_ANNOUNCEMENT_URL).toBe("https://github.com/leohenon/opencode-vim/tree/ocv#installation")
    expect(MAJOR_INSTRUCTIONS).toBe(V2_ANNOUNCEMENT_URL)
  })

  test("uses the normal OpenCode 1 update when a newer release exists", () => {
    expect(updateTarget({ current: "1.4.0", latest: "1.4.2" })).toEqual({ type: "latest", version: "1.4.2" })
  })

  test("only offers OpenCode 2 when OpenCode 1 is up to date", () => {
    expect(updateTarget({ current: "1.4.2", latest: "1.4.2" })).toEqual({ type: "major" })
  })

  test("never treats OpenCode 2 or an older release as a normal update", () => {
    expect(updateTarget({ current: "1.4.2", latest: "2.0.0" })).toEqual({ type: "major" })
    expect(updateTarget({ current: "1.4.2", latest: "1.4.1" })).toEqual({ type: "major" })
    expect(updateTarget({ current: "1.9.0", latest: "1.10.0" })).toEqual({ type: "latest", version: "1.10.0" })
  })

  test("skipping an OpenCode 1 version hides it until a newer one ships", () => {
    const now = 1_000_000
    expect(visibleNotice({ type: "available", version: "1.4.2" }, {}, now)).toEqual({
      type: "available",
      version: "1.4.2",
    })
    expect(visibleNotice({ type: "available", version: "1.4.2" }, { skippedVersion: "1.4.2" }, now)).toBeUndefined()
    expect(visibleNotice({ type: "available", version: "1.4.3" }, { skippedVersion: "1.4.2" }, now)).toEqual({
      type: "available",
      version: "1.4.3",
    })
  })

  test("dismissing the OpenCode 2.0 offer hides it for a week", () => {
    const now = 1_000_000
    const dismissedUntil = now + DISMISS_DURATION
    expect(DISMISS_DURATION).toBe(7 * 24 * 60 * 60 * 1000)
    expect(visibleNotice({ type: "major" }, { dismissedUntil }, now)).toBeUndefined()
    expect(visibleNotice({ type: "major" }, { dismissedUntil }, dismissedUntil - 1)).toBeUndefined()
    expect(visibleNotice({ type: "major" }, { dismissedUntil }, dismissedUntil)).toEqual({ type: "major" })
  })

  test("skipping and dismissing are independent", () => {
    const now = 1_000_000
    expect(visibleNotice({ type: "major" }, { skippedVersion: "1.4.2" }, now)).toEqual({ type: "major" })
    expect(
      visibleNotice({ type: "available", version: "1.4.3" }, { dismissedUntil: now + DISMISS_DURATION }, now),
    ).toEqual({ type: "available", version: "1.4.3" })
  })

  test("keeps fork revisions on the V1 update path", () => {
    expect(updateTarget({ current: "1.19.4-ocv.4.13", latest: "1.19.4-ocv.4.14" })).toEqual({
      type: "latest",
      version: "1.19.4-ocv.4.14",
    })
    expect(updateTarget({ current: "1.19.4-ocv.4.14", latest: "2.1.2-ocv.4.13" })).toEqual({ type: "major" })
    expect(isVersionGreater("1.19.4-ocv.4.14", "1.19.4-ocv.4.13")).toBe(true)
  })

  test("compares versions for skipping", () => {
    expect(isVersionGreater("1.4.2", "1.4.2")).toBe(false)
    expect(isVersionGreater("1.4.3", "1.4.2")).toBe(true)
    expect(isVersionGreater("1.5.0", "1.10.0")).toBe(false)
    expect(isVersionGreater("1.4.2", "1.4.2-beta.1")).toBe(true)
  })
})
