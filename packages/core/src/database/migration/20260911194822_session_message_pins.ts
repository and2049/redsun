import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20260911194822_session_message_pins",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_message_pin\` (
          \`session_id\` text NOT NULL,
          \`message_id\` text NOT NULL,
          \`label\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`session_message_pin_pk\` PRIMARY KEY(\`session_id\`, \`message_id\`),
          CONSTRAINT \`fk_session_message_pin_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_message_pin_message_id_session_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`session_message\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_message_pin_created_idx\` ON \`session_message_pin\` (\`session_id\`,\`time_created\`,\`message_id\`);`,
      )
    })
  },
}

export default migration
