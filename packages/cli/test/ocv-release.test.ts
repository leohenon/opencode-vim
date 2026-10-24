import { describe, expect, test } from "bun:test"
import { planRelease, previousRelease } from "../script/ocv-release"

const release = (tagName: string, isDraft = false) => ({ tagName, isDraft })
const input = () => ({
  base: "2.1.2",
  track: "4.13",
  forkChanges: false,
  upstream: ["v2.1.2"],
  releases: [] as ReturnType<typeof release>[],
})

describe("OCV V2 release planning", () => {
  test("does not publish V2 source using an upstream V1 tag", () => {
    expect(planRelease({ ...input(), upstream: ["v1.19.4"] })).toMatchObject({
      publish: false,
      reason: "upstream-not-tagged",
      version: "2.1.2-ocv.4.13",
    })
  })

  test.each(["2.1.1", "2.1.3"])("does not relabel source for a different upstream release %s", (version) => {
    expect(planRelease({ ...input(), upstream: [`v${version}`] }).publish).toBe(false)
  })

  test("publishes a V2 Git tag without an upstream GitHub Release", () => {
    expect(planRelease({ ...input(), forkChanges: true, releases: [release("v1.19.4-ocv.4.99")] })).toEqual({
      previous: "",
      track: "4.13",
      version: "2.1.2-ocv.4.13",
      publish: true,
      reason: "release-needed",
    })
  })

  test.each([{ tags: [] }, { tags: ["v2.1.2-beta.1"] }, { tags: ["v2.1.20"] }])(
    "requires the exact plain V2 tag %j",
    ({ tags }) => {
      expect(planRelease({ ...input(), upstream: tags }).publish).toBe(false)
    },
  )

  test("skips completed releases and retries drafts", () => {
    expect(planRelease({ ...input(), releases: [release("v2.1.2-ocv.4.13")] })).toMatchObject({
      publish: false,
      reason: "already-released",
    })
    expect(planRelease({ ...input(), releases: [release("v2.1.2-ocv.4.13", true)] }).publish).toBe(true)
  })

  test("increments the fork revision once for merged fork PRs", () => {
    const initial = { ...input(), forkChanges: true, releases: [release("v2.1.2-ocv.4.13")] }
    expect(planRelease(initial)).toMatchObject({ track: "4.14", version: "2.1.2-ocv.4.14", publish: true })
    expect(planRelease({ ...initial, track: "4.14" }).track).toBe("4.14")
  })

  test("an upstream update alone retains the fork track", () => {
    expect(planRelease({ ...input(), releases: [release("v2.1.1-ocv.4.13")] })).toMatchObject({
      track: "4.13",
      version: "2.1.2-ocv.4.13",
      publish: true,
    })
  })

  test.each([
    { base: "1.19.4" },
    { base: "3.0.0" },
    { base: "2.1.2-beta.1" },
    { track: "4" },
    { track: "4.13\ninvalid" },
  ])("rejects invalid release inputs %j", (override) => {
    expect(() => planRelease({ ...input(), ...override })).toThrow()
  })
})

test("previous V2 release uses numeric ordering and excludes V1 and drafts", () => {
  expect(
    previousRelease([
      release("v1.99.0-ocv.99.99"),
      release("v2.10.0-ocv.4.13"),
      release("v2.9.0-ocv.4.99"),
      release("v2.10.0-ocv.4.9"),
      release("v2.11.0-ocv.4.13", true),
      release("v3.0.0-ocv.4.13"),
    ]),
  ).toBe("v2.10.0-ocv.4.13")
})
