type Release = {
  tagName: string
  isDraft: boolean
}

const forkVersion = /^v(2\.\d+\.\d+)-ocv\.(\d+)\.(\d+)$/

/** Ignore V1 releases, drafts and API ordering when finding the last V2 release. */
export function previousRelease(releases: readonly Release[]) {
  return releases
    .filter((release) => !release.isDraft && forkVersion.test(release.tagName))
    .toSorted((a, b) => {
      const left = a.tagName.match(forkVersion)!
      const right = b.tagName.match(forkVersion)!
      const parts = (match: RegExpMatchArray) => [...match[1]!.split("."), match[2]!, match[3]!].map(Number)
      const x = parts(left)
      const y = parts(right)
      return x.map((value, index) => y[index]! - value).find((difference) => difference !== 0) ?? 0
    })[0]?.tagName
}

export function planRelease(input: {
  base: string
  track: string
  forkChanges: boolean
  upstream: readonly string[]
  releases: readonly Release[]
}) {
  if (!/^2\.\d+\.\d+$/.test(input.base)) throw new Error(`Expected an upstream V2 source version: ${input.base}`)
  if (!/^\d+\.\d+$/.test(input.track)) throw new Error(`Invalid OCV track: ${input.track}`)
  const previous = previousRelease(input.releases)
  const previousTrack = previous?.split("-ocv.")[1]
  const [major, patch] = input.track.split(".").map(Number)
  const track = input.forkChanges && previousTrack === input.track ? `${major}.${patch! + 1}` : input.track
  const version = `${input.base}-ocv.${track}`
  // Match the source being built, not GitHub's latest stable release (which may be V1).
  // Upstream V2 versions are Git tags, even when no GitHub Release exists.
  const upstream = input.upstream.includes(`v${input.base}`)
  const exists = input.releases.some((release) => !release.isDraft && release.tagName === `v${version}`)
  return {
    previous: previous ?? "",
    track,
    version,
    publish: upstream && !exists,
    reason: !upstream ? "upstream-not-tagged" : exists ? "already-released" : "release-needed",
  }
}

if (import.meta.main) {
  const [upstream, releases] = process.argv.slice(2)
  if (!upstream || !releases) throw new Error("Usage: ocv-release.ts <upstream-tags.json> <ocv-releases.json>")
  const root = new URL("../../../", import.meta.url)
  const source = await Bun.file(new URL("packages/core/package.json", root)).json()
  const track = (await Bun.file(new URL(".github/ocv-track", root)).text()).trim()
  console.log(
    JSON.stringify(
      planRelease({
        base: source.version,
        track,
        forkChanges: process.env.OCV_FORK_CHANGES === "true",
        upstream: await Bun.file(upstream).json(),
        releases: await Bun.file(releases).json(),
      }),
    ),
  )
}
