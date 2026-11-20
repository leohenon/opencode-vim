# GitHub Pages site

This directory is the GitHub Pages publish root for opencode-vim.

```bash
bun run build:site
```

This runs `docs/build.ts`, which writes:

- `docs/index.html`: the landing page. Commit it alongside generator changes.
- `docs/docs/`: the docs, one page per README section, with `/docs/` redirecting to the first page. They are generated, not committed (`docs/.gitignore`).

The docs render selected sections of this repository's `README.md` and the [plugin README](https://github.com/leohenon/opencode-vim-plugin/blob/main/README.md), chosen by heading in `docs/build.ts`. The plugin README is fetched from GitHub; set `OCV_PLUGIN_README` to a local file to build offline. A renamed or missing section fails the build.

The `ocv-pages.yml` workflow builds and checks the site for pull requests targeting `ocv`. It deploys to GitHub Pages when:

- `docs/`, `README.md`, `package.json`, or the workflow changes on `ocv`.
- The plugin repository's `website.yml` workflow sends a `plugin-readme` dispatch after its README changes on `main`. That workflow needs an `OCV_SITE_DISPATCH_TOKEN` secret: a fine-grained token for `leohenon/opencode-vim` with Contents read and write access.
- It is run manually.

PRs never deploy. The existing demo video shows the V1 interface.
