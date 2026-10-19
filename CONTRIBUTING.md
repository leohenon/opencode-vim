# Contributing

PRs welcome. Open an issue first for large changes.

`ocv` tracks OpenCode. Keep changes focused on Vim mode/copy mode.

## Commit messages

```text
type(scope): summary
```

Types:

- `feat`
- `fix`
- `refactor`
- `test`
- `docs`
- `ci`
- `chore`

Preferred scopes:

- `copy`
- `prompt`
- `tui`
- `config`
- `keymap`
- `vim`
- `upstream`
- `deps`
- `release`

## Development

Use [Bun](https://bun.sh) matching `package.json`.

```bash
bun install
cd packages/cli
bun typecheck
cd ../tui
bun test ./test/cli/tui/vim-*.test.ts
```

## Running locally

```bash
bun dev .
```
