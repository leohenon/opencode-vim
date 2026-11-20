#!/usr/bin/env bun

import { rm } from "node:fs/promises"
import path from "node:path"

const installCommands = {
  v2: {
    npm: "npm i -g @leohenon/ocv@ocv-v2",
    homebrew: "brew install leohenon/tap/ocv-v2",
    curl: "curl -fsSL https://raw.githubusercontent.com/leohenon/opencode-vim/ocv/install.sh | sh",
  },
  v1: {
    npm: "npm i -g @leohenon/ocv@latest",
    homebrew: "brew install leohenon/tap/ocv",
    curl: "curl -fsSL https://raw.githubusercontent.com/leohenon/opencode-vim/ocv1/install.sh | sh",
  },
}

const repository = "https://github.com/leohenon/opencode-vim"

const forkInstructions = {
  v2: { url: `${repository}#installation` },
  v1: { url: `${repository}/tree/ocv1#installation` },
}

const pluginInstructions = {
  v2: {
    command: "opencode plugin add @leohenon/opencode-vim-plugin",
    requirement: "For OpenCode v2 (2.0.25+).",
    url: "https://github.com/leohenon/opencode-vim-plugin/tree/main#installation",
  },
  v1: {
    command: "opencode plugin @leohenon/opencode-vim-plugin@0.1.6 --global",
    requirement: "For OpenCode v1 (1.17.10+).",
    url: "https://github.com/leohenon/opencode-vim-plugin/tree/v1#installation",
  },
}

const pluginRepository = "https://github.com/leohenon/opencode-vim-plugin"

/** Reads the fork README from this checkout and the plugin README from GitHub, unless a local copy is given. */
async function readmes() {
  const plugin = process.env.OCV_PLUGIN_README
    ? await Bun.file(process.env.OCV_PLUGIN_README).text()
    : await fetch("https://raw.githubusercontent.com/leohenon/opencode-vim-plugin/main/README.md").then((response) => {
        if (!response.ok) throw new Error(`Could not fetch the plugin README: HTTP ${response.status}`)
        return response.text()
      })
  return { fork: await Bun.file(path.join(import.meta.dir, "../README.md")).text(), plugin }
}

type DocsPage = {
  set: string
  title: string
  slug: string
  html: string
  contents: { level: number; id: string; title: string }[]
}

const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

/**
 * Renders each named README section, with its subsections, as one docs page. A missing section fails the build so a
 * renamed README heading cannot silently drop documentation, and links between sections point at the right page.
 */
