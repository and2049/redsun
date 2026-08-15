import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260815054256_worker_model",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`worker_model\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
