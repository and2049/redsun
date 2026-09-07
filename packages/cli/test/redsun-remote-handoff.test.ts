import { expect, test } from "bun:test"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { createPrivateFile } from "@opencode-ai/util/private-file"
import { isolatedEnv } from "./fixture/environment"
import { Schema } from "effect"
import { RemoteControl } from "@opencode-ai/schema/remote-control"
import { Service } from "@opencode-ai/client/effect/service"

async function expectPrivate(file: string) {
  if (process.platform !== "win32") {
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    return
  }
  const check =
    '$acl = [IO.File]::GetAccessControl($args[0]); $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]); if (!$acl.AreAccessRulesProtected) { exit 1 }; foreach ($rule in $rules) { if ($rule.IdentityReference.Value -ne $sid -or $rule.AccessControlType -ne "Allow") { exit 2 } }; if ($rules.Count -ne 1) { exit 3 }'
  const encoded = Buffer.from(`& { ${check} } '${file.replaceAll("'", "''")}'`, "utf16le").toString("base64")
  expect(() =>
    execFileSync(
      path.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { stdio: "pipe" },
    ),
  ).not.toThrow()
}

test("private handoff is created without overwriting an existing file", async () => {
  await using temporary = await tmpdir()
  const file = path.join(temporary.path, "handoff-東京.json")
  await createPrivateFile(file, "isolated-test-material")
  expect(await readFile(file, "utf8")).toBe("isolated-test-material")
  await expect(createPrivateFile(file, "replacement")).rejects.toThrow()
  expect(await readFile(file, "utf8")).toBe("isolated-test-material")
  await expectPrivate(file)
})

test("local enrollment creates the handoff before issuing, prints no credential, and never overwrites", async () => {
  await using temporary = await tmpdir()
  const file = path.join(temporary.path, "handoff.json")
  const registration = path.join(temporary.path, "state", "redsun", "service-local.json")
  let issued = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (request.headers.get("authorization") !== `Basic ${btoa("opencode:fixture-password")}`)
        return new Response(null, { status: 401 })
      if (url.pathname === "/api/health") return Response.json({ healthy: true, version: "fixture", pid: process.pid })
      if (url.pathname === "/api/remote")
        return Response.json({
          supported: true,
          enabled: false,
          enrolled: false,
          state: "disabled",
          backendID: "fixture-backend",
          processID: "fixture-process",
          version: 1,
          leaseSeconds: 30,
        })
      if (url.pathname === "/api/remote/enrollment" && request.method === "POST") {
        expect((await stat(file)).isFile()).toBe(true)
        issued++
        return new Response(null, { status: 204 })
      }
      return new Response(null, { status: 404 })
    },
  })
  try {
    await mkdir(path.dirname(registration), { recursive: true })
    await writeFile(
      registration,
      JSON.stringify({
        id: "fixture-process",
        version: "fixture",
        pid: process.pid,
        url: server.url.origin,
        password: "fixture-password",
      }),
    )
    const run = async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          fileURLToPath(new URL("../src/index.ts", import.meta.url)),
          "remote",
          "enroll",
          "--handoff",
          file,
        ],
        {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env: isolatedEnv(temporary.path),
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      return { code, output: stdout + stderr }
    }
    const first = await run()
    expect(first.output).toContain("Companion enrolled")
    expect(first.output).toContain("/remote in the TUI performs the same flow interactively")
    expect(first.code).toBe(0)
    expect(issued).toBe(1)
    const contents = await readFile(file, "utf8")
    const parsed: unknown = JSON.parse(contents)
    expect(parsed).toMatchObject({ version: 1, backendID: "fixture-backend", registration: `${registration}.remote` })
    expect(contents).not.toContain("fixture-password")
    if (typeof parsed !== "object" || parsed === null || !("token" in parsed) || typeof parsed.token !== "string")
      throw new Error("Invalid fixture handoff")
    expect(first.output).not.toContain(parsed.token)
    expect(first.output).not.toContain("fixture-password")
    const second = await run()
    expect(second.code).not.toBe(0)
    expect(issued).toBe(1)
    expect(await readFile(file, "utf8")).toBe(contents)
  } finally {
    await server.stop(true)
  }
}, 15_000)

test("managed service publishes password-free discovery with matching RC process identity", async () => {
  await using temporary = await tmpdir()
  const registration = path.join(temporary.path, "state", "redsun", "service-local.json")
  const child = Bun.spawn(
    [process.execPath, fileURLToPath(new URL("../src/index.ts", import.meta.url)), "serve", "--service", "--port", "0"],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: isolatedEnv(temporary.path),
      stdout: "ignore",
      stderr: "ignore",
    },
  )
  try {
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      const text = await readFile(registration, "utf8").catch(() => undefined)
      if (text) {
        const info = Schema.decodeUnknownSync(Schema.fromJsonString(Service.Info))(text)
        const response = await fetch(new URL("/api/remote", info.url), {
          headers: { authorization: `Basic ${btoa(`opencode:${info.password}`)}` },
          signal: AbortSignal.timeout(1000),
        }).catch(() => undefined)
        if (response?.ok) {
          const status = Schema.decodeUnknownSync(RemoteControl.Status)(await response.json())
          const discovery = Schema.decodeUnknownSync(Schema.fromJsonString(RemoteControl.Registration))(
            await readFile(`${registration}.remote`, "utf8"),
          )
          expect(status).toMatchObject({ supported: true, enabled: false, processID: discovery.id })
          expect(status.backendID).toBeDefined()
          expect(info.password).toBeDefined()
          expect(await readFile(`${registration}.remote`, "utf8")).not.toContain(info.password!)
          await expectPrivate(`${registration}.remote`)
          ready = true
          break
        }
      }
      if (child.exitCode !== null) break
      await Bun.sleep(100)
    }
    expect(ready).toBe(true)
  } finally {
    child.kill()
    await child.exited
  }
}, 20_000)
