import { Effect, Option, Schema } from "effect"
import { RemoteControl } from "@opencode/schema/remote-control"
import { createHash, randomBytes } from "node:crypto"
import path from "node:path"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { RemoteLocal } from "../../services/remote-local"
import { createPrivateFile } from "@opencode/util/private-file"
import { pair } from "./remote-computers"

export default Runtime.handler(
  Commands.commands.remote,
  Effect.fn("cli.remote")(function* (input) {
    const { options, status, request } = yield* RemoteLocal.connect()
    if (input.action === "status") {
      console.log(JSON.stringify(status, null, 2))
      return
    }
    // `remote attach` is the older name of `remote computers pair`.
    if (input.action === "attach") return yield* pair(request)
    if (!status.supported) return yield* Effect.fail(new Error("Backend does not support managed remote control"))
    if (input.action === "enroll") {
      if (!status.backendID)
        return yield* Effect.fail(
          new Error(
            "Backend identity has not been persisted; fix service configuration access and run remote disable to initialize it",
          ),
        )
      const target = Option.getOrUndefined(input.handoff)
      if (!target) return yield* Effect.fail(new Error("Enrollment requires --handoff <new-private-file>"))
      const credentialID = randomBytes(16).toString("hex")
      const token = randomBytes(32).toString("base64url")
      const handoff = RemoteControl.Handoff.make({
        version: 1,
        backendID: status.backendID,
        registration: `${options.file}.remote`,
        credentialID,
        token,
      })
      yield* Effect.tryPromise({
        try: () => createPrivateFile(path.resolve(target), JSON.stringify(handoff, null, 2) + "\n"),
        catch: () =>
          new Error(
            "Private handoff creation failed; no backend credential was issued and existing files were not overwritten",
          ),
      })
      const result = yield* request("/api/remote/enrollment", "POST", {
        backendID: status.backendID,
        credentialID,
        digest: createHash("sha256").update(token).digest("hex"),
      })
      if (!result.ok)
        return yield* Effect.fail(
          new Error(
            "Enrollment not confirmed; keep the private handoff for reconciliation or revoke backend credentials before removing it",
          ),
        )
      console.log(
        "Companion enrolled. Import the private handoff locally; never send it to a browser. /remote in the TUI performs the same flow interactively.",
      )
      return
    }
    const result = yield* request(
      input.action === "revoke" ? "/api/remote/enrollment" : "/api/remote/policy",
      input.action === "revoke" ? "DELETE" : "PUT",
      input.action === "revoke" ? undefined : { enabled: input.action === "enable" },
    )
    if (!result.ok) return yield* Effect.fail(new Error("Remote-control operation failed"))
    const value = yield* Effect.tryPromise({
      try: () => result.json(),
      catch: () => new Error("Invalid remote result"),
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(RemoteControl.PolicyResult)))
    console.log(JSON.stringify(value, null, 2))
    if (!value.persisted)
      return yield* Effect.fail(new Error("Running state is shown above; restart persistence was NOT updated"))
  }),
)
