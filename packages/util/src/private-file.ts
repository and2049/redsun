import { open } from "node:fs/promises"
import { spawn } from "node:child_process"
import path from "node:path"

const script = `
$ErrorActionPreference = 'Stop'
try {
  [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
  $value = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = [Security.AccessControl.FileSecurity]::new()
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
  $stream = [IO.FileStream]::new($value.path, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough, $acl)
  try {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($value.content)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally { $stream.Dispose() }
} catch { exit 1 }
`

export async function createPrivateFile(file: string, content: string): Promise<void> {
  if (process.platform !== "win32") {
    const handle = await open(file, "wx", 0o600)
    try {
      await handle.chmod(0o600)
      await handle.writeFile(content, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    return
  }
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error("Unable to locate the Windows security API host")
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      },
    )
    const timer = setTimeout(() => child.kill(), 10_000)
    const fail = () =>
      reject(
        new Error(
          "Unable to securely create handoff file; choose a new path on a filesystem supporting private permissions",
        ),
      )
    child.on("error", () => {
      clearTimeout(timer)
      fail()
    })
    child.stdin.on("error", () => {
      child.kill()
    })
    child.on("exit", (code) => {
      clearTimeout(timer)
      code === 0 ? resolve() : fail()
    })
    child.stdin.end(JSON.stringify({ path: file, content }))
  })
}
