#!/usr/bin/env bun

const installCommands = {
  npm: "npm i -g @leohenon/ocv",
  homebrew: "brew install leohenon/tap/ocv",
  curl: "curl -fsSL https://raw.githubusercontent.com/leohenon/opencode-vim/ocv/install.sh | sh",
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenCode Vim — Vim mode for OpenCode</title>
  <meta name="description" content="OpenCode Vim adds built-in Vim mode, motions, navigation, and editing to OpenCode. Install ocv with curl, npm, or Homebrew." />
  <meta name="robots" content="index, follow" />
  <meta name="google-site-verification" content="UjHhjkxtdlxI3GCTbzUTqHcEL2e9HReKMMLegR3W7co" />
  <link rel="canonical" href="https://leohenon.github.io/opencode-vim/" />
  <link rel="sitemap" type="application/xml" href="https://leohenon.github.io/opencode-vim/sitemap.xml" />
  <link rel="icon" type="image/png" sizes="96x96" href="./favicon.png" />
  <meta property="og:title" content="OpenCode Vim — Vim mode for OpenCode" />
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
  <style>
    @font-face {
      font-family: "IBM Plex Mono";
      font-style: normal;
      font-display: swap;
      font-weight: 400;
      src: url("./assets/fonts/ibm-plex-mono-latin-400-normal.woff2") format("woff2");
    }
    @font-face {
      font-family: "IBM Plex Mono";
      font-style: normal;
      font-display: swap;
      font-weight: 500;
      src: url("./assets/fonts/ibm-plex-mono-latin-500-normal.woff2") format("woff2");
    }
    @font-face {
      font-family: "IBM Plex Mono";
      font-style: normal;
      font-display: swap;
      font-weight: 600;
      src: url("./assets/fonts/ibm-plex-mono-latin-600-normal.woff2") format("woff2");
    }
    @font-face {
      font-family: "IBM Plex Mono";
      font-style: normal;
      font-display: swap;
      font-weight: 700;
      src: url("./assets/fonts/ibm-plex-mono-latin-700-normal.woff2") format("woff2");
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
    .logo svg { width: 150px; height: auto; display: block; }
    .links { display: flex; align-items: center; gap: 1.65rem; color: var(--muted); font-size: 0.94rem; }
    .links a { color: var(--muted); }
    .links a:hover { color: var(--text); }
    .download { display: inline-flex; align-items: center; gap: 0.45rem; min-height: 38px; padding: 0 0.8rem; border-radius: 4px; background: var(--text); color: #171313 !important; font-weight: 650; }
    .download:hover { color: #171313; text-decoration: none; background: white; }

    .hero { padding: 5.25rem 0 4.5rem; border-bottom: 1px solid var(--border); }
    .kicker { margin: 0 0 0.75rem; color: var(--muted); font-size: 0.95rem; }
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
    .panel-bar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.55rem 1.1rem; border-bottom: 1px solid var(--border); }
    .panel-title { color: var(--dim); font-size: 0.94rem; }
    .panel-link { display: inline-flex; align-items: center; gap: 0.45rem; color: var(--muted); font-size: 0.94rem; }
    .panel-link:hover { color: var(--text); text-decoration: none; }
    .panel-link svg { width: 1.1rem; height: 1.1rem; display: block; }
    #plugin .lede { margin-bottom: 1.5rem; }
    footer { padding: 2rem 0; color: var(--dim); font-size: 0.9rem; }
    footer a { color: var(--muted); }

    @media (max-width: 760px) {
      .page { border: 0; }
      .wrap { padding: 0 1rem; }
      .nav { min-height: 64px; padding: 0.85rem 1.25rem; gap: 1rem; }
      .logo svg { width: 136px; }
      .links { flex-wrap: nowrap; gap: 1rem; font-size: 0.9rem; }
      .hero { padding: 3rem 0; }
      .features, .media { grid-template-columns: 1fr; }
      .usage-row { grid-template-columns: 1fr; gap: 0.25rem; }
      .reference { align-items: flex-start; flex-direction: column; }
    }

    @media (max-width: 380px) {
      .nav { padding-inline: 1rem; gap: 0.75rem; }
      .logo svg { width: 124px; }
      .links { gap: 0.75rem; font-size: 0.85rem; }
    }
  </style>
</head>
<body>
  <div class="page">
    <header>
      <div class="wrap nav">
        <a class="logo" href="#top" aria-label="OpenCode Vim">
          <svg viewBox="0 0 234 42" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M18 30H6V18H18V30Z" fill="#4B4646"/>
            <path d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z" fill="#B7B1B1"/>
            <path d="M48 30H36V18H48V30Z" fill="#4B4646"/>
            <path d="M36 30H48V12H36V30ZM54 36H36V42H30V6H54V36Z" fill="#B7B1B1"/>
            <path d="M84 24V30H66V24H84Z" fill="#4B4646"/>
            <path d="M84 24H66V30H84V36H60V6H84V24ZM66 18H78V12H66V18Z" fill="#B7B1B1"/>
            <path d="M108 36H96V18H108V36Z" fill="#4B4646"/>
            <path d="M108 12H96V36H90V6H108V12ZM114 36H108V12H114V36Z" fill="#B7B1B1"/>
            <path d="M144 30H126V18H144V30Z" fill="#4B4646"/>
            <path d="M144 12H126V30H144V36H120V6H144V12Z" fill="#F1ECEC"/>
            <path d="M168 30H156V18H168V30Z" fill="#4B4646"/>
            <path d="M168 12H156V30H168V12ZM174 36H150V6H174V36Z" fill="#F1ECEC"/>
            <path d="M198 30H186V18H198V30Z" fill="#4B4646"/>
            <path d="M198 12H186V30H198V12ZM204 36H180V6H198V0H204V36Z" fill="#F1ECEC"/>
            <path d="M234 24V30H216V24H234Z" fill="#4B4646"/>
            <path d="M216 12V18H228V12H216ZM234 24H216V30H234V36H210V6H234V24Z" fill="#F1ECEC"/>
          </svg>
        </a>
        <nav class="links" aria-label="Primary navigation">
          <a href="https://github.com/leohenon/opencode-vim">GitHub</a>
          <a href="https://www.npmjs.com/package/@leohenon/ocv">npm</a>
          <a href="https://github.com/leohenon/opencode-vim#features">Docs</a>
        </nav>
      </div>
    </header>

    <main id="top">
      <section class="hero" id="install">
        <div class="wrap">
          <p class="kicker">OpenCode Vim</p>
          <h1>Vim mode for OpenCode</h1>
          <p class="lede">An unofficial OpenCode fork with built-in Vim motions, navigation, and editing.</p>

          <div class="install">
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
        <video autoplay muted loop playsinline aria-label="OpenCode Vim demo">
          <source src="./assets/ocv.mp4" type="video/mp4" />
        </video>
      </div>

      <section>
        <div class="wrap">
          <div class="features">
            <div class="feature"><span class="mark">[*]</span><div><strong>Vim motions</strong><p>Operators, text objects, visual selection, undo, repeat.</p></div></div>
            <div class="feature"><span class="mark">[*]</span><div><strong>Session navigation</strong><p>Move through session output with Vim controls.</p></div></div>
            <div class="feature"><span class="mark">[*]</span><div><strong>Copy mode</strong><p>Select and copy text from sessions.</p></div></div>
            <div class="feature"><span class="mark">[*]</span><div><strong>Up to date</strong><p>Updated daily to stay current with OpenCode releases.</p></div></div>
          </div>
        </div>
      </section>

      <section id="plugin">
        <div class="wrap">
          <h2>Prefer a plugin?</h2>
          <p class="lede">The prompt Vim mode is also available as a plugin for the official OpenCode — no fork required. Motions, operators, text objects, registers, and more, in the prompt only.</p>
          <div class="install">
            <div class="panel-bar">
              <span class="panel-title">opencode-vim-plugin</span>
              <a class="panel-link" href="https://github.com/leohenon/opencode-vim-plugin" aria-label="opencode-vim-plugin on GitHub">
                <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
              </a>
            </div>
            <div class="command-row">
              <div class="command-inner">
                <span class="prompt" aria-hidden="true">$</span><code>opencode plugin @leohenon/opencode-vim-plugin --global</code>
                <button class="copy" type="button" aria-label="Copy plugin install command" title="Copy">
                  <svg viewBox="0 0 512 512" aria-hidden="true"><rect width="336" height="336" x="128" y="128" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="32" rx="57" ry="57"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32" d="m383.5 128 .5-24a56.16 56.16 0 0 0-56-56H112a64.19 64.19 0 0 0-64 64v216a56.16 56.16 0 0 0 56 56h24"/></svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>

    <footer>
      <div class="wrap">MIT License</div>
    </footer>
  </div>

  <script>
    const installCommands = ${JSON.stringify(installCommands)}
    const installCommand = document.querySelector("#install-command")
    const installButtons = document.querySelectorAll("[data-install]")

    installButtons.forEach((button) => {
      button.addEventListener("click", () => {
        installButtons.forEach((item) => item.setAttribute("aria-pressed", String(item === button)))
        installCommand.textContent = installCommands[button.dataset.install]
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
  </script>
</body>
</html>
`

await Bun.write("docs/index.html", html)
console.log("Generated docs/index.html")
