import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import { RemoteControl } from "@opencode/schema/remote-control"

export async function exportRemoteClient(target: string): Promise<void> {
  await mkdir(target)
  const generated = fileURLToPath(new URL("../src/promise/generated/", import.meta.url))
  const files = ["index.ts", "client.ts", "client-error.ts", "types.ts"]
  await Promise.all(files.map((file) => copyFile(path.join(generated, file), path.join(target, file))))
  await copyFile(fileURLToPath(new URL("../../../LICENSE", import.meta.url)), path.join(target, "LICENSE"))
  for (const [file, schema] of [
    ["handoff.schema.json", RemoteControl.Handoff],
    ["registration.schema.json", RemoteControl.Registration],
  ] as const) {
    const document = Schema.toJsonSchemaDocument(schema)
    await writeFile(
      path.join(target, file),
      JSON.stringify(
        { $schema: "https://json-schema.org/draft/2020-12/schema", ...document.schema, $defs: document.definitions },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    )
    files.push(file)
  }
  const hashes = await Promise.all(
    files.map(async (file) => [
      file,
      createHash("sha256")
        .update(await readFile(path.join(target, file)))
        .digest("hex"),
    ]),
  )
  await writeFile(
    path.join(target, "contract.json"),
    JSON.stringify({ version: RemoteControl.Version, files: Object.fromEntries(hashes) }, null, 2) + "\n",
    { flag: "wx" },
  )
}

if (import.meta.main) {
  const target = process.argv[2]
  if (!target) throw new Error("Usage: bun run script/export-remote.ts <new-output-directory>")
  await exportRemoteClient(path.resolve(target))
}
