import { createMemo } from "solid-js"
import type { RGBA } from "@opentui/core"
import { useTheme } from "../../context/theme"
import type { ComponentTheme } from "../../theme/component"

// ocv: OpenCode v2 exposes nested theme tokens. The vim code was written
// against the v1 flat theme, so map the v1 names onto the v2 tokens here
// instead of rewriting every call site.
export type VimTheme = {
  readonly text: RGBA
  readonly textMuted: RGBA
  readonly background: RGBA
  readonly backgroundElement: RGBA
  readonly border: RGBA
  readonly primary: RGBA
  readonly secondary: RGBA
}

export function vimTheme(theme: ComponentTheme): VimTheme {
  return {
    text: theme.text.base,
    textMuted: theme.text.muted,
    background: theme.background.base,
    backgroundElement: theme.background.raised.base,
    border: theme.border.base,
    primary: theme.text.action.primary.selected,
    secondary: theme.categorical[0][200],
  }
}

export function useVimTheme() {
  const theme = useTheme()
  return createMemo(() => vimTheme(theme))
}

/** Picks a readable foreground for a highlight background. */
export function selectedForeground(theme: VimTheme, background: RGBA) {
  const luminance = background.r * 0.299 + background.g * 0.587 + background.b * 0.114
  return luminance > 0.55 ? theme.background : theme.text
}