function readmePages(input: {
  markdown: string
  set: string
  name: string
  repository: string
  /** Page sections; `include` appends other sections to a page as its subsections. */
  sections: (string | { title: string; include: string[] })[]
  omit?: string[]
  /** README lines, by prefix, left out of the docs. */
  omitLines?: string[]
}): DocsPage[] {
  const lines = input.markdown.split("\n")
  let fenced = false
  const headings = lines.flatMap((line, index) => {
    if (line.trimStart().startsWith("```")) fenced = !fenced
    const match = fenced ? undefined : /^(#{1,6}) (.+?)\s*$/.exec(line)
    return match ? [{ index, level: match[1]!.length, title: match[2]! }] : []
  })
  const range = (title: string) => {
    const start = headings.findIndex((heading) => heading.title === title)
    if (start === -1) throw new Error(`${input.name} README has no "${title}" section`)
    const end = headings.slice(start + 1).find((heading) => heading.level <= headings[start]!.level)
    return { heading: headings[start]!, end: end?.index ?? lines.length }
  }
  const omitted = (input.omit ?? []).map(range)
  for (const prefix of input.omitLines ?? [])
    if (!lines.some((line) => line.startsWith(prefix)))
      throw new Error(`${input.name} README has no line starting "${prefix}"`)
  // Returns a section's lines from `from`, with its own heading at `level`.
  const markdownOf = (title: string, from: "heading" | "body", level: number) => {
    const section = range(title)
    const start = from === "heading" ? section.heading.index : section.heading.index + 1
    const shift = level - section.heading.level
    return lines
      .slice(start, section.end)
      .filter((_, offset) => !omitted.some((item) => start + offset >= item.heading.index && start + offset < item.end))
      .filter((line) => !(input.omitLines ?? []).some((prefix) => line.startsWith(prefix)))
      .map((line, offset) => {
        const heading = headings.find((item) => item.index === start + offset)
        return heading ? `${"#".repeat(heading.level + shift)} ${heading.title}` : line
      })
      .join("\n")
  }
  const pages = input.sections.map((entry) => {
    const title = typeof entry === "string" ? entry : entry.title
    // The section heading is the page title; its subsections, and any included sections, start at h2.
    const markdown = [
      markdownOf(title, "body", 1),
      ...(typeof entry === "string" ? [] : entry.include.map((item) => markdownOf(item, "heading", 2))),
    ].join("\n\n")
    const html = Bun.markdown
      .html(markdown, { headings: { ids: true } })
      .replace(/ href="(?!https?:|#|mailto:)(?:\.\/)?([^"]+)"/g, ` href="${input.repository}/blob/HEAD/$1"`)
      .replace(/<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\n?/g, (_, kind: string) => {
        return `<p class="alert">${kind[0]}${kind.slice(1).toLowerCase()}</p>\n<p>`
      })
      .replaceAll("<p></p>\n", "")
      .replaceAll("<table>", '<div class="table"><table>')
      .replaceAll("</table>", "</table></div>")
    const contents = [...html.matchAll(/<h([23]) id="([^"]+)">(.*?)<\/h\1>/g)].map(([, level, id, text]) => ({
      level: Number(level),
      id: id!,
      title: text!.replace(/<[^>]+>/g, ""),
    }))
    return { set: input.set, title, slug: slug(title), html, contents }
  })
  return pages.map((page) => ({
    ...page,
    html: page.html.replace(/ href="#([^"]+)"/g, (_, target: string) => {
      if (page.contents.some((item) => item.id === target)) return ` href="#${target}"`
      const owner = pages.find((item) => item.slug === target || item.contents.some((entry) => entry.id === target))
      if (!owner) throw new Error(`${input.name} docs link to a missing section: #${target}`)
      return ` href="../${owner.slug}/${owner.slug === target ? "" : `#${target}`}"`
    }),
  }))
}

