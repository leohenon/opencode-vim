import { type Accessor, createMemo, createSignal, Match, Show, Switch } from "solid-js"
import { useRouteData } from "../../context/route"
import { useSync } from "../../context/sync"
import { pipe, sumBy } from "remeda"
import { useTheme } from "../../context/theme"
import { SplitBorder } from "../../ui/border"
import type { AssistantMessage, Session } from "@opencode-ai/sdk/v2"
import { useKV } from "../../context/kv"
import { useProject } from "../../context/project"
import { Flag } from "@opencode-ai/core/flag/flag"
import { useTerminalDimensions } from "@opentui/solid"
import { useCommandShortcut, useOpencodeKeymap } from "../../keymap"

const Title = (props: { session: Accessor<Session> }) => {
  const { theme } = useTheme()
  return (
    <text fg={theme.text}>
      <span style={{ bold: true }}>#</span> <span style={{ bold: true }}>{props.session().title}</span>
    </text>
  )
}

const ContextInfo = (props: { context: Accessor<string | undefined>; cost: Accessor<string> }) => {
  const { theme } = useTheme()
  return (
    <Show when={props.context()}>
      <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
        {props.context()} ({props.cost()})
      </text>
    </Show>
  )
}

const WorkspaceInfo = (props: { workspace: Accessor<string | undefined> }) => {
  const { theme } = useTheme()
  return (
    <Show when={props.workspace()}>
      <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
        {props.workspace()}
      </text>
    </Show>
  )
}

export function Header() {
  const route = useRouteData("session")
  const sync = useSync()
  const session = createMemo(() => sync.session.get(route.sessionID)!)
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const project = useProject()

  const cost = createMemo(() => {
    const total = pipe(
      messages(),
      sumBy((x) => (x.role === "assistant" ? x.cost : 0)),
    )
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(total)
  })

  const context = createMemo(() => {
    const last = messages().findLast((x) => x.role === "assistant" && x.tokens.output > 0) as AssistantMessage
    if (!last) return
    const total =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = sync.data.provider.find((x) => x.id === last.providerID)?.models[last.modelID]
    let result = total.toLocaleString()
    if (model?.limit.context) {
      result += "  " + Math.round((total / model.limit.context) * 100) + "%"
    }
    return result
  })

  const workspace = createMemo(() => {
    const id = session()?.workspaceID
    if (!id) return "Workspace local"
    const info = project.workspace.get(id)
    if (!info) return `Workspace ${id}`
    return `Workspace ${id} (${info.type})`
  })

  const { theme } = useTheme()
  const kv = useKV()
  const mini = createMemo(() => kv.get("ui_minimal", false))
  const keymap = useOpencodeKeymap()
  const parentShortcut = useCommandShortcut("session.parent")
  const previousShortcut = useCommandShortcut("session.child.previous")
  const nextShortcut = useCommandShortcut("session.child.next")
  const [hover, setHover] = createSignal<"parent" | "prev" | "next" | null>(null)
  const dimensions = useTerminalDimensions()
  const narrow = createMemo(() => dimensions().width < 80)

  return (
    <box flexShrink={0}>
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        {...SplitBorder}
        border={["left"]}
        borderColor={theme.border}
        flexShrink={0}
        backgroundColor={theme.backgroundPanel}
      >
        <Switch>
          <Match when={session()?.parentID}>
            <box flexDirection="column" gap={1}>
              <box flexDirection={narrow() ? "column" : "row"} justifyContent="space-between" gap={narrow() ? 1 : 0}>
                {Flag.OPENCODE_EXPERIMENTAL_WORKSPACES ? (
                  <box flexDirection="column">
                    <text fg={theme.text}>
                      <b>Subagent session</b>
                    </text>
                    <WorkspaceInfo workspace={workspace} />
                  </box>
                ) : (
                  <text fg={theme.text}>
                    <b>Subagent session</b>
                  </text>
                )}

                <ContextInfo context={context} cost={cost} />
              </box>
              <box flexDirection="row" gap={2}>
                <box
                  onMouseOver={() => setHover("parent")}
                  onMouseOut={() => setHover(null)}
                  onMouseUp={() => keymap.dispatchCommand("session.parent")}
                  backgroundColor={hover() === "parent" ? theme.backgroundElement : theme.backgroundPanel}
                >
                  <text fg={theme.text}>
                    Parent
                    <Show when={!mini()}>
                      <span style={{ fg: theme.textMuted }}> {parentShortcut()}</span>
                    </Show>
                  </text>
                </box>
                <box
                  onMouseOver={() => setHover("prev")}
                  onMouseOut={() => setHover(null)}
                  onMouseUp={() => keymap.dispatchCommand("session.child.previous")}
                  backgroundColor={hover() === "prev" ? theme.backgroundElement : theme.backgroundPanel}
                >
                  <text fg={theme.text}>
                    Prev
                    <Show when={!mini()}>
                      <span style={{ fg: theme.textMuted }}> {previousShortcut()}</span>
                    </Show>
                  </text>
                </box>
                <box
                  onMouseOver={() => setHover("next")}
                  onMouseOut={() => setHover(null)}
                  onMouseUp={() => keymap.dispatchCommand("session.child.next")}
                  backgroundColor={hover() === "next" ? theme.backgroundElement : theme.backgroundPanel}
                >
                  <text fg={theme.text}>
                    Next
                    <Show when={!mini()}>
                      <span style={{ fg: theme.textMuted }}> {nextShortcut()}</span>
                    </Show>
                  </text>
                </box>
              </box>
            </box>
          </Match>
          <Match when={true}>
            <box flexDirection={narrow() ? "column" : "row"} justifyContent="space-between" gap={1}>
              {Flag.OPENCODE_EXPERIMENTAL_WORKSPACES ? (
                <box flexDirection="column">
                  <Title session={session} />
                  <WorkspaceInfo workspace={workspace} />
                </box>
              ) : (
                <Title session={session} />
              )}
              <ContextInfo context={context} cost={cost} />
            </box>
          </Match>
        </Switch>
      </box>
    </box>
  )
}
