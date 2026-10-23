import { useConfig } from "../config"
import { useStorage, useStorageOptional, type Storage } from "./storage"

type UIState = {
  minimal?: boolean
  vim?: boolean
}

export function createUIState(storage: Storage) {
  return storage.store<UIState>("ui", { initial: {} })
}

export function useUIState() {
  return createUIState(useStorage())
}

export function useUIStateOptional() {
  const storage = useStorageOptional()
  return storage ? createUIState(storage) : undefined
}

export function useMinimalUI() {
  const state = useUIState()
  const config = useConfig().data
  return () => state[0].minimal ?? config.ui_minimal ?? false
}
