import { For, Show } from "solid-js"
import { RGBA } from "@opentui/core"
import { useTheme } from "../../context/theme"
import type { CopyHighlight } from "./copy-mode"

export type CopyPosition = {
  line: number
  col: number
  visual: boolean
  cursorText: string
  rowHasText: boolean
  action?: {
    kind: "tool-toggle"
    left: number
    text: string
  }
}
export type CopyContext = CopyPosition

export function CopyOverlay(props: { copy?: CopyPosition; highlights?: CopyHighlight[] }) {
  const theme = useTheme()
  return (
    <>
      <Show when={props.copy && !props.copy.visual}>
        <box
          position="absolute"
          top={props.copy!.line}
          left={0}
          width="100%"
          height={1}
          backgroundColor={RGBA.fromInts(255, 255, 255, 15)}
        />
      </Show>
      <For each={props.highlights ?? []}>
        {(highlight) => (
          <box position="absolute" top={highlight.line} left={highlight.left}>
            <text
              bg={
                highlight.kind === "search"
                  ? highlight.current
                    ? theme.background.selection.current
                    : theme.background.selection.search
                  : theme.background.selection.base
              }
              fg={
                highlight.kind === "search"
                  ? highlight.current
                    ? theme.text.selection.current
                    : theme.text.selection.search
                  : theme.text.selection.base
              }
            >
              {highlight.text || " "}
            </text>
          </box>
        )}
      </For>
      <Show when={props.copy}>
        <box position="absolute" top={props.copy!.line} left={props.copy!.col} width={1} height={1}>
          <text bg={theme.text.base} fg={theme.background.base}>
            {props.copy!.cursorText}
          </text>
        </box>
      </Show>
    </>
  )
}
