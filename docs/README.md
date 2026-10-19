# GitHub Pages site

This directory is the GitHub Pages publish root for opencode-vim.
It is separate from the product docs in `packages/web/src/content/docs`.

```bash
bun run build:site
```

This runs `docs/build.ts` and writes the static landing page to `docs/index.html`.

Preview:

```bash
python3 -m http.server 8000 -d docs
```
