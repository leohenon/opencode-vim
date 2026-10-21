// NOTE: This module is shared between the opencode-vim fork and the opencode-vim-plugin repo.
// Keep the two copies in sync — see note in the vim/handler.ts.
import type { VimEvent } from "./vim-handler"
import type { createVimState } from "./vim-state"

export type VimWindowNavigation = "up" | "down"

export function vimWindowNavigation(event: VimEvent, state: ReturnType<typeof createVimState>) {
  const key = event.name ?? ""

  if (state.pending() === "w") {
    if (key === "k" || key === "w") {
      state.clearPending()
      return { action: "up" as VimWindowNavigation, handled: true }
    }

    if (key === "j") {
      state.clearPending()
      return { action: "down" as VimWindowNavigation, handled: true }
    }

    state.clearPending()
    return { handled: false }
  }

  return { handled: false }
}
