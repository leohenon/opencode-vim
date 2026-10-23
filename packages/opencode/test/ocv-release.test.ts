import { describe, expect, test } from "bun:test"
import { planRelease, previousRelease } from "../script/ocv-release"

const release = (tagName: string, isDraft = false, isPrerelease = false) => ({ tagName, isDraft, isPrerelease })
const input = {
  base: "1.18.35",
  track: "4.13",
  forkChanges: false,
  upstream: [release("v1.18.35"), release("v2.1.2")],
  releases: [release("v1.18.31-ocv.4.11"), release("v2.1.2-ocv.4.13", false, true)],
}

describe("V1 maintenance release planning", () => {
  test("ignores V2 releases, drafts and prereleases", () => {
    expect(
      previousRelease([...input.releases, release("v1.99.0-ocv.4.14", true), release("v1.99.1-ocv.4.14", false, true)]),
    ).toBe("v1.18.31-ocv.4.11")
  })

  test("compares numeric version and track components rather than API order", () => {
    expect(
      previousRelease([release("v1.9.0-ocv.4.99"), release("v1.18.35-ocv.4.9"), release("v1.18.35-ocv.4.13")]),
    ).toBe("v1.18.35-ocv.4.13")
  })

  test("releases only the source version, not the latest V2 version", () => {
    expect(planRelease(input)).toMatchObject({ version: "1.18.35-ocv.4.13", publish: true, reason: "release-needed" })
  })

  test.each(["2.1.2", "0.0.1", "1.18.35-beta", "1.18", ""])("rejects non-V1 source %s", (base) => {
    expect(() => planRelease({ ...input, base })).toThrow("V1")
  })

  test.each(["4", "4.13.1", "x.13", "", "4.13\n"])("rejects invalid track %s", (track) => {
    expect(() => planRelease({ ...input, track })).toThrow("track")
  })

  test("does not release an unreleased upstream source", () => {
    expect(planRelease({ ...input, upstream: [release("v2.1.2"), release("v1.18.34")] })).toMatchObject({
      publish: false,
      reason: "upstream-not-released",
    })
  })

  test.each([release("v1.18.35", true), release("v1.18.35", false, true)])(
    "does not release upstream drafts or prereleases",
    (upstream) => {
      expect(planRelease({ ...input, upstream: [upstream] }).publish).toBe(false)
    },
  )

  test("suppresses already-published V1 releases", () => {
    expect(planRelease({ ...input, releases: [...input.releases, release("v1.18.35-ocv.4.13")] })).toMatchObject({
      publish: false,
      reason: "already-released",
    })
  })

  test("retries an unpublished draft", () => {
    expect(planRelease({ ...input, releases: [release("v1.18.35-ocv.4.13", true)] }).publish).toBe(true)
  })

  test("bumps only the V1 patch revision for new fork changes", () => {
    expect(
      planRelease({
        ...input,
        forkChanges: true,
        releases: [release("v1.18.35-ocv.4.13"), release("v2.1.2-ocv.4.99")],
      }),
    ).toMatchObject({ track: "4.14", version: "1.18.35-ocv.4.14", publish: true })
  })

  test("does not bump a revision already advanced by maintainers", () => {
    expect(planRelease({ ...input, forkChanges: true }).track).toBe("4.13")
  })
})
