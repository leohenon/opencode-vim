import path from "node:path"
import { CLI_NAME, PRODUCT_NAME } from "@opencode/util/identity"

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : undefined

export function selfCommand() {
  const runtime = path.basename(process.execPath, path.extname(process.execPath)).toLowerCase()
  if (runtime !== "bun" && runtime !== "node" && runtime !== "nodejs") return [process.execPath]
  if (!entrypoint) throw new Error("Failed to resolve CLI entrypoint")
  if (runtime === "node" || runtime === "nodejs") return [process.execPath, ...nodeFlags(), entrypoint]
  // Source Bun processes do not inherit --define values; retain OCV's isolated storage identity in servers/tools.
  const identity =
    PRODUCT_NAME === "ocv"
      ? [
          "--define",
          `OPENCODE_CLI_NAME=${JSON.stringify(CLI_NAME)}`,
          "--define",
          `OPENCODE_PRODUCT_NAME=${JSON.stringify(PRODUCT_NAME)}`,
        ]
      : []
  return [process.execPath, ...identity, entrypoint]
}

function nodeFlags() {
  return process.execArgv.flatMap((arg, index, args) => {
    if (index > 0 && args[index - 1] === "--conditions") return []
    if (arg === "--conditions") return args[index + 1] ? [arg, args[index + 1]] : []
    if (arg.startsWith("--conditions=")) return [arg]
    if (
      arg === "--experimental-ffi" ||
      arg === "--use-system-ca" ||
      arg === "--enable-source-maps" ||
      arg === "--no-addons"
    )
      return [arg]
    if (arg === "--no-warnings" || arg.startsWith("--disable-warning=")) return [arg]
    return []
  })
}