const githubIcon = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>`

const logo = `          <svg viewBox="0 0 126 42" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M0 12H6V18H0V12ZM0 24H6V30H0V24Z" fill="#6F6868"/>
            <path d="M30 30H18V18H30V30Z" fill="#4B4646"/>
            <path d="M30 12H18V30H30V12ZM36 36H12V6H36V36Z" fill="#B7B1B1"/>
            <path d="M66 30H48V18H66V30Z" fill="#4B4646"/>
            <path d="M66 12H48V30H66V36H42V6H66V12Z" fill="#B7B1B1"/>
            <path d="M72 6H78V18H72V6ZM96 6H102V18H96V6ZM78 18H84V30H78V18ZM90 18H96V30H90V18ZM84 30H90V36H84V30Z" fill="#F1ECEC"/>
            <path class="cursor" d="M108 6H126V36H108V6Z" fill="#F1ECEC"/>
          </svg>`

function page(input: {
  root: string
  meta: string
  social?: string
  styles?: string
  wide?: boolean
  /** The header link; defaults to the docs. */
  link?: { label: string; href: string }
  logoHref: string
  main: string
  script: string
}) {
  const root = input.root
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
${input.meta}  <link rel="icon" type="image/png" sizes="96x96" href="${root}favicon.png" />
${input.social ?? ""}  <style>
    @font-face {
      font-family: "IBM Plex Mono";
      font-style: normal;
      font-display: swap;
      font-weight: 400;
      src: url("${root}assets/fonts/ibm-plex-mono-latin-400-normal.woff2") format("woff2");
    }
    @font-face {
      font-family: "IBM Plex Mono";
      font-style: normal;
      font-display: swap;
      font-weight: 500;
      src: url("${root}assets/fonts/ibm-plex-mono-latin-500-normal.woff2") format("woff2");
    }
    @font-face {
      font-family: "IBM Plex Mono";
      font-style: normal;
      font-display: swap;
      font-weight: 600;
      src: url("${root}assets/fonts/ibm-plex-mono-latin-600-normal.woff2") format("woff2");
    }
    @font-face {
      font-family: "IBM Plex Mono";
      font-style: normal;
      font-display: swap;
      font-weight: 700;
      src: url("${root}assets/fonts/ibm-plex-mono-latin-700-normal.woff2") format("woff2");
    }

    :root {
      color-scheme: dark;
      --bg: #131010;
      --panel: #1b1818;
      --panel-soft: #232020;
      --border: #3d3838;
      --text: #f1ecec;
      --muted: #9d9696;
      --dim: #6f6868;
      --accent: #ffffff;
      --code: #171313;
      --green: #7ee787;
      --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      --max: 980px;
    }

    * { box-sizing: border-box; }
    html { background: var(--bg); }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-mono);
      line-height: 1.5;
      letter-spacing: -0.025em;
      -webkit-font-smoothing: antialiased;
    }

    a { color: var(--text); text-decoration: none; }
    a:hover { color: white; text-decoration: underline; }
    code, pre, button { font: inherit; }
    code { color: var(--text); }
    .page { width: min(var(--max), 100%); margin: 0 auto; border-left: 1px solid var(--border); border-right: 1px solid var(--border); min-height: 100vh; }
    .wrap { max-width: 860px; margin: 0 auto; padding: 0 2rem; }

    header { border-bottom: 1px solid var(--border); }
    header .wrap { max-width: 860px; }
    .nav { min-height: 68px; display: flex; align-items: center; justify-content: space-between; gap: 2rem; }
    .logo { display: inline-flex; align-items: center; line-height: 1; }
    .logo:hover { text-decoration: none; }
    .logo svg { width: auto; height: 27px; display: block; }
    .logo .cursor { animation: cursor-blink 1.6s step-end infinite; }
    @keyframes cursor-blink { 50% { opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .logo .cursor { animation: none; } }
    .links { display: flex; align-items: center; gap: 1.65rem; color: var(--muted); font-size: 0.94rem; }
    .links a { color: var(--muted); }
    .links a:hover { color: var(--text); }
    .download { display: inline-flex; align-items: center; gap: 0.45rem; min-height: 38px; padding: 0 0.8rem; border-radius: 4px; background: var(--text); color: #171313 !important; font-weight: 650; }
    .download:hover { color: #171313; text-decoration: none; background: white; }

    .hero { padding: 5.25rem 0 4.5rem; border-bottom: 1px solid var(--border); }
    h1 { max-width: 760px; margin: 0; font-size: clamp(2rem, 3vw, 2.25rem); line-height: 1.2; letter-spacing: -0.025em; font-weight: 700; }
    .lede { max-width: 720px; margin: 1rem 0 2rem; color: var(--muted); font-size: 0.95rem; }

    .install { max-width: 860px; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; background: var(--panel); }
    .tabs { display: flex; gap: 1.75rem; padding: 0 1.1rem; border-bottom: 1px solid var(--border); }
    .tab { appearance: none; border: 0; border-bottom: 1px solid transparent; margin-bottom: -1px; padding: 0.55rem 0; background: transparent; color: var(--dim); cursor: pointer; }
    .tab:hover { color: var(--text); }
    .tab[aria-pressed="true"] { color: var(--text); border-color: var(--text); }
    .command-row { display: flex; align-items: center; justify-content: flex-start; padding: 0.75rem 1.1rem; color: var(--muted); }
    .command-inner { display: inline-flex; align-items: center; gap: 0.625rem; max-width: 100%; min-width: 0; padding: 0.15rem 0.45rem; border-radius: 4px; }
    .command-inner:hover { background: #232020; }
    .prompt { color: var(--dim); user-select: none; }
    .command-row code { display: block; min-width: 0; white-space: nowrap; overflow-x: auto; scrollbar-width: none; -ms-overflow-style: none; }
    .command-row code::-webkit-scrollbar { width: 0; height: 0; display: none; }
    .run-row { padding: 0 1.55rem 0.9rem; color: var(--muted); }
    .run-row code { color: var(--text); }
    .copy { appearance: none; border: 0; background: transparent; color: var(--dim); cursor: pointer; padding: 0; line-height: 1; display: inline-flex; align-items: center; flex-shrink: 0; }
    .command-inner:hover .copy { color: var(--text); }
    .copy svg { width: 1rem; height: 1rem; display: block; }

    .demo { border-bottom: 1px solid var(--border); background: #0f0f0f; }
    .demo video { display: block; width: 100%; height: auto; object-fit: contain; opacity: 0.92; }

    section { padding: 2.6rem 0; border-bottom: 1px solid var(--border); }
    h2 { margin: 0 0 1.25rem; font-size: 1.05rem; letter-spacing: -0.04em; }
    p { color: var(--muted); }
    .features { display: grid; grid-template-columns: 1fr; gap: 1.4rem; margin-top: 0; }
    .feature { display: grid; grid-template-columns: auto 1fr; gap: 0.8rem; }
    .mark { color: var(--text); }
    .feature strong { display: block; margin-bottom: 0.2rem; color: var(--text); }
    .feature p { margin: 0; font-size: 0.94rem; }

    .usage { display: grid; gap: 1rem; }
    .usage-row { display: grid; grid-template-columns: 12rem 1fr; gap: 1rem; padding-top: 1rem; border-top: 1px solid var(--border); }
    .usage-row:first-child { border-top: 0; padding-top: 0; }
    .usage-row strong { color: var(--text); }
    .usage-row p { margin: 0; }

    .media { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
    figure { margin: 0; }
    figure img { display: block; width: 100%; border: 1px solid var(--border); border-radius: 4px; }
    figcaption { margin-top: 0.65rem; color: var(--muted); font-size: 0.9rem; }

    .reference { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
    .reference p { margin: 0.25rem 0 0; }
    .button { display: inline-flex; align-items: center; min-height: 38px; padding: 0 0.8rem; border: 1px solid var(--border); border-radius: 4px; color: var(--text); }
    .button:hover { background: var(--panel-soft); text-decoration: none; }
    .panel-link { display: inline-flex; align-items: center; gap: 0.45rem; color: var(--muted); font-size: 0.94rem; }
    .panel-link:hover { color: var(--text); text-decoration: none; }
    .tabs .panel-link { margin-left: auto; align-self: center; flex-shrink: 0; }
    .panel-link svg { width: 1.1rem; height: 1.1rem; display: block; }
    #plugin .lede { margin-bottom: 1.5rem; }
    footer { padding: 2rem 0; color: var(--dim); font-size: 0.9rem; }
    footer a { color: var(--muted); }

    @media (max-width: 760px) {
      .page { border: 0; }
      .wrap { padding: 0 1rem; }
      .nav { min-height: 64px; padding: 0.85rem 1.25rem; gap: 1rem; }
      .logo svg { height: 24px; }
      .links { flex-wrap: nowrap; gap: 1rem; font-size: 0.9rem; }
      .hero { padding: 3rem 0; }
      .features, .media { grid-template-columns: 1fr; }
      .usage-row { grid-template-columns: 1fr; gap: 0.25rem; }
      .reference { align-items: flex-start; flex-direction: column; }
    }

    @media (max-width: 380px) {
      .nav { padding-inline: 1rem; gap: 0.75rem; }
      .logo svg { height: 22px; }
      .links { gap: 0.75rem; font-size: 0.85rem; }
    }
${input.styles ?? ""}  </style>
</head>
<body>
  <div class="page${input.wide ? " wide" : ""}">
    <header>
      <div class="wrap nav">
        <a class="logo" href="${input.logoHref}" aria-label="OpenCode Vim">
${logo}
        </a>
        <nav class="links" aria-label="Primary navigation">
          <a href="${input.link?.href ?? `${root}docs/`}">${input.link?.label ?? "Docs"}</a>
        </nav>
      </div>
    </header>

${input.main}    <footer>
      <div class="wrap">MIT License</div>
    </footer>
  </div>

  <script>
${input.script}  </script>
</body>
</html>
`
}

