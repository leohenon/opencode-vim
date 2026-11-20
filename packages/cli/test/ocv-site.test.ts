import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "./fixture/tmpdir"

const root = path.resolve(import.meta.dir, "../../..")

const pluginReadme = `# OpenCode Vim Plugin

## Installation

\`\`\`bash
# not a heading
opencode plugin add @leohenon/opencode-vim-plugin
\`\`\`

## Usage

Toggle with \`/vim\`.

## Prompt controls

| Category | Keys |
| -------- | ---- |
| Plugin keys | \`ciq\` |

> [!NOTE]
> See [the clipboard register](#system-clipboard-register).

## Configuration

### Options

### System clipboard register

Plugin clipboard option.

## Troubleshooting

Plugin tmux tip.

## Local development

Plugin development notes.
`

async function build(readme: string) {
  const directory = await tmpdir()
  await mkdir(path.join(directory.path, "docs"))
  await Bun.write(path.join(directory.path, "plugin-README.md"), readme)
  const child = Bun.spawn([process.execPath, path.join(root, "docs/build.ts")], {
    cwd: directory.path,
    env: { ...process.env, OCV_PLUGIN_README: path.join(directory.path, "plugin-README.md") },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  return { directory, code, stderr }
}

test("website generator reproduces the checked-in site with V1 and V2 install channels", async () => {
  const { directory, code, stderr } = await build(pluginReadme)
  await using _ = directory
  expect(code, stderr).toBe(0)
  const generated = await Bun.file(path.join(directory.path, "docs/index.html")).text()
  expect(generated).toBe(await Bun.file(path.join(root, "docs/index.html")).text())
  const docs = await Bun.file(path.join(directory.path, "docs/docs/plugin/installation/index.html")).text()
  expect(generated).toContain("npm i -g @leohenon/ocv@ocv-v2")
  expect(generated).toContain("npm i -g @leohenon/ocv@latest")
  expect(generated).toContain("brew install leohenon/tap/ocv-v2")
  expect(generated).toContain("/ocv1/install.sh")
  expect(generated).not.toContain("V1 usage and configuration")
  expect(generated).toContain('id="plugin-command">opencode plugin add @leohenon/opencode-vim-plugin</code>')
  expect(generated).not.toContain("opencode-vim-plugin@beta")
  expect(generated).toContain("opencode plugin @leohenon/opencode-vim-plugin@0.1.6 --global")
  expect(generated).toContain('aria-label="Plugin OpenCode version"')
  expect(generated).toContain('data-plugin-version="v1"')
  expect(generated).toMatch(/data-plugin-version="v2"[^>]*>v2<\/button>/)
  expect(generated).toMatch(/data-version="v2"[^>]*>v2<\/button>/)
  expect(generated).toMatch(/data-version="v1"[^>]*>v1<\/button>/)
  expect(generated).toMatch(/data-plugin-version="v1"[^>]*>v1<\/button>\s*<a id="plugin-instructions"/)
  expect(generated).toMatch(/data-version="v1"[^>]*>v1<\/button>\s*<a id="fork-instructions"/)
  expect(generated).toContain(
    'id="fork-instructions" class="panel-link" href="https://github.com/leohenon/opencode-vim#installation"',
  )
  expect(generated).toContain("opencode-vim/tree/ocv1#installation")
  expect(generated).not.toContain('class="panel-bar"')
  expect(generated).toContain("For OpenCode v2 (2.0.25+).")
  expect(generated).toContain("For OpenCode v1 (1.17.10+).")
  expect(generated).toContain("opencode-vim-plugin/tree/v1#installation")
  for (const page of [generated, docs]) {
    expect(page).not.toContain(">GitHub</a>")
    expect(page).not.toContain(">npm</a>")
  }
  expect(generated).toMatch(/<nav class="links"[^>]*>\s*<a href="\.\/docs\/plugin\/installation\/">Docs<\/a>\s*<\/nav>/)
  expect(docs).toMatch(/<nav class="links"[^>]*>\s*<a href="\.\.\/\.\.\/\.\.\/">Home<\/a>\s*<\/nav>/)
  expect(docs).not.toContain("og:url")
  for await (const file of new Bun.Glob("docs/**/*.html").scan({ cwd: directory.path })) {
    const page = await Bun.file(path.join(directory.path, file)).text()
    for (const match of page.matchAll(/(?:src|href|url)\s*(?:=|\()\s*["']?(\.\.?\/[^"')#\s]*)/g)) {
      const relative = path.join(path.dirname(file), match[1]!)
      const target = relative.endsWith("/") || match[1]!.endsWith("/") ? path.join(relative, "index.html") : relative
      const exists = await Promise.all([root, directory.path].map((base) => Bun.file(path.join(base, target)).exists()))
      expect(exists.some(Boolean), `${file} -> ${target}`).toBe(true)
    }
  }
})

test("docs pages render selected sections of the fork and plugin READMEs", async () => {
  const { directory, code, stderr } = await build(pluginReadme)
  await using _ = directory
  expect(code, stderr).toBe(0)
  const read = (file: string) => Bun.file(path.join(directory.path, "docs/docs", file, "index.html")).text()
  const pages = {
    plugin: ["installation", "prompt-controls", "configuration", "troubleshooting"],
    fork: ["installation", "prompt-controls", "copy-mode", "dialog-controls", "configuration"],
  }
  const files = await Array.fromAsync(
    new Bun.Glob("**/index.html").scan({ cwd: path.join(directory.path, "docs/docs") }),
  )
  expect(files.sort()).toEqual(
    [
      "index.html",
      ...Object.entries(pages).flatMap(([set, slugs]) => slugs.map((slug) => `${set}/${slug}/index.html`)),
    ].sort(),
  )
  expect(await read("")).toContain('content="0; url=plugin/installation/"')
  expect(await read("")).toContain("html { background: #131010; }")
  for (const [set, slugs] of Object.entries(pages))
    for (const slug of slugs) {
      const page = await read(`${set}/${slug}`)
      const nav = page.slice(page.indexOf('<aside class="docs-sidebar">'), page.indexOf('<article class="article">'))
      expect([...nav.matchAll(/href="\.\.\/\.\.\/[^"]+"/g)].map((match) => match[0])).toEqual(
        Object.entries(pages).flatMap(([group, items]) => items.map((item) => `href="../../${group}/${item}/"`)),
      )
      expect(nav).toContain(`href="../../${set}/${slug}/" aria-current="page"><span class="bracket">[-]</span>`)
      expect(page).not.toContain("[!NOTE]")
    }
  const prompt = await read("plugin/prompt-controls")
  expect(prompt).toContain("<h1>Prompt controls</h1>")
  expect(prompt).toContain('<p class="alert">Note</p>')
  expect(prompt).toContain('href="../configuration/#system-clipboard-register"')
  expect(prompt).toContain('<div class="table"><table>')
  expect(prompt).not.toContain('class="docs-label" id="docs-contents"')
  const configuration = await read("plugin/configuration")
  expect(configuration).toContain('<h2 id="system-clipboard-register">System clipboard register</h2>')
  expect(configuration).toContain('<li><a href="#system-clipboard-register">System clipboard register</a></li>')
  expect(await read("plugin/troubleshooting")).toContain("Plugin tmux tip.")
  const plugin = (await Promise.all(pages.plugin.map((slug) => read(`plugin/${slug}`)))).join("")
  expect(plugin).not.toContain("Plugin development notes.")
  const installation = await read("plugin/installation")
  expect(installation).toContain("# not a heading")
  expect(installation).not.toContain('id="not-a-heading"')
  expect(installation).toContain("opencode plugin add @leohenon/opencode-vim-plugin")
  expect(installation).toContain('<h2 id="usage">Usage</h2>')
  // A page with a single subsection has no Contents list.
  for (const set of ["plugin", "fork"])
    expect(await read(`${set}/installation`)).not.toContain('class="docs-label" id="docs-contents"')
  expect(await read("fork/configuration")).toContain('class="docs-label" id="docs-contents"')
  expect(installation.indexOf("opencode plugin add")).toBeLessThan(installation.indexOf('<h2 id="usage">'))
  expect(await read("fork/installation")).toContain("brew install leohenon/tap/ocv-v2")
  expect(await read("fork/prompt-controls")).toContain('href="../configuration/#system-clipboard-register"')
  const usage = await read("fork/installation")
  expect(usage).toContain('<h2 id="usage">Usage</h2>')
  expect(usage).toContain("ocv\n</code>")
  expect(usage).not.toContain("Minimal UI")
  expect(usage).toContain("For V1, see")
  expect(usage).not.toContain("For a plugin option")
  const configuration_ = await read("fork/configuration")
  const article = configuration_.slice(configuration_.indexOf("<article"), configuration_.indexOf("</article>"))
  expect(article.match(/<h2 id="[^"]+"/g)?.at(-1)).toBe('<h2 id="minimal-ui"')
  expect(configuration_.match(/<li[^>]*><a href="#[^"]+"/g)?.at(-1)).toBe('<li><a href="#minimal-ui"')
  const fork = (await Promise.all(pages.fork.map((slug) => read(`fork/${slug}`)))).join("")
  expect(fork).not.toContain("Custom integrations")
  expect(fork).not.toContain("Thanks to all contributors")
  expect(fork).not.toContain("ocv upgrade")
})

test("docs build fails when a selected README section is missing", async () => {
  const { directory, code, stderr } = await build(pluginReadme.replace("## Troubleshooting", "## Help"))
  await using _ = directory
  expect(code).not.toBe(0)
  expect(stderr).toContain('Plugin README has no "Troubleshooting" section')
})
