import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { parse } from "jsonc-parser"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

it.live("global context settings persist partial updates without changing project overrides or unrelated JSONC", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("redsun-context-settings-")))
    const global = path.join(tmp.path, "global")
    const project = path.join(tmp.path, "project")
    yield* Effect.promise(() => Promise.all([fs.mkdir(global), fs.mkdir(project)]))
    const file = path.join(global, "redsun.jsonc")
    const lowerFile = path.join(global, "redsun.json")
    const lowerText = JSON.stringify({ compaction: { strategy: "{file:strategy.txt}" } })
    const projectFile = path.join(project, "redsun.json")
    const projectText = JSON.stringify({ stale_read_deduplication: false, compaction: { strategy: "llm" } })
    yield* Effect.promise(() =>
      Promise.all([
        fs.writeFile(lowerFile, lowerText),
        fs.writeFile(path.join(global, "strategy.txt"), "hybrid\n"),
        fs.writeFile(file + ".tmp", "existing recovery copy"),
        fs.writeFile(
          file,
          '{\n  // keep this comment\n  "compaction": { "buffer": 1234 },\n  "instruction_max_chars": 12000,\n}\n',
        ),
        fs.writeFile(projectFile, projectText),
      ]),
    )
    const server = yield* startServer(global)
    const url = new URL("/api/config/context", server.base)
    url.searchParams.set("location[directory]", project)
    const get = () => Effect.promise(() => fetch(url, { headers: server.headers }))
    const update = (body: unknown) =>
      Effect.promise(() =>
        fetch(url, {
          method: "PATCH",
          headers: { ...server.headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
    const before = yield* get()
    expect(before.status, yield* Effect.promise(() => before.clone().text())).toBe(200)
    expect(yield* Effect.promise(() => before.json())).toEqual({
      stale_read_deduplication: false,
      compaction: { strategy: "hybrid" },
    })
    const responses = yield* Effect.all(
      [update({ stale_read_deduplication: true }), update({ compaction: { strategy: "algorithmic" } })],
      { concurrency: "unbounded" },
    )
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    const after = yield* get()
    expect(yield* Effect.promise(() => after.json())).toEqual({
      stale_read_deduplication: true,
      compaction: { strategy: "algorithmic" },
    })
    const saved = yield* Effect.promise(() => fs.readFile(file, "utf8"))
    expect(saved).toContain("// keep this comment")
    expect(parse(saved)).toEqual({
      stale_read_deduplication: true,
      compaction: { strategy: "algorithmic", buffer: 1234 },
      instruction_max_chars: 12000,
    })
    expect(yield* Effect.promise(() => fs.readFile(projectFile, "utf8"))).toBe(projectText)
    expect(yield* Effect.promise(() => fs.readFile(lowerFile, "utf8"))).toBe(lowerText)
    expect((yield* Effect.promise(() => fs.readdir(global))).filter((name) => name.endsWith(".tmp"))).toEqual([
      "redsun.jsonc.tmp",
    ])
    expect(yield* Effect.promise(() => fs.readFile(file + ".tmp", "utf8"))).toBe("existing recovery copy")

    const configURL = new URL("/api/config", server.base)
    configURL.searchParams.set("location[directory]", project)
    const response = yield* Effect.promise(() => fetch(configURL, { headers: server.headers }))
    const entries: unknown = yield* Effect.promise(() => response.json())
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          info: expect.objectContaining({
            stale_read_deduplication: true,
            compaction: { strategy: "algorithmic", buffer: 1234 },
          }),
        }),
        expect.objectContaining({ info: { stale_read_deduplication: false, compaction: { strategy: "llm" } } }),
      ]),
    )

    expect((yield* update({ compaction: { strategy: "invalid" } })).status).toBe(400)
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(saved)
    yield* Effect.promise(() => fs.writeFile(file, "{ broken JSONC"))
    expect((yield* update({ stale_read_deduplication: false })).status).toBe(400)
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("{ broken JSONC")
    yield* Effect.promise(() => fs.unlink(file))
    yield* Effect.promise(() => fs.mkdir(file))
    expect((yield* get()).status).toBe(500)
    expect((yield* update({ stale_read_deduplication: false })).status).toBe(500)
  }),
)

it.live("context settings start cache-first and create global configuration when absent", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("redsun-context-defaults-")))
    const server = yield* startServer(tmp.path)
    const url = new URL("/api/config/context", server.base)
    const response = yield* Effect.promise(() => fetch(url, { headers: server.headers }))
    expect(response.status, yield* Effect.promise(() => response.clone().text())).toBe(200)
    expect(yield* Effect.promise(() => response.json())).toEqual({
      stale_read_deduplication: false,
      compaction: { strategy: "llm" },
    })
    const updated = yield* Effect.promise(() =>
      fetch(url, {
        method: "PATCH",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({ compaction: { strategy: "hybrid" } }),
      }),
    )
    expect(updated.status).toBe(200)
    expect(parse(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "redsun.jsonc"), "utf8")))).toEqual({
      compaction: { strategy: "hybrid" },
    })
  }),
)
