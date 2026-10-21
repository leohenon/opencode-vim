export type VimLangmapEventLike = {
  name?: string
  shift?: boolean
  sequence?: string
  raw?: string
  preventDefault(): void
}

export function applyLangmap<T extends VimLangmapEventLike>(
  event: T,
  key: string,
  langmap: Record<string, string> | undefined,
): T {
  if (key.length !== 1) return event
  const mapped = langmap?.[key] ?? (event.shift ? langmap?.[key.toLowerCase()]?.toUpperCase() : undefined)
  if (!mapped || mapped.length !== 1) return event
  return {
    ...event,
    name: mapped,
    sequence: mapped,
    raw: mapped,
    shift: /[A-Z]/.test(mapped),
    preventDefault: () => event.preventDefault(),
  }
}
