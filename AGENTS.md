# Agent Instructions

This repository is the ocv fork of OpenCode. Treat most code as upstream; keep fork changes focused on Vim mode and copy mode.

## Priorities

- Prefer stability, simplicity, and maintainability over broad rewrites.
- Keep changes surgical and scoped to the requested behavior.

## Branches

- `ocv` is the default V2 branch; base V2 work on it and track upstream `dev`.
- `ocv1` is for V1 maintenance; track upstream `v1`, never upstream `dev`.

## Upstream sync

- On `ocv`, `.github/workflows/` is fork-owned. Preserve its committed tree during upstream merges, including excluded upstream workflows.
- Adopt upstream CI improvements deliberately; do not import or automatically enable upstream workflow definitions.
- Application-source conflicts still require review. Workflow ownership does not extend to source code, build definitions, or dependency locks.

## Vim/copy layout

- Prompt Vim behavior lives under `packages/tui/src/component/vim/`; entry wiring is `packages/tui/src/component/prompt/vim.ts`.
- Copy mode lives in `packages/tui/src/routes/session/copy-mode.ts`; shared Vim integration is `packages/tui/src/component/vim/copy-adapter.ts`.
- Reuse existing motion/operator/repeat state helpers in `component/vim/` instead of duplicating prompt vs copy behavior.
- Update `packages/tui/test/cli/tui/vim-motions.test.ts` for Vim/copy changes.
- Update `README.md` Prompt controls or Copy mode tables when adding user-visible keys.

Read [CONTRIBUTING.md](./CONTRIBUTING.md#commit-messages).
