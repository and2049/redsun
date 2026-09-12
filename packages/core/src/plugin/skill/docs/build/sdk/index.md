# Overview

`@opencode/sdk` hosts redsun directly inside your application. Unlike the
[network client](../client/index.md), it assembles the redsun server and routes API
calls through its HTTP router in memory. It opens no HTTP listener and adds no
network hop between the client and server.

For Cloudflare Durable Objects, see the [Cloudflare guide](cloudflare.md).

Install the SDK:

```sh
bun add @opencode/sdk
```

## Create a host

`OpenCode.create()` returns an explicitly owned host. Use `await using` to
release its router, Location services, fibers, and scoped plugin registrations:

```ts
import { redsun } from "@opencode/sdk"

await using opencode = await OpenCode.create()
const session = await opencode.sessions.create({
  location: { directory: "/workspace" },
})

await opencode.sessions.prompt({
  sessionID: session.id,
  text: "Review the current changes",
})
```

Call `await opencode.close()` explicitly when explicit resource management is
not available.

The embedded host uses the same Promise values, declared errors, request
options, and `AsyncIterable` streams as `@opencode/client`. It exposes the
full generated client and adds the convenience aliases `sessions` and `events`
for the session and event groups.

## Stream events

```ts
for await (const event of opencode.events.subscribe()) {
  console.log(event.type)
}
```

Pass an `AbortSignal` through the generated request options, or leave an
iteration to cancel its response body.

## Customize

Customize your redsun instance by registering plugins. Pass plugins to
`OpenCode.create()` to customize agents, models, tools, and other behavior when
the embedded host starts:

```ts
import { Plugin } from "@opencode/plugin"
import { redsun } from "@opencode/sdk"

const plugin = Plugin.define({
  id: "customize-agent",
  async setup(ctx) {
    await ctx.agent.transform((agents) => {
      agents.update("build", (agent) => {
        agent.description = "Builds features and fixes bugs for our team"
      })
    })
  },
})

await using opencode = await OpenCode.create({ plugins: [plugin] })
```

Call `await opencode.plugin(plugin)` to register another plugin after startup.

See the [full plugins documentation](../plugins/index.md) for plugin hooks,
transforms, tools, and the complete plugin context.
