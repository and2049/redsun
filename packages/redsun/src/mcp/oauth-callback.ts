import { Log } from "../util/log"
import { OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH, parseRedirectUri } from "./oauth-provider"

const log = Log.create({ service: "mcp.oauth-callback" })
export const OAUTH_CALLBACK_HOST = "127.0.0.1"

const HTML_SUCCESS = `<!DOCTYPE html>
<html>
<head>
  <title>Redsun - Authorization Successful</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #4ade80; margin-bottom: 1rem; }
    p { color: #aaa; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Successful</h1>
    <p>You can close this window and return to Redsun.</p>
  </div>
  <script>setTimeout(() => window.close(), 2000);</script>
</body>
</html>`

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

const HTML_ERROR = (error: string) => `<!DOCTYPE html>
<html>
<head>
  <title>Redsun - Authorization Failed</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #f87171; margin-bottom: 1rem; }
    p { color: #aaa; }
    .error { color: #fca5a5; font-family: monospace; margin-top: 1rem; padding: 1rem; background: rgba(248,113,113,0.1); border-radius: 0.5rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Failed</h1>
    <p>An error occurred during authorization.</p>
    <div class="error">${escapeHtml(error)}</div>
  </div>
</body>
</html>`

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" }

interface PendingAuth {
  resolve: (code: string) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

export namespace McpOAuthCallback {
  let server: ReturnType<typeof Bun.serve> | undefined
  let currentPort = OAUTH_CALLBACK_PORT
  let currentPath = OAUTH_CALLBACK_PATH
  const pendingAuths = new Map<string, PendingAuth>()
  const mcpNameToState = new Map<string, string>()

  const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

  function cleanupStateIndex(oauthState: string) {
    for (const [name, state] of mcpNameToState) {
      if (state === oauthState) {
        mcpNameToState.delete(name)
        break
      }
    }
  }

  function stopIfIdle() {
    if (pendingAuths.size > 0 || !server) return

    server.stop()
    server = undefined
    log.info("oauth callback server stopped")
  }

  export async function ensureRunning(redirectUri?: string): Promise<void> {
    const callback = parseRedirectUri(redirectUri)
    if (server && (currentPort !== callback.port || currentPath !== callback.path)) await stop()
    if (server) return

    const running = await isPortInUse(callback.port)
    if (running) {
      log.info("oauth callback server already running on another instance", { port: callback.port })
      return
    }

    currentPort = callback.port
    currentPath = callback.path

    server = Bun.serve({
      hostname: OAUTH_CALLBACK_HOST,
      port: currentPort,
      fetch(req) {
        const url = new URL(req.url)

        if (url.pathname !== currentPath) {
          return new Response("Not found", { status: 404 })
        }

        const code = url.searchParams.get("code")
        const state = url.searchParams.get("state")
        const error = url.searchParams.get("error")
        const errorDescription = url.searchParams.get("error_description")

        log.info("received oauth callback", { hasCode: !!code, state, error })

        // Enforce state parameter presence
        if (!state) {
          const errorMsg = "Missing required state parameter - potential CSRF attack"
          log.error("oauth callback missing state parameter", { url: url.toString() })
          return new Response(HTML_ERROR(errorMsg), {
            status: 400,
            headers: HTML_HEADERS,
          })
        }

        if (error) {
          const errorMsg = errorDescription || error
          if (pendingAuths.has(state)) {
            const pending = pendingAuths.get(state)!
            clearTimeout(pending.timeout)
            pendingAuths.delete(state)
            cleanupStateIndex(state)
            pending.reject(new Error(errorMsg))
          }
          stopIfIdle()
          return new Response(HTML_ERROR(errorMsg), {
            headers: HTML_HEADERS,
          })
        }

        if (!code) {
          return new Response(HTML_ERROR("No authorization code provided"), {
            status: 400,
            headers: HTML_HEADERS,
          })
        }

        // Validate state parameter
        if (!pendingAuths.has(state)) {
          const errorMsg = "Invalid or expired state parameter - potential CSRF attack"
          log.error("oauth callback with invalid state", { state, pendingStates: Array.from(pendingAuths.keys()) })
          return new Response(HTML_ERROR(errorMsg), {
            status: 400,
            headers: HTML_HEADERS,
          })
        }

        const pending = pendingAuths.get(state)!

        clearTimeout(pending.timeout)
        pendingAuths.delete(state)
        cleanupStateIndex(state)
        pending.resolve(code)
        stopIfIdle()

        return new Response(HTML_SUCCESS, {
          headers: HTML_HEADERS,
        })
      },
    })

    log.info("oauth callback server started", { port: currentPort, path: currentPath })
  }

  export function waitForCallback(oauthState: string, mcpName?: string): Promise<string> {
    if (mcpName) mcpNameToState.set(mcpName, oauthState)
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (pendingAuths.has(oauthState)) {
          pendingAuths.delete(oauthState)
          if (mcpName) mcpNameToState.delete(mcpName)
          reject(new Error("OAuth callback timeout - authorization took too long"))
          stopIfIdle()
        }
      }, CALLBACK_TIMEOUT_MS)

      pendingAuths.set(oauthState, { resolve, reject, timeout })
    })
  }

  export function cancelPending(mcpName: string): void {
    const oauthState = mcpNameToState.get(mcpName)
    const key = oauthState ?? mcpName
    const pending = pendingAuths.get(key)
    if (pending) {
      clearTimeout(pending.timeout)
      pendingAuths.delete(key)
      mcpNameToState.delete(mcpName)
      pending.reject(new Error("Authorization cancelled"))
      stopIfIdle()
    }
  }

  export async function isPortInUse(port = OAUTH_CALLBACK_PORT): Promise<boolean> {
    return new Promise((resolve) => {
      Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          open(socket) {
            socket.end()
            resolve(true)
          },
          error() {
            resolve(false)
          },
          data() {},
          close() {},
        },
      }).catch(() => {
        resolve(false)
      })
    })
  }

  export async function stop(): Promise<void> {
    if (server) {
      server.stop()
      server = undefined
      log.info("oauth callback server stopped")
    }

    for (const [name, pending] of pendingAuths) {
      clearTimeout(pending.timeout)
      pending.reject(new Error("OAuth callback server stopped"))
    }
    pendingAuths.clear()
    mcpNameToState.clear()
  }

  export function isRunning(): boolean {
    return server !== undefined
  }
}
