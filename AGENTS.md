# Agent Instructions

This repository is the ocv fork of OpenCode. Treat most code as upstream; keep fork changes focused on Vim mode and copy mode.

## Branches

- `ocv1` maintains V1 and tracks upstream `v1`; never merge upstream `dev` here.
- `ocv` is the default V2 branch and tracks upstream `dev`.
- V1 publishes npm `latest` and Homebrew `ocv`; V2 uses npm `ocv-v2` and Homebrew `ocv-v2`.

## Priorities

- Prefer stability, simplicity, and maintainability over broad rewrites.
- Keep changes surgical and scoped to the requested behavior.

## Vim/copy layout

- Prompt Vim behavior lives under `packages/tui/src/component/vim/`; entry wiring is `packages/tui/src/component/prompt/vim.ts`.
- Copy mode lives in `packages/tui/src/routes/session/copy-mode.ts`; shared Vim integration is `packages/tui/src/component/vim/copy-adapter.ts`.
- Reuse existing motion/operator/repeat state helpers in `component/vim/` instead of duplicating prompt vs copy behavior.
- Update `packages/tui/test/cli/tui/vim-motions.test.ts` for Vim/copy changes.
- Update `README.md` Prompt controls or Copy mode tables when adding user-visible keys.

Read [CONTRIBUTING.md](./CONTRIBUTING.md#commit-messages).
