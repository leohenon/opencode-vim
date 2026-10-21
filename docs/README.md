# GitHub Pages site

This directory is the GitHub Pages publish root for opencode-vim.
It is separate from the upstream product docs in `services/www` and `packages/web`.

The landing page defaults to the V2 beta install channel. Its version selector also exposes V1 installation commands and links to the `ocv1` README.

```bash
bun run build:site
```

This runs `docs/build.ts` and writes the static landing page to `docs/index.html`. Commit the generated HTML alongside generator changes.

The `ocv-pages.yml` workflow builds and checks the site for pull requests targeting `ocv`. Pushes to `ocv` deploy it to GitHub Pages; PRs never deploy. The existing demo video shows the V1 interface.

Preview:

```bash
python3 -m http.server 8000 -d docs
```