// Built after the docs so its Docs link can skip the /docs/ redirect.
const home = () =>
  page({
    root: "./",
    logoHref: "#top",
    link: { label: "Docs", href: `./docs/${docsPages[0]!.set}/${docsPages[0]!.slug}/` },
    meta: `  <title>OpenCode Vim — Vim mode for OpenCode</title>
  <meta name="description" content="OpenCode Vim adds built-in Vim mode, motions, navigation, and editing to OpenCode. Install ocv with curl, npm, or Homebrew." />
  <meta name="robots" content="index, follow" />
  <meta name="google-site-verification" content="UjHhjkxtdlxI3GCTbzUTqHcEL2e9HReKMMLegR3W7co" />
  <link rel="canonical" href="https://leohenon.github.io/opencode-vim/" />
  <link rel="sitemap" type="application/xml" href="https://leohenon.github.io/opencode-vim/sitemap.xml" />
`,
    social: `  <meta property="og:title" content="OpenCode Vim — Vim mode for OpenCode" />
  <meta property="og:description" content="OpenCode Vim adds built-in Vim mode, motions, navigation, and editing to OpenCode." />
  <meta property="og:site_name" content="OpenCode Vim" />
  <meta property="og:url" content="https://leohenon.github.io/opencode-vim/" />
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary" />
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "name": "OpenCode Vim",
    "alternateName": "ocv",
    "description": "OpenCode Vim adds built-in Vim mode, motions, navigation, and editing to OpenCode.",
    "url": "https://leohenon.github.io/opencode-vim/",
    "sameAs": ["https://github.com/leohenon/opencode-vim", "https://www.npmjs.com/package/@leohenon/ocv"],
    "codeRepository": "https://github.com/leohenon/opencode-vim",
    "operatingSystem": "Linux, macOS",
    "applicationCategory": "DeveloperApplication"
  }
  </script>
`,
    main: `    <main id="top">
      <section class="hero" id="install">
        <div class="wrap">
          <h1>Vim mode for OpenCode</h1>
          <p class="lede">An unofficial OpenCode fork and plugin with built-in Vim motions, navigation, and editing.</p>

          <div class="install">
            <div class="tabs" aria-label="OpenCode version">
              <button class="tab" type="button" data-version="v2" aria-pressed="true">v2</button>
              <button class="tab" type="button" data-version="v1" aria-pressed="false">v1</button>
              <a id="fork-instructions" class="panel-link" href="${forkInstructions.v2.url}" aria-label="Fork installation instructions on GitHub">
                ${githubIcon}
              </a>
            </div>
            <div class="tabs" aria-label="Install method">
              <button class="tab" type="button" data-install="curl" aria-pressed="true">curl</button>
              <button class="tab" type="button" data-install="npm" aria-pressed="false">npm</button>
              <button class="tab" type="button" data-install="homebrew" aria-pressed="false">brew</button>
            </div>
            <div class="command-row">
              <div class="command-inner">
                <span class="prompt" aria-hidden="true">$</span><code id="install-command">curl -fsSL https://raw.githubusercontent.com/leohenon/opencode-vim/ocv/install.sh | sh</code>
                <button class="copy" type="button" aria-label="Copy install command" title="Copy">
                  <svg viewBox="0 0 512 512" aria-hidden="true"><rect width="336" height="336" x="128" y="128" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="32" rx="57" ry="57"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32" d="m383.5 128 .5-24a56.16 56.16 0 0 0-56-56H112a64.19 64.19 0 0 0-64 64v216a56.16 56.16 0 0 0 56 56h24"/></svg>
                </button>
              </div>
            </div>
            <div class="run-row"><span class="prompt" aria-hidden="true">$</span> <code>ocv</code></div>
          </div>
        </div>
      </section>

      <div class="demo">
        <video autoplay muted loop playsinline aria-label="OpenCode Vim editing demo (V1 interface)">
          <source src="./assets/ocv.mp4" type="video/mp4" />
        </video>
      </div>

      <section>
        <div class="wrap">
          <div class="features">
            <div class="feature"><span class="mark">[*]</span><div><strong>Vim motions</strong><p>Operators, text objects, visual selection, undo, repeat.</p></div></div>
            <div class="feature"><span class="mark">[*]</span><div><strong>Session navigation</strong><p>Move through session output with Vim controls.</p></div></div>
            <div class="feature"><span class="mark">[*]</span><div><strong>Copy mode</strong><p>Select and copy text from sessions.</p></div></div>
            <div class="feature"><span class="mark">[*]</span><div><strong>Up to date</strong><p>Tracks upstream OpenCode V2 releases.</p></div></div>
          </div>
        </div>
      </section>

      <section id="plugin">
        <div class="wrap">
          <h2>Prefer a plugin?</h2>
          <p class="lede">The prompt Vim mode is also available as a plugin for the official OpenCode — no fork required. Motions, operators, text objects, registers, and more, in the prompt only.</p>
          <div class="install">
            <div class="tabs" aria-label="Plugin OpenCode version">
              <button class="tab" type="button" data-plugin-version="v2" aria-pressed="true">v2</button>
              <button class="tab" type="button" data-plugin-version="v1" aria-pressed="false">v1</button>
              <a id="plugin-instructions" class="panel-link" href="${pluginInstructions.v2.url}" aria-label="Plugin installation instructions on GitHub">
                ${githubIcon}
              </a>
            </div>
            <div class="command-row">
              <div class="command-inner">
                <span class="prompt" aria-hidden="true">$</span><code id="plugin-command">${pluginInstructions.v2.command}</code>
                <button class="copy" type="button" aria-label="Copy plugin install command" title="Copy">
                  <svg viewBox="0 0 512 512" aria-hidden="true"><rect width="336" height="336" x="128" y="128" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="32" rx="57" ry="57"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32" d="m383.5 128 .5-24a56.16 56.16 0 0 0-56-56H112a64.19 64.19 0 0 0-64 64v216a56.16 56.16 0 0 0 56 56h24"/></svg>
                </button>
              </div>
            </div>
          </div>
          <p id="plugin-requirement" aria-live="polite">${pluginInstructions.v2.requirement}</p>
        </div>
      </section>
    </main>

`,
    script: `    const installCommands = ${JSON.stringify(installCommands)}
    const forkInstructions = ${JSON.stringify(forkInstructions)}
    const installCommand = document.querySelector("#install-command")
    const installButtons = document.querySelectorAll("[data-install]")
    const versionButtons = document.querySelectorAll("[data-version]")
    let version = "v2"
    let method = "curl"
    const updateCommand = () => {
      installCommand.textContent = installCommands[version][method]
    }

    versionButtons.forEach((button) => {
      button.addEventListener("click", () => {
        versionButtons.forEach((item) => item.setAttribute("aria-pressed", String(item === button)))
        version = button.dataset.version
        updateCommand()
        document.querySelector("#fork-instructions").href = forkInstructions[version].url
      })
    })

    installButtons.forEach((button) => {
      button.addEventListener("click", () => {
        installButtons.forEach((item) => item.setAttribute("aria-pressed", String(item === button)))
        method = button.dataset.install
        updateCommand()
      })
    })

    const pluginInstructions = ${JSON.stringify(pluginInstructions)}
    const pluginVersionButtons = document.querySelectorAll("[data-plugin-version]")
    pluginVersionButtons.forEach((button) => {
      button.addEventListener("click", () => {
        pluginVersionButtons.forEach((item) => item.setAttribute("aria-pressed", String(item === button)))
        const selected = pluginInstructions[button.dataset.pluginVersion]
        document.querySelector("#plugin-command").textContent = selected.command
        document.querySelector("#plugin-requirement").textContent = selected.requirement
        document.querySelector("#plugin-instructions").href = selected.url
      })
    })

    document.querySelectorAll(".copy").forEach((copyButton) => {
      const icon = copyButton.innerHTML
      const code = copyButton.closest(".command-inner").querySelector("code")
      copyButton.addEventListener("click", async () => {
        await navigator.clipboard.writeText(code.textContent)
        copyButton.innerHTML = "✓"
        setTimeout(() => {
          copyButton.innerHTML = icon
        }, 900)
      })
    })
`,
  })

