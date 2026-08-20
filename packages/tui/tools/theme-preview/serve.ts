// Theme preview/editor for the redsun TUI, modeled on echo's tools/theme-preview.
// Renders the real app headlessly (session page + home screen) with a theme
// applied, serves the frames as HTML, and writes color edits back to the
// theme JSON files. Run: bun tools/theme-preview/serve.ts [--port 7911] [--no-open]
import path from "node:path"
import { watch, type FSWatcher } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { Path } from "@opencode-ai/util/global"
import { configDirectories } from "../../src/util/config-directories"
import { themeMode } from "../../src/theme"
import { renderScreen, type Frame, type Screen } from "./render"

const ASSETS_DIR = path.join(import.meta.dir, "..", "..", "src", "theme", "assets")
const COLS = 100
const ROWS = 40
const HEX = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/
const KEY = /^[A-Za-z][A-Za-z0-9]*$/

const args = process.argv.slice(2)
const portFlag = args.indexOf("--port")
const port = portFlag !== -1 ? Number(args[portFlag + 1]) : 7911
const noOpen = args.includes("--no-open")

function userThemeDirectories() {
  const config = process.env.OPENCODE_CONFIG_DIR ?? Path.config
  return configDirectories(config, process.cwd()).map((directory) => path.join(directory, "themes"))
}

// Assets first; user/project themes override on name collision, mirroring the
// app's defaults < custom priority.
async function themeFiles() {
  const result = new Map<string, string>()
  const scan = async (directory: string) => {
    const entries = await readdir(directory).catch(() => [] as string[])
    for (const entry of entries) {
      if (path.extname(entry) !== ".json") continue
      result.set(path.basename(entry, ".json"), path.join(directory, entry))
    }
  }
  await scan(ASSETS_DIR)
  for (const directory of userThemeDirectories()) await scan(directory)
  return result
}

const frames = new Map<string, Promise<Frame>>()

function frame(name: string, source: Record<string, unknown>, screen: Screen) {
  const key = `${name}:${screen}`
  let cached = frames.get(key)
  if (!cached) {
    cached = renderScreen({ theme: name, source, screen, cols: COLS, rows: ROWS })
    cached.catch(() => frames.delete(key))
    frames.set(key, cached)
  }
  return cached
}

function invalidate(name: string) {
  frames.delete(`${name}:session`)
  frames.delete(`${name}:home`)
}

// --- SSE ---
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
const encoder = new TextEncoder()

function send(chunk: Uint8Array) {
  for (const controller of clients) {
    try {
      controller.enqueue(chunk)
    } catch {
      clients.delete(controller)
    }
  }
}

setInterval(() => send(encoder.encode(": ping\n\n")), 15_000)

// --- file watching (debounced; Windows fires duplicate events) ---
const pending = new Map<string, ReturnType<typeof setTimeout>>()
const watchers: FSWatcher[] = []

function watchDirectory(directory: string) {
  try {
    const watcher = watch(directory, (_event, file) => {
      if (!file || path.extname(file) !== ".json") return
      const name = path.basename(file, ".json")
      clearTimeout(pending.get(name))
      pending.set(
        name,
        setTimeout(() => {
          pending.delete(name)
          invalidate(name)
          send(encoder.encode(`data: ${JSON.stringify([name])}\n\n`))
        }, 150),
      )
    })
    watchers.push(watcher)
  } catch {
    // Directory may not exist; the app treats that as "no themes there".
  }
}

watchDirectory(ASSETS_DIR)
for (const directory of userThemeDirectories()) watchDirectory(directory)

// --- surgical write-back: replace only the quoted value on the existing line ---
async function writeKey(file: string, key: string, value: string) {
  const text = await Bun.file(file).text()
  const pattern = new RegExp(`("${key}"\\s*:\\s*)"#[0-9a-fA-F]{3,8}"`)
  if (!pattern.test(text)) throw new Error(`key not found in file: ${key}`)
  await Bun.write(file, text.replace(pattern, `$1"${value.toLowerCase()}"`))
}

// --- server ---
const index = path.join(import.meta.dir, "index.html")

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 120,
  async fetch(request) {
    const url = new URL(request.url)
    try {
      if (url.pathname === "/")
        return new Response(Bun.file(index), { headers: { "content-type": "text/html; charset=utf-8" } })

      if (url.pathname === "/api/themes") {
        const files = await themeFiles()
        const list = [] as { name: string; mode: "dark" | "light"; file: string }[]
        for (const [name, file] of files) {
          const source = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
          list.push({ name, mode: themeMode(source, name), file })
        }
        list.sort((a, b) => a.name.localeCompare(b.name))
        return Response.json(list)
      }

      const themeRoute = url.pathname.match(/^\/api\/theme\/([A-Za-z0-9_-]+)$/)
      if (themeRoute && request.method === "GET") {
        const name = themeRoute[1]!
        const files = await themeFiles()
        const file = files.get(name)
        if (!file) return new Response("unknown theme", { status: 404 })
        let source: Record<string, unknown>
        try {
          source = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
        } catch {
          // Half-written file mid-save; the client retries on the next SSE tick.
          return new Response("theme file is not valid JSON", { status: 422 })
        }
        const keys = (source.theme ?? {}) as Record<string, string>
        return Response.json({
          name,
          file,
          mode: themeMode(source, name),
          keys,
          frames: {
            session: await frame(name, source, "session"),
            home: await frame(name, source, "home"),
          },
        })
      }

      const setRoute = url.pathname.match(/^\/api\/theme\/([A-Za-z0-9_-]+)\/set$/)
      if (setRoute && request.method === "POST") {
        const name = setRoute[1]!
        const files = await themeFiles()
        const file = files.get(name)
        if (!file) return new Response("unknown theme", { status: 404 })
        const body = (await request.json()) as { key?: string; value?: string }
        const { key, value } = body
        if (!key || !KEY.test(key)) return new Response("bad key", { status: 400 })
        if (!value || !HEX.test(value)) return new Response("value must be #rrggbb or #rrggbbaa", { status: 400 })
        const source = JSON.parse(await readFile(file, "utf8")) as { theme?: Record<string, unknown> }
        if (!source.theme || !(key in source.theme)) return new Response("key not in theme", { status: 400 })
        await writeKey(file, key, value)
        invalidate(name)
        return Response.json({ ok: true })
      }

      if (url.pathname === "/api/events") {
        let opened: ReadableStreamDefaultController<Uint8Array>
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            opened = controller
            clients.add(controller)
            controller.enqueue(encoder.encode(": connected\n\n"))
          },
          cancel() {
            clients.delete(opened)
          },
        })
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        })
      }

      return new Response("not found", { status: 404 })
    } catch (error) {
      return new Response(String(error), { status: 500 })
    }
  },
})

const address = `http://127.0.0.1:${server.port}/`
console.log(`theme-preview serving ${address}`)
console.log(`assets: ${ASSETS_DIR}`)

if (!noOpen) {
  const command =
    process.platform === "win32"
      ? ["cmd", "/c", "start", "", address]
      : process.platform === "darwin"
        ? ["open", address]
        : ["xdg-open", address]
  Bun.spawn(command, { stdout: "ignore", stderr: "ignore" }).unref()
}
