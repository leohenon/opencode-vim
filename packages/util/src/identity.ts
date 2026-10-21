declare const OPENCODE_CLI_NAME: string | undefined
declare const OPENCODE_PRODUCT_NAME: string | undefined

export const CLI_NAME = typeof OPENCODE_CLI_NAME === "string" ? OPENCODE_CLI_NAME : "opencode"
export const PRODUCT_NAME = typeof OPENCODE_PRODUCT_NAME === "string" ? OPENCODE_PRODUCT_NAME : "opencode"
export const DISPLAY_NAME = PRODUCT_NAME === "ocv" ? "OCV" : "OpenCode"
export const TERMINAL_NAME = PRODUCT_NAME === "ocv" ? "OCV" : "OC"
export const PACKAGE_NAME = PRODUCT_NAME === "ocv" ? "@leohenon/ocv" : "@opencode/cli"
export const NPM_DIST_TAG = PRODUCT_NAME === "ocv" ? "ocv-v2" : "latest"
export const HOMEBREW_FORMULA = PRODUCT_NAME === "ocv" ? "leohenon/tap/ocv-v2" : undefined
export const GITHUB_REPOSITORY = PRODUCT_NAME === "ocv" ? "leohenon/opencode-vim" : "anomalyco/opencode"
export const INSTALLER_URL =
  PRODUCT_NAME === "ocv"
    ? "https://raw.githubusercontent.com/leohenon/opencode-vim/ocv/install.sh"
    : "https://opencode.ai/v2/install"