const sources = await readmes()
const docsSets = [
  {
    id: "plugin",
    title: "Plugin",
    pages: readmePages({
      markdown: sources.plugin,
      set: "plugin",
      name: "Plugin",
      repository: pluginRepository,
      sections: [{ title: "Installation", include: ["Usage"] }, "Prompt controls", "Configuration", "Troubleshooting"],
    }),
  },
  {
    id: "fork",
    title: "Fork",
    pages: readmePages({
      markdown: sources.fork,
      set: "fork",
      name: "Fork",
      repository,
      sections: [
        { title: "Installation", include: ["Usage"] },
        "Prompt controls",
        "Copy mode",
        "Dialog controls",
        { title: "Configuration", include: ["Minimal UI"] },
      ],
      omit: ["Custom integrations"],
      omitLines: ["For a plugin option, see "],
    }),
  },
]
const docsPages = docsSets.flatMap((set) => set.pages)

const docsStyles = `    .page.wide { width: 100%; max-width: 1440px; border: 0; }
    .page.wide .wrap { max-width: none; padding: 0 2rem; }
    .docs { display: grid; grid-template-columns: 13rem minmax(0, 1fr) 12rem; gap: 3.5rem; padding: 2.5rem 2rem 4rem; }
    .docs-sidebar, .docs-contents { position: sticky; top: 2rem; align-self: start; max-height: calc(100vh - 4rem); overflow-y: auto; scrollbar-width: none; }
    .docs-group + .docs-group { margin-top: 1.75rem; }
    .docs-label { display: block; margin-bottom: 0.6rem; color: var(--dim); font-size: 0.75rem; letter-spacing: 0.06em; text-transform: uppercase; }
    .docs ul { margin: 0; padding: 0; list-style: none; }
    .docs-nav a { display: flex; gap: 0.75rem; padding: 0.3rem 0; color: var(--muted); }
    .docs-nav a:hover, .docs-contents a:hover { color: var(--text); text-decoration: none; }
    .docs-nav .bracket { color: var(--dim); white-space: pre; }
    .docs-nav a[aria-current="page"], .docs-nav a[aria-current="page"] .bracket { color: var(--text); }
    .docs-contents a { display: block; padding: 0.3rem 0 0.3rem 0.9rem; border-left: 1px solid var(--border); color: var(--muted); font-size: 0.9rem; }
    .docs-contents li[data-level="3"] a { padding-left: 1.6rem; }
    .docs-contents a.active { color: var(--text); border-color: var(--text); }
    .docs-menu { display: none; }
    .article { min-width: 0; max-width: 46rem; font-size: 0.94rem; }
    .article h1 { margin: 0 0 1.5rem; font-size: 2rem; font-weight: 500; }
    .article h2 { margin: 2.5rem 0 0.75rem; font-size: 1.05rem; font-weight: 600; }
    .article h3 { margin: 2rem 0 0.5rem; font-size: 0.98rem; font-weight: 600; }
    .article p, .article li { color: var(--muted); }
    .article a { text-decoration: underline; text-underline-offset: 0.15em; }
    .article :not(pre) > code { padding: 0.05rem 0.3rem; border: 1px solid var(--border); border-radius: 3px; background: var(--panel); }
    .article pre { margin: 1rem 0; padding: 1rem 1.1rem; overflow-x: auto; border: 1px solid var(--border); background: var(--code); }
    .article .table { margin: 1rem 0; overflow-x: auto; }
    .article table { width: 100%; border-collapse: collapse; }
    .article th, .article td { padding: 0.55rem 0.75rem; border: 1px solid var(--border); text-align: left; vertical-align: top; }
    .article th { color: var(--text); font-size: 0.75rem; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; }
    .article td { color: var(--muted); }
    .article blockquote { margin: 1rem 0; padding: 0.1rem 1rem; border-left: 2px solid var(--border); }
    .article blockquote p { margin: 0.5rem 0; }
    .article .alert { color: var(--text); font-weight: 600; }

    @media (max-width: 1100px) {
      .docs { grid-template-columns: 13rem minmax(0, 1fr); }
      .docs-contents { display: none; }
    }

    @media (max-width: 760px) {
      .page.wide .wrap { padding: 0 1.25rem; }
      .docs { display: block; padding: 0 0 3rem; }
      .docs-sidebar { display: none; }
      .docs-menu { display: block; border-bottom: 1px solid var(--border); }
      .docs-menu summary { display: flex; justify-content: space-between; padding: 0.9rem 1.25rem; cursor: pointer; list-style: none; }
      .docs-menu summary::-webkit-details-marker { display: none; }
      .docs-menu summary::after { content: "›"; color: var(--muted); }
      .docs-menu[open] summary::after { transform: rotate(90deg); }
      .docs-menu .docs-nav { padding: 0 1.25rem 1rem; }
      .article { padding: 2rem 1.25rem 0; }
    }
`

