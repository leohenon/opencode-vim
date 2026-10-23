import { domain } from "./stage"

const GITHUB_APP_ID = new sst.Secret("GITHUB_APP_ID")
const GITHUB_APP_PRIVATE_KEY = new sst.Secret("GITHUB_APP_PRIVATE_KEY")
export const EMAILOCTOPUS_API_KEY = new sst.Secret("EMAILOCTOPUS_API_KEY")
const ADMIN_SECRET = new sst.Secret("ADMIN_SECRET")

export const api = new sst.cloudflare.Worker("Api", {
  domain: `api.${domain}`,
  handler: "packages/function/src/api.ts",
  url: true,
  link: [GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, ADMIN_SECRET],
  transform: {
    worker: (args) => {
      args.logpush = true
      if ($app.stage === "vimtor" || $app.stage === "adam") return
      // Deleting the class erases every SyncServer Durable Object and its stored share data.
      args.migrations = {
        oldTag: $app.stage === "production" || $app.stage === "thdxr" ? undefined : "v1",
        newTag: "v2",
        deletedClasses: ["SyncServer"],
      }
    },
  },
})

new sst.cloudflare.x.Astro("Web", {
  domain: "docs." + domain,
  path: "packages/web",
  environment: {
    // For astro config
    SST_STAGE: $app.stage,
    VITE_API_URL: api.url.apply((url) => url!),
  },
})
