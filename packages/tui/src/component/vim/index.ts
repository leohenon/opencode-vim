import { createMemo } from "solid-js"
import { useConfig } from "../../config"
import { useUIStateOptional } from "../../context/ui-state"

export function useVimEnabled() {
  const config = useConfig().data
  const ui = useUIStateOptional()
  return createMemo(() => ui?.[0].vim ?? config.vim ?? true)
}