function docsNav(current: DocsPage) {
  return docsSets
    .map(
      (set) => `              <div class="docs-group">
                <span class="docs-label" id="docs-${set.id}">${set.title}</span>
                <ul aria-labelledby="docs-${set.id}">
${set.pages
  .map((page) => {
    const active = page === current
    return `                  <li><a href="../../${page.set}/${page.slug}/"${active ? ' aria-current="page"' : ""}><span class="bracket">${active ? "[-]" : "[ ]"}</span>${page.title}</a></li>`
  })
  .join("\n")}
                </ul>
              </div>`,
    )
    .join("\n")
}

function docsPage(current: DocsPage) {
  const set = docsSets.find((item) => item.id === current.set)!
  return page({
    root: "../../../",
    wide: true,
    link: { label: "Home", href: "../../../" },
    logoHref: "../../../",
    styles: docsStyles,
    meta: `  <title>${current.title} — ${set.title} docs — OpenCode Vim</title>
  <meta name="description" content="${set.title} documentation for OpenCode Vim: ${current.title.toLowerCase()}." />
  <link rel="canonical" href="https://leohenon.github.io/opencode-vim/docs/${current.set}/${current.slug}/" />
`,
    main: `    <main class="docs">
      <details class="docs-menu">
        <summary>${set.title}: ${current.title}</summary>
        <nav class="docs-nav" aria-label="Docs pages">
${docsNav(current)}
        </nav>
      </details>
      <aside class="docs-sidebar">
        <nav class="docs-nav" aria-label="Docs pages">
${docsNav(current)}
        </nav>
      </aside>
      <article class="article">
        <h1>${current.title}</h1>
${current.html}
      </article>
      <aside class="docs-contents">
${
  current.contents.length > 1
    ? `        <span class="docs-label" id="docs-contents">Contents</span>
        <ul aria-labelledby="docs-contents">
${current.contents.map((item) => `          <li${item.level === 3 ? ' data-level="3"' : ""}><a href="#${item.id}">${item.title}</a></li>`).join("\n")}
        </ul>`
    : ""
}
      </aside>
    </main>

`,
    script: `    const contents = [...document.querySelectorAll(".docs-contents a")]
    const targets = contents.map((link) => document.getElementById(decodeURIComponent(link.hash.slice(1))))
    const highlight = () => {
      let active = targets[0]
      for (const target of targets) if (target && target.getBoundingClientRect().top < 120) active = target
      contents.forEach((link, index) => link.classList.toggle("active", targets[index] === active))
    }
    addEventListener("scroll", highlight, { passive: true })
    highlight()
`,
  })
}

const first = docsPages[0]!
const docsIndex = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="color-scheme" content="dark" />
  <title>Docs — OpenCode Vim</title>
  <style>html { background: #131010; }</style>
  <meta http-equiv="refresh" content="0; url=${first.set}/${first.slug}/" />
  <link rel="canonical" href="https://leohenon.github.io/opencode-vim/docs/${first.set}/${first.slug}/" />
</head>
<body>
  <a href="${first.set}/${first.slug}/">Docs</a>
</body>
</html>
`

await Bun.write("docs/index.html", home())
await rm("docs/docs", { recursive: true, force: true })
await Bun.write("docs/docs/index.html", docsIndex)
for (const item of docsPages) await Bun.write(`docs/docs/${item.set}/${item.slug}/index.html`, docsPage(item))
console.log(`Generated docs/index.html and ${docsPages.length} docs pages`)
