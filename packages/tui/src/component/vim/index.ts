import { createMemo } from "solid-js"
import { useConfig } from "../../config"

export function useVimEnabled() {
  const config = useConfig()

  return createMemo(() => config.data.vim.enabled)
}

export function useSetVimEnabled() {
  const config = useConfig()

  return (enabled: boolean) => {
    void config.update((draft) => {
      draft.vim = { ...draft.vim, enabled }
    })
  }
}
