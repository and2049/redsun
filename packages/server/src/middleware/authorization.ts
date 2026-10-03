import { ServerAuth } from "../auth"
import { UnauthorizedError } from "@opencode/protocol/errors"
import { Authorization } from "@opencode/protocol/middleware/authorization"
export { Authorization } from "@opencode/protocol/middleware/authorization"
import { hasPtyConnectTicketURL } from "@opencode/protocol/groups/pty"
import { hasPersistentPtyConnectTicketURL } from "@opencode/protocol/groups/persistent-pty"
import { isPairingConnectURL } from "@opencode/protocol/groups/server"
import { Effect, Encoding, Layer, Redacted } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { RemoteService } from "../remote-control"
import { RemoteAccess } from "../remote-access"

const AUTH_TOKEN_QUERY = "auth_token"
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'

function emptyCredential() {
  return { username: "", password: Redacted.make("") }
}

function decodeCredential(input: string) {
  return Effect.fromResult(Encoding.decodeBase64String(input)).pipe(
    Effect.match({
      onFailure: emptyCredential,
      onSuccess: (header) => {
        const separator = header.indexOf(":")
        if (separator === -1) return emptyCredential()
        return { username: header.slice(0, separator), password: Redacted.make(header.slice(separator + 1)) }
      },
    }),
  )
}

function credentialFromRequest(request: HttpServerRequest.HttpServerRequest) {
  const url = new URL(request.url, "http://localhost")
  const token = url.searchParams.get(AUTH_TOKEN_QUERY)
  if (token) return decodeCredential(token)
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match) return decodeCredential(match[1])
  return Effect.succeed(emptyCredential())
}

const UNAUTHORIZED_MESSAGE = "Authentication required"

// Browsers show a native credentials prompt for a Basic challenge even on fetch, which would stall the web app
// before it can show its own sign-in screen. Only non-browser clients and page navigations get the challenge.
function challengeRequest(request: HttpServerRequest.HttpServerRequest) {
  const mode = request.headers["sec-fetch-mode"]
  return mode === undefined || mode === "navigate"
}

// Matches what the Authorization middleware encodes, for requests rejected before the HttpApi runs.
export function unauthorizedResponse(request: HttpServerRequest.HttpServerRequest) {
  return HttpServerResponse.jsonUnsafe(
    { _tag: "UnauthorizedError", message: UNAUTHORIZED_MESSAGE },
    { status: 401, headers: challengeRequest(request) ? { "www-authenticate": WWW_AUTHENTICATE } : undefined },
  )
}

export function authorizedRequest(request: HttpServerRequest.HttpServerRequest, config: ServerAuth.Info) {
  return credentialFromRequest(request).pipe(
    Effect.map((credential) => ServerAuth.authorized(credential, config) || authorizedSessionCookie(request, config)),
  )
}

function authorizedSessionCookie(request: HttpServerRequest.HttpServerRequest, config: ServerAuth.Info) {
  const token = request.cookies[ServerAuth.sessionCookieName(request.headers.host)]
  if (!token) return false
  // Same-site pages on other ports still send this cookie, so only same-origin requests may use it.
  const origin = request.headers.origin
  if (origin !== undefined && URL.parse(origin)?.host !== request.headers.host) return false
  return ServerAuth.verifySession(token, config)
}

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    const remote = yield* RemoteService.Service
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (/^Bearer\s/i.test(request.headers.authorization ?? "")) {
          yield* HttpEffect.appendPreResponseHandler((_request, response) =>
            Effect.succeed(
              response.status < 400
                ? response
                : HttpServerResponse.jsonUnsafe(
                    { _tag: "RemoteRequestError", message: "Remote operation refused or failed" },
                    { status: response.status },
                  ),
            ),
          )
          const principal = remote.authenticate(request.headers.authorization ?? "")
          if (!principal || !(yield* RemoteAccess.check(request)) || !remote.current(principal))
            return yield* new UnauthorizedError({ message: "Remote access refused" })
          return yield* effect.pipe(Effect.provideService(RemoteService.Principal, principal))
        }
        if (!ServerAuth.required(config)) return yield* effect
        // Ticketed PTY connects (browsers cannot set headers on WebSocket upgrades) and pairing links
        // skip credential checks here; their handlers consume and validate the ticket or code.
        const url = new URL(request.url, "http://localhost")
        if (hasPtyConnectTicketURL(url) || hasPersistentPtyConnectTicketURL(url) || isPairingConnectURL(url))
          return yield* effect
        if (yield* authorizedRequest(request, config)) return yield* effect
        if (challengeRequest(request))
          yield* HttpEffect.appendPreResponseHandler((_request, response) =>
            Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
          )
        return yield* new UnauthorizedError({ message: UNAUTHORIZED_MESSAGE })
      }),
    )
  }),
)
