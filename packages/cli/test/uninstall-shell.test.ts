import { expect, test } from "bun:test"
import path from "node:path"
import { cleanShellConfig } from "../src/util/shell-config"

const home = path.resolve("fixture-home")
const bin = path.join(home, ".ocv", "bin")
const options = { home, bins: [bin], product: "ocv" }

test("OCV cleanup removes its installer entries without removing official OpenCode", () => {
  const official = `# opencode\nexport PATH="${path.join(home, ".opencode", "bin")}:$PATH"\n`
  const own = `# OCV\nexport PATH="${bin}:$PATH"\n`
  expect(cleanShellConfig(official + own, options)).toBe(official)
  expect(cleanShellConfig(own + official, options)).toBe(official)
  expect(cleanShellConfig(official, options)).toBe(official)
})

test("cleanup handles fish and home-relative shell entries", () => {
  for (const directory of [bin, "~/.ocv/bin", "$HOME/.ocv/bin", "${HOME}/.ocv/bin"]) {
    for (const entry of [`export PATH="${directory}:$PATH"`, `fish_add_path "${directory}"`]) {
      expect(cleanShellConfig(`# OCV\n${entry}\n# keep\n`, options)).toBe("# keep\n")
    }
  }
})

test("cleanup preserves mixed, similar and unrelated PATH entries", () => {
  const text = [
    `export PATH="${bin}-backup:$PATH"`,
    `export PATH="${bin}:${path.join(home, ".opencode", "bin")}:$PATH"`,
    `export PATH="${path.join(home, ".opencode", "bin")}:$PATH"`,
    `fish_add_path "${bin}" /another/tool`,
    "# unrelated comment",
    "",
  ].join("\n")
  expect(cleanShellConfig(text, options)).toBe(text)
})

test("cleanup uses the actual install directory and keeps other product markers", () => {
  const directory = path.join(home, "custom", "bin")
  const text = `# OCV\nexport PATH="${directory}:$PATH"\n# opencode\nexport PATH="${bin}:$PATH"\n`
  expect(cleanShellConfig(text, { ...options, bins: [directory] })).toBe(`# opencode\nexport PATH="${bin}:$PATH"\n`)
})

test("cleanup accepts both logical and resolved curl installation paths", () => {
  const resolved = path.resolve("resolved-home", ".ocv", "bin")
  const official = `export PATH="${path.join(home, ".opencode", "bin")}:$PATH"\n`
  const text = `${official}# OCV\nexport PATH="${bin}:$PATH"\n# OCV\nexport PATH="${resolved}:$PATH"\n`
  expect(cleanShellConfig(text, { ...options, bins: [bin, resolved] })).toBe(official)
})
