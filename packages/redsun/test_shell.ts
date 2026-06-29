import { spawn } from "child_process"

const shells = [
  "C:\\WINDOWS\\system32\\cmd.exe",
  "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
]

const command = "echo foo && echo bar"

for (const shell of shells) {
  try {
    const result = await new Promise<string>((resolve, reject) => {
      const proc = spawn(command, {
        shell,
        stdio: ["ignore", "pipe", "pipe"],
      })
      let output = ""
      proc.stdout?.on("data", (d) => (output += d.toString()))
      proc.stderr?.on("data", (d) => (output += d.toString()))
      proc.on("error", (e) => reject(e))
      proc.on("exit", () => resolve(output))
    })
    console.log(`${shell}: ${JSON.stringify(result)}`)
  } catch (e) {
    console.log(`${shell}: ERROR - ${(e as Error).message}`)
  }
}
