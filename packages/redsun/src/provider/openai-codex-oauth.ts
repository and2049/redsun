import { Auth } from "@/auth"
import { Installation } from "@/installation"
import { createServer, type Server } from "http"

export namespace OpenAICodexOAuth {
  export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
  export const ISSUER = "https://auth.openai.com"
  export const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
  export const OAUTH_PORT = 1455
  export const DUMMY_API_KEY = "chatgpt-oauth"

  type Pkce = {
    verifier: string
    challenge: string
  }

  type TokenResponse = {
    id_token?: string
    access_token: string
    refresh_token: string
    expires_in?: number
  }

  export type TokenResult =
    | {
        type: "success"
        access: string
        refresh: string
        expires: number
        accountId?: string
      }
    | { type: "failed" }

  type AuthMethodResult = {
    url: string
    method: "auto" | "code"
    instructions: string
    callback(input?: string): Promise<TokenResult>
  }

  function base64UrlEncode(input: ArrayBuffer | Uint8Array) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
    return Buffer.from(bytes).toString("base64url")
  }

  export async function generatePKCE(): Promise<Pkce> {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
    const bytes = crypto.getRandomValues(new Uint8Array(43))
    const verifier = Array.from(bytes)
      .map((b) => chars[b % chars.length])
      .join("")
    const challenge = base64UrlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
    return { verifier, challenge }
  }

  export function buildAuthorizeUrl(input: { redirectURI: string; pkce: Pkce; state: string }) {
    const url = new URL(`${ISSUER}/oauth/authorize`)
    url.searchParams.set("response_type", "code")
    url.searchParams.set("client_id", CLIENT_ID)
    url.searchParams.set("redirect_uri", input.redirectURI)
    url.searchParams.set("scope", "openid profile email offline_access")
    url.searchParams.set("code_challenge", input.pkce.challenge)
    url.searchParams.set("code_challenge_method", "S256")
    url.searchParams.set("state", input.state)
    url.searchParams.set("id_token_add_organizations", "true")
    url.searchParams.set("codex_cli_simplified_flow", "true")
    url.searchParams.set("originator", "redsun")
    return url.toString()
  }

  type Claims = {
    chatgpt_account_id?: string
    organizations?: Array<{ id?: string }>
    "https://api.openai.com/auth"?: {
      chatgpt_account_id?: string
    }
  }

  export function parseJWT(token: string): Claims | undefined {
    const parts = token.split(".")
    if (parts.length !== 3) return undefined
    try {
      return JSON.parse(Buffer.from(parts[1], "base64url").toString())
    } catch {
      return undefined
    }
  }

  export function extractAccountIdFromClaims(claims: Claims | undefined) {
    if (!claims) return undefined
    return (
      claims.chatgpt_account_id ||
      claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
      claims.organizations?.[0]?.id
    )
  }

  export function extractAccountId(tokens: Pick<TokenResponse, "id_token" | "access_token">) {
    return extractAccountIdFromClaims(parseJWT(tokens.id_token ?? "")) ?? extractAccountIdFromClaims(parseJWT(tokens.access_token))
  }

  async function exchangeToken(body: URLSearchParams, issuer = ISSUER): Promise<TokenResult> {
    const response = await fetch(`${issuer}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    })
    if (!response.ok) return { type: "failed" }

    const tokens = (await response.json()) as Partial<TokenResponse>
    if (!tokens.access_token || !tokens.refresh_token) return { type: "failed" }
    return {
      type: "success",
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      accountId: extractAccountId(tokens as TokenResponse),
    }
  }

  export function exchangeAuthorizationCode(input: { code: string; verifier: string; redirectURI: string }) {
    return exchangeToken(
      new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectURI,
        client_id: CLIENT_ID,
        code_verifier: input.verifier,
      }),
    )
  }

  export function refreshAccessToken(refreshToken: string, issuer = ISSUER) {
    return exchangeToken(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
      issuer,
    )
  }

  function successHTML() {
    return `<!doctype html><title>Redsun authorization complete</title><body>Authorization complete. You can close this window.</body>`
  }

  function startOAuthServer(state: string) {
    let code: string | undefined
    let server: Server | undefined
    const ready = new Promise<{ ready: boolean; close(): void; waitForCode(): Promise<string | undefined> }>((resolve) => {
      server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", `http://localhost:${OAUTH_PORT}`)
        if (url.pathname !== "/auth/callback") {
          res.writeHead(404)
          res.end("Not found")
          return
        }
        if (url.searchParams.get("state") !== state) {
          res.writeHead(400)
          res.end("State mismatch")
          return
        }
        code = url.searchParams.get("code") ?? undefined
        if (!code) {
          res.writeHead(400)
          res.end("Missing authorization code")
          return
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        res.end(successHTML())
      })
      server.listen(OAUTH_PORT, "127.0.0.1", () =>
        resolve({
          ready: true,
          close: () => server?.close(),
          async waitForCode() {
            for (let i = 0; i < 600; i++) {
              if (code) return code
              await Bun.sleep(500)
            }
          },
        }),
      )
      server.on("error", () =>
        resolve({
          ready: false,
          close: () => server?.close(),
          async waitForCode() {
            return undefined
          },
        }),
      )
    })
    return ready
  }

  export async function authorizeBrowser(): Promise<AuthMethodResult> {
    const pkce = await generatePKCE()
    const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
    const redirectURI = `http://localhost:${OAUTH_PORT}/auth/callback`
    const server = await startOAuthServer(state)
    const url = buildAuthorizeUrl({ redirectURI, pkce, state })
    if (!server.ready) {
      return {
        url,
        method: "code",
        instructions: "Open the URL, then paste the full redirect URL or authorization code.",
        async callback(input) {
          const code = parseAuthorizationInput(input ?? "")
          if (!code) return { type: "failed" }
          return exchangeAuthorizationCode({ code, verifier: pkce.verifier, redirectURI })
        },
      }
    }
    return {
      url,
      method: "auto",
      instructions: "Complete authorization in your browser. This window will close automatically.",
      async callback() {
        const code = await server.waitForCode()
        server.close()
        if (!code) return { type: "failed" }
        return exchangeAuthorizationCode({ code, verifier: pkce.verifier, redirectURI })
      },
    }
  }

  export async function authorizeHeadless(): Promise<AuthMethodResult> {
    const response = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": Installation.USER_AGENT,
      },
      body: JSON.stringify({ client_id: CLIENT_ID }),
    })
    if (!response.ok) throw new Error("Failed to initiate device authorization")
    const device = (await response.json()) as {
      device_auth_id: string
      user_code: string
      interval?: string | number
    }
    const interval = Math.max(Number(device.interval) || 5, 1) * 1000
    return {
      url: `${ISSUER}/codex/device`,
      method: "auto",
      instructions: `Enter code: ${device.user_code}`,
      async callback() {
        while (true) {
          const response = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "User-Agent": Installation.USER_AGENT,
            },
            body: JSON.stringify({
              device_auth_id: device.device_auth_id,
              user_code: device.user_code,
            }),
          })
          if (response.ok) {
            const data = (await response.json()) as {
              authorization_code: string
              code_verifier: string
            }
            return exchangeAuthorizationCode({
              code: data.authorization_code,
              verifier: data.code_verifier,
              redirectURI: `${ISSUER}/deviceauth/callback`,
            })
          }
          if (response.status !== 403 && response.status !== 404) return { type: "failed" }
          await Bun.sleep(interval + 3000)
        }
      },
    }
  }

  function parseAuthorizationInput(input: string) {
    const value = input.trim()
    if (!value) return undefined
    try {
      return new URL(value).searchParams.get("code") ?? undefined
    } catch {}
    if (value.includes("code=")) return new URLSearchParams(value).get("code") ?? undefined
    if (value.includes("#")) return value.split("#", 2)[0]
    return value
  }

  function removeAuthHeaders(headers: Headers) {
    headers.delete("authorization")
    headers.delete("Authorization")
    headers.delete("x-api-key")
    headers.delete("X-Api-Key")
  }

  function requestHeaders(requestInput: RequestInfo | URL) {
    return typeof Request !== "undefined" && requestInput instanceof Request ? requestInput.headers : undefined
  }

  async function requestInit(requestInput: RequestInfo | URL, init?: RequestInit): Promise<RequestInit> {
    if (!(requestInput instanceof Request)) return { ...init }

    const method = init?.method ?? requestInput.method
    const requestBody = method === "GET" || method === "HEAD" ? undefined : await requestInput.clone().text()
    return {
      method,
      body: init?.body ?? requestBody,
      signal: init?.signal ?? requestInput.signal,
      cache: init?.cache ?? requestInput.cache,
      credentials: init?.credentials ?? requestInput.credentials,
      integrity: init?.integrity ?? requestInput.integrity,
      keepalive: init?.keepalive ?? requestInput.keepalive,
      mode: init?.mode ?? requestInput.mode,
      redirect: init?.redirect ?? requestInput.redirect,
      referrer: init?.referrer ?? requestInput.referrer,
      referrerPolicy: init?.referrerPolicy ?? requestInput.referrerPolicy,
      ...init,
    }
  }

  export function normalizeCodexRequestBody(body: any) {
    if (!body || typeof body !== "object") return body
    body.store = false
    const include = Array.isArray(body.include) ? body.include.filter(Boolean) : []
    if (!include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content")
    body.include = include

    if (Array.isArray(body.input)) {
      body.input = body.input
        .filter((item: any) => item?.type !== "item_reference")
        .map((item: any) => {
          if (!item || typeof item !== "object" || !("id" in item)) return item
          const { id: _, ...rest } = item
          return rest
        })
    }

    return body
  }

  export function rewriteCodexURL(input: RequestInfo | URL) {
    const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url)
    if (url.pathname.endsWith("/responses") || url.pathname.includes("/v1/responses")) return new URL(CODEX_API_ENDPOINT)
    return url
  }

  export function createFetch(input: {
    getAuth(): Promise<Auth.Info | undefined>
    setAuth(auth: Auth.Info): Promise<void>
    fetch?: typeof fetch
  }) {
    let refreshPromise: Promise<Auth.Info> | undefined
    const fetchFn = input.fetch ?? fetch
    return async (requestInput: RequestInfo | URL, init?: RequestInit) => {
      const auth = await input.getAuth()
      if (auth?.type !== "oauth") return fetchFn(requestInput, init)

      let currentAuth = auth
      if (!currentAuth.access || currentAuth.expires < Date.now()) {
        refreshPromise ??= refreshAccessToken(currentAuth.refresh)
          .then(async (result) => {
            if (result.type !== "success") throw new Error("OpenAI OAuth token refresh failed")
            const next: Auth.Info = {
              type: "oauth",
              access: result.access,
              refresh: result.refresh,
              expires: result.expires,
              accountId: result.accountId ?? currentAuth.accountId,
            }
            await input.setAuth(next)
            return next
          })
          .finally(() => {
            refreshPromise = undefined
          })
        currentAuth = (await refreshPromise) as typeof currentAuth
      }

      const headers = new Headers(requestHeaders(requestInput))
      if (init?.headers) {
        new Headers(init.headers).forEach((value, key) => headers.set(key, value))
      }
      removeAuthHeaders(headers)
      headers.set("authorization", `Bearer ${currentAuth.access}`)
      if (currentAuth.accountId) headers.set("ChatGPT-Account-Id", currentAuth.accountId)
      headers.set("originator", "redsun")

      const nextInit = { ...(await requestInit(requestInput, init)), headers }
      if (typeof nextInit.body === "string") {
        try {
          nextInit.body = JSON.stringify(normalizeCodexRequestBody(JSON.parse(nextInit.body)))
        } catch {}
      }

      return fetchFn(rewriteCodexURL(requestInput), nextInit)
    }
  }
}
