import { EOL } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Config } from "../../config"
import { Global } from "@opencode/util/global"

export default Runtime.handler(
  Commands.commands["import-v1-settings"],
  Effect.fn("cli.import-v1-settings")(function* () {
    const global = yield* Global.Service
    const config = yield* Config.Service
    const imported = yield* config.importV1({
      config: path.join(process.env.XDG_CONFIG_HOME || path.join(global.home, ".config"), "opencode"),
      state: path.join(process.env.XDG_STATE_HOME || path.join(global.home, ".local", "state"), "opencode"),
    })
    if (!imported) {
      process.stdout.write("No supported OpenCode V1 TUI settings were found." + EOL)
      return
    }
    process.stdout.write(`Imported supported TUI settings into ${config.path}.${EOL}`)
    process.stdout.write(`Read only: ${imported.sources.join(", ")}${EOL}`)
  }),
)
