import { createMemo, type Accessor } from "solid-js"
import type { createVimState } from "./vim-state"

export function useVimIndicator(input: {
  enabled: Accessor<boolean>
  active: Accessor<boolean>
  state: ReturnType<typeof createVimState>
  copyVisual?: Accessor<undefined | "char" | "line" | "block">
  copySearch?: Accessor<string | undefined>
}) {
  return createMemo(() => {
    if (!input.enabled() || !input.active()) return
    const key = input.state.pending()
    if (key) return (input.state.pendingDisplay() || key) + ".."
    if (input.state.count()) return input.state.count()
    if (input.state.isCopy()) {
      const search = input.copySearch?.()
      if (search !== undefined) return search
      if (input.copyVisual?.() === "char") return "-- VISUAL --"
      if (input.copyVisual?.() === "line") return "-- VISUAL LINE --"
      if (input.copyVisual?.() === "block") return "-- VISUAL BLOCK --"
      return "-- COPY --"
    }
    if (input.state.isInsert()) return "-- INSERT --"
    if (input.state.isReplace()) return "-- REPLACE --"
    if (input.state.isVisualLine()) return "-- VISUAL LINE --"
    if (input.state.isVisual()) return "-- VISUAL --"
    return undefined
  })
}
