<div align="center">

# OpenCode Vim

[![npm version](https://img.shields.io/npm/v/@leohenon/ocv?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@leohenon/ocv) [![CI](https://img.shields.io/github/actions/workflow/status/leohenon/opencode-vim/ci.yml?branch=ocv&style=flat-square&logo=github&logoColor=white&label=CI)](https://github.com/leohenon/opencode-vim/actions/workflows/ci.yml) [![Upstream sync](https://img.shields.io/github/actions/workflow/status/leohenon/opencode-vim/sync-upstream.yml?branch=ocv&style=flat-square&logo=github&logoColor=white&label=upstream%20sync)](https://github.com/leohenon/opencode-vim/actions/workflows/sync-upstream.yml) [![Website](https://img.shields.io/badge/website-opencode--vim-7fa6a3?style=flat-square)](https://leohenon.github.io/opencode-vim/) [![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?style=flat-square&logo=bun&logoColor=white)](https://bun.sh)

Keyboard-first OpenCode with Vim controls across the TUI, kept in sync with upstream releases.

</div>

## Installation

```bash
# curl
curl -fsSL https://raw.githubusercontent.com/leohenon/opencode-vim/ocv/install.sh | sh

# Package managers
npm i -g @leohenon/ocv
brew install leohenon/tap/ocv

# Arch Linux AUR (community-maintained)
yay -S opencode-vim-bin
```

Curl installs to `~/.ocv/bin`. Set `OCV_INSTALL_DIR` to install elsewhere.

## Usage

```bash
ocv
```

## Update

```bash
# built-in updater
ocv update

# Package managers
npm i -g @leohenon/ocv@latest
brew upgrade ocv
```

## Prefer a plugin?

The prompt Vim mode is also available as a plugin for the official OpenCode, prompt editing only (no copy mode or session navigation):

```bash
opencode plugin @leohenon/opencode-vim-plugin --global
```

See [opencode-vim-plugin](https://github.com/leohenon/opencode-vim-plugin).

## Features

### Prompt controls

Toggle via command palette > `Toggle vim mode`.

> Unicode word boundaries are not supported.

| Category                       | Keys                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Character / word               | `h`, `j`, `k`, `l`, `w`, `b`, `e`, `W`, `B`, `E`                                                        |
| Line / buffer                  | `0`, `^`, `_`, `$`, `gg`, `G`                                                                           |
| Display line                   | `gj`, `gk`, `g<Down>`, `g<Up>`, `g0`, `g^`, `g$`                                                        |
| Matching / paragraph           | `%`, `{`, `}`                                                                                           |
| Find / till                    | `f`, `F`, `t`, `T`, `;`, `,`                                                                            |
| Scroll                         | `Ctrl+e`, `Ctrl+y`, `Ctrl+d`, `Ctrl+u`, `Ctrl+f`, `Ctrl+b`                                              |
| Insert / replace               | `i`, `I`, `a`, `A`, `o`, `O`, `R`                                                                       |
| Character / line edit          | `r`, `x`, `~`, `s`, `S`, `J`, `C`, `D`, `dd`, `cc`                                                      |
| Word changes                   | `cw`, `cb`, `ce`, `cW`, `cE`, `ciw`, `caw`, `ciW`, `caW`                                                |
| Word deletes                   | `dw`, `db`, `de`, `dW`, `dE`, `diw`, `daw`, `diW`, `daW`                                                |
| Quote changes                  | `ci"`, `ca"`, `ci'`, `ca'`, ``ci` ``, ``ca` ``                                                          |
| Quote deletes                  | `di"`, `da"`, `di'`, `da'`, ``di` ``, ``da` ``                                                          |
| Bracket changes                | `ci(`, `ca(`, `ci[`, `ca[`, `ci{`, `ca{`, `ci<`, `ca<`                                                  |
| Bracket deletes                | `di(`, `da(`, `di[`, `da[`, `di{`, `da{`, `di<`, `da<`                                                  |
| Find / till operators          | `cf`, `cF`, `ct`, `cT`, `df`, `dF`, `dt`, `dT`                                                          |
| Matching / paragraph operators | `c%`, `d%`, `c}`, `c{`, `d}`, `d{`                                                                      |
| Line boundary operators        | `c0`, `c^`, `c$`, `d0`, `d^`, `d$`, `y0`, `y^`, `y$`                                                    |
| Display line operators         | `cgj`, `cgk`, `cg0`, `cg^`, `cg$`, `dgj`, `dgk`, `dg0`, `dg^`, `dg$`, `ygj`, `ygk`, `yg0`, `yg^`, `yg$` |
| Line / word yanks              | `yy`, `yw`, `ye`, `yW`, `yE`, `yiw`, `yaw`, `yiW`, `yaW`                                                |
| Quote yanks                    | `yi"`, `ya"`, `yi'`, `ya'`, ``yi` ``, ``ya` ``                                                          |
| Bracket yanks                  | `yi(`, `ya(`, `yi[`, `ya[`, `yi{`, `ya{`, `yi<`, `ya<`                                                  |
| Matching / paragraph yanks     | `y%`, `y}`, `y{`                                                                                        |
| Put / undo / repeat            | `p`, `P`, `u`, `Ctrl+r`, `.`                                                                            |
| Visual selection               | `v`, `V`                                                                                                |
| Chat history search            | `/`, `?`                                                                                                |
| Commands                       | `:`, `:q`                                                                                               |

Numeric count prefixes are supported for motions and common operators.

> [!NOTE]
> `<leader>y` copies the prompt selection when present; configure it with `keybinds.prompt_copy_selection`.
> For clipboard sync, see [System clipboard register](#system-clipboard-register).

### Copy mode

Text selection from the chat session view.

> Copy mode collapses code diffs into a single column for easy copying.

| Keys                           | Action                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `<leader>v`, `Ctrl+W k`        | Enter copy mode                                                                               |
| `h`, `j`, `k`, `l`, arrow keys | Navigate                                                                                      |
| `v`, `V`, `Ctrl+V`             | Start character-wise, line-wise, or block selection                                           |
| `y`, `yy`                      | Yank to the vim register                                                                      |
| `Enter`                        | Copy to the system clipboard, toggle expandable tool output, or open a selected subagent task |
| `Y`                            | Yank to the vim register and scroll to the bottom                                             |
| `Shift+Enter`                  | Copy to the system clipboard and scroll to the bottom                                         |
| `Escape`                       | Exit visual mode                                                                              |
| `q`                            | Exit copy mode and scroll to the bottom                                                       |
| `Ctrl+W j`                     | Exit copy mode without scrolling                                                              |
| `Ctrl+W w`                     | Toggle copy mode                                                                              |
| `i`                            | Focus the prompt input in insert mode without scrolling                                       |
| `z`, `zt`, `zz`, `zb`          | Adjust copy-mode scroll positioning                                                           |
| `H`, `M`, `L`                  | Jump to the top, middle, or bottom of the viewport                                            |
| `/`, `?`                       | Search forward or backward in chat history                                                    |
| `n`, `N`                       | Repeat search in the same or opposite direction                                               |

When in search mode, `Enter` submits the search, and `Escape` clears search highlights before exiting copy mode.

> Search uses smartcase, lowercase queries are case-insensitive, and queries containing uppercase letters are case-sensitive.

> [!TIP]
> Configure the copy mode entry key with `keybinds.copy_mode`.

### Dialog controls

Searchable dialogs and custom question answer inputs use modal controls.

| Area               | Controls                                                                |
| ------------------ | ----------------------------------------------------------------------- |
| Input mode         | `Escape` enters normal mode; `i`, `a`, `/`, `I`, `A` return to insert   |
| Input editing      | `h`, `l`, `w`, `b`, `e`, `0`, `$` move within the input; `dd` clears it |
| Searchable dialogs | `j`, `k`, `gg`, `G` move through dialog items                           |
| Question dialogs   | `j`, `k` move through answers; `h`, `l` move between questions          |

> [!TIP]
> Disable modal dialog inputs with `vim_modal_input: false`.

### Minimal UI

Hides extra UI hints and tips.

Toggle via command palette > `Toggle minimal ui`.

## Configuration

### Options

| Option                          | Purpose                                  |
| ------------------------------- | ---------------------------------------- |
| `prompt_max_height`             | Set max prompt input height              |
| `prompt_scrollbar`              | Show the prompt scrollbar                |
| `diff_viewer.command`           | Run an external viewer for `/diff`       |
| `vim_initial_mode`              | Start in `insert` (default) or `normal`  |
| `vim_enter_submit`              | Submit with Enter from insert mode       |
| `vim_insert_after_submit`       | Return to insert mode after submit       |
| `vim_system_clipboard_register` | Use the system clipboard as Vim register |
| `vim_modal_input`               | Enable Vim controls in dialogs           |
| `vim_langmap`                   | Map non-English keys or simple aliases   |
| `vim_line_motions`              | Use wrapped display-line motions         |
| `vim_showbreak`                 | Mark wrapped prompt rows                 |
| `vim_escape_sequence`           | Use a two-key escape sequence like `jk`  |

### Initial mode

Vim mode starts in insert mode by default. To start in normal mode instead:

```json
{
  "vim_initial_mode": "normal"
}
```

### Mode-scoped keybinds

Bind existing commands only in normal mode by nesting overrides under `vim.normal`.

For example, use `<space>` as the leader:

```json
{
  "keybinds": {
    "vim.normal": {
      "leader": "space",
      "session_list": "<leader>s"
    }
  }
}
```

When `vim.normal.leader` is set without a top-level `leader`, it replaces the implicit default global leader (`Ctrl+X`). Configure both to keep both leaders.

### Prompt input height

Configure prompt input height in `tui.json`:

```json
{
  "prompt_max_height": 35,
  "prompt_scrollbar": true
}
```

> `prompt_max_height` above `40` is not recommended.

### Submit behavior

By default, insert mode uses `Enter` for newlines and normal mode uses `Enter` to submit.

To submit from insert mode too:

```json
{
  "vim_enter_submit": true
}
```

To always default to insert mode after a prompt submission:

```json
{
  "vim_insert_after_submit": true
}
```

To keep newline available:

```json
{
  "keybinds": {
    "input_newline": "alt+return"
  }
}
```

Or configure a separate submit key:

```json
{
  "keybinds": {
    "input_force_submit": "alt+return"
  }
}
```

`input_force_submit` is unbound by default.

### System clipboard register

Use the system clipboard as Vim's register:

```json
{
  "vim_system_clipboard_register": true
}
```

Yank and delete operations sync to the system clipboard, `p` / `P` paste from it.

### Modal dialog inputs

Disable modal controls in searchable dialogs and custom question answer inputs:

```json
{
  "vim_modal_input": false
}
```

> [!NOTE]
> Terminal/OS clipboard shortcuts don’t preserve Vim linewise register state. External clipboard text is pasted as characterwise text.

### Vim langmap

Map non-English keyboard layout characters to Vim command keys.

> Keys and values should be single characters.

```json
{
  "vim_langmap": {
    "р": "h",
    "о": "j",
    "л": "k",
    "д": "l"
  }
}
```

Or or for simple aliases:

```json
{
  "vim_langmap": {
    "H": "^",
    "L": "$"
  }
}
```

### Vim line motions

Choose how motions handle wrapped lines in the prompt:

```json
{
  "vim_line_motions": "logical"
}
```

Values:

| Value              | Behavior                                                    |
| ------------------ | ----------------------------------------------------------- |
| `logical`          | Vertical and boundary motions use logical lines             |
| `display_vertical` | Vertical motions use display lines; boundaries stay logical |
| `display`          | Vertical and boundary motions use display lines             |

### Vim showbreak

Set a marker for wrapped rows in the prompt:

```json
{
  "vim_showbreak": true
}
```

Shows `↪ ` marker in the prompt's left padding.

### Vim escape sequence

Set a two-character sequence to leave insert mode without pressing `Escape`:

```json
{
  "vim_escape_sequence": "jk"
}
```

### External diff viewer

Open `/diff` with an external viewer, such as [Diffview.nvim](https://github.com/sindrets/diffview.nvim):

```json
{
  "diff_viewer": {
    "command": ["nvim", "-c", "DiffviewOpen"]
  },
  "keybinds": {
    "vim.normal": {
      "diff_open": "<leader>d"
    }
  }
}
```

### Neovim integration

Compatible with [`opencode.nvim`](https://github.com/nickjvandyke/opencode.nvim). Use the following server config:

```lua
local ocv_cmd = "bash -c 'exec -a opencode ocv --port'"

vim.g.opencode_opts = {
  server = {
    start = function()
      require("opencode.terminal").open(ocv_cmd)
    end,
    toggle = function()
      require("opencode.terminal").toggle(ocv_cmd)
    end,
  },
}
```

## Thanks to all contributors!

<a href="https://github.com/reobin"><img src="./assets/contributors/reobin.png" alt="@reobin" width="40" height="40" /></a> <a href="https://github.com/BrettKulp"><img src="./assets/contributors/BrettKulp.png" alt="@BrettKulp" width="40" height="40" /></a> <a href="https://github.com/lamiphil"><img src="./assets/contributors/lamiphil.png" alt="@lamiphil" width="40" height="40" /></a> <a href="https://github.com/XPhyro"><img src="./assets/contributors/XPhyro.png" alt="@XPhyro" width="40" height="40" /></a> <a href="https://github.com/shaheislam"><img src="./assets/contributors/shaheislam.png" alt="@shaheislam" width="40" height="40" /></a> <a href="https://github.com/semi710"><img src="./assets/contributors/semi710.png" alt="@semi710" width="40" height="40" /></a> <a href="https://github.com/bjschafer"><img src="./assets/contributors/bjschafer.png" alt="@bjschafer" width="40" height="40" /></a> <a href="https://github.com/devkev"><img src="./assets/contributors/devkev.png" alt="@devkev" width="40" height="40" /></a>
