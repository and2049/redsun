# Remote-control integration contract, version 1

This implements the **redsun backend foundation**, not a companion/browser app. No
browser authentication is supplied by the backend. Remote access has two audiences, both
served by routes on the device's OpenTunnel tunnel that the managed service owns at runtime
(section "Remote access", below): **phones** reach the companion, which listens on loopback
and authenticates with passkeys; **computers** reach the backend itself with a pairing link
redeemed for a session token. A route is unguessable but is not authentication: the
companion's passkeys remain the only browser authentication. Use a trusted same-OS-user
companion. Never forward backend credentials or local registration files to browsers.

## Policy and identity

Only the CLI's managed `serve --service` supplies RC persistence. Ordinary standalone,
stdio and embedded launches leave RC unsupported/disabled. Internal server options
accept a persistence file for managed hosting and isolated integration fixtures; they
are not remotely configurable.

`remote_control.enabled` lives in the managed **service configuration**, not in
`redsun.json[c]`, the project-merged Config service, session storage, or TUI config.
Absent means false. The backend maintains `remote_control.backendID` and
`remote_control.credentials` (credential IDs, SHA-256 token digests, and backend ID).
Do not edit enrollment fields manually.

The file is under redsun's global config directory:

| Channel | Configuration filename |
| --- | --- |
| latest/dev/beta/next | `service.json` |
| release | `service-release.json` |
| local/source checkout | `service-local.json` |
| other | Existing sanitized channel-specific service filename |

Channels sharing this configuration share enrollment. **Separate enrollment does not
isolate a shared session database.** Installed channels can share the same session DB.
RC is owner-level control of that backend's sessions, not a multi-user tenant boundary.

Policy APIs update running state without service restart. Manual file edits are loaded
on backend restart, not watched. `/cd`, project configuration, plugins and TUI closure
do not own effective RC policy. Location resolution can load project config/plugins;
selection and session moves may target **any directory accessible to the backend OS
user**, like local operation. This is not a tool or filesystem sandbox.

Enable takes effect only after successful persistence. Disable invalidates companion
access immediately when its serialized policy operation begins, then persists.
Disable retains enrollment. Revocation separately clears all credentials and connections.
`{status,persisted:false}` is a visible failure: disabling remains effective in memory;
failed revoke additionally disables RC in memory. The previous on-disk policy may
return on restart. Fix file access and retry before restarting; never treat a failed
write as durable revocation. Policy/enrollment mutations finish once started even if
their HTTP caller disconnects. Concurrent RC mutations serialize.

The durable backend ID persists across process restart. `processID` is the managed
service's registration ID and changes per process. Neither PID, URL, port, version,
project path nor process ID is a replacement for durable identity validation.

## Explicit local setup and safe import

With an already-running managed backend:

```text
redsun remote status
redsun remote enroll --handoff <new-private-local-file>
redsun remote enable
redsun remote disable
redsun remote revoke
```

`/remote` opens the local TUI controls (the "Remote access" dialog, described below) from
Home or a session without submitting a model prompt. The shared Home/session footer shows
effective backend status. Disable and revoke are distinct; revocation requires confirmation
in the dialog. Enrollment is a local operation (the CLI verb above, or the backend's own
atomic enable), never a browser endpoint.

The CLI uses passive `Service.discover`, never `ensure`, start, stop, replacement or
restart. It rejects non-loopback registration URLs before discovery, requires a ready
local-authenticated backend, and checks process identity. Existing unrestricted Basic
authentication remains `opencode:<service-password>`; RC does not rename that username.

Enrollment generates a random 256-bit token and 128-bit credential ID locally. It
exclusively creates and flushes the handoff **before** registering the digest. POSIX
creation is exclusive mode 0600; Windows uses CreateNew with a protected ACL granting
only the current user's SID access. Unsupported permissions/filesystems fail rather
than falling back to an insecure file. No silent overwrite. Token material travels to
the Windows helper on stdin, not command-line arguments. The backend receives only the
digest; no unrestricted password enters the handoff. Maximum eight enrolled credentials.

Handoff JSON (`RemoteControl.Handoff`, exportable JSON Schema):

```json
{
  "version": 1,
  "backendID": "<durable backend UUID>",
  "registration": "<absolute nonsecret discovery-file path>",
  "credentialID": "<32 lowercase hex characters>",
  "token": "<43 base64url characters>"
}
```

If file creation fails, no enrollment request is sent. If enrollment fails or its
response is lost, the private file remains for reconciliation; it may describe an
inactive or active credential. Keep it until confirmation or explicit revocation.
Repeating local enrollment API input with the same ID/digest is idempotent; a different
digest under that ID conflicts. There is no browser enrollment flow or handoff-file
resume CLI. Revoke before discarding an uncertain handoff if not reconciling locally.

The companion must import through a local-only path, reject untrusted/symlinked files
and unexpected versions/fields, validate owner and private permissions, store the
credential with equivalent protection, and remove the handoff only after durable safe
import. Do not accept a remote/browser-provided file path or backend URL. Do not log
the handoff, token, Authorization header, request options, or unrestricted registration.
The trusted OS user, root and Windows administrators are outside this isolation boundary.

## Remote access: phones and computers

Public HTTPS origins come from the device's shared OpenTunnel tunnel (`@opentunnel/client`,
default profile, Anomaly's hosted relay at `opentunnel.xyz`). The tunnel's certificate covers
`*.<id>.opentunnel.xyz`; the private key never leaves the host; the relay routes by SNI and
forwards ciphertext. The managed service claims one route per audience on that tunnel, never
the bare hostname, and owns both at runtime: nothing in either flow needs a service restart,
the shell, or a copied password.

| Audience | Route target | Auth | Persisted as | Route across off |
| --- | --- | --- | --- | --- |
| Phones | companion loopback port (43123) | passkey in the companion | `remote_control.tunnel {enabled, route}` | kept (passkeys bind to it) |
| Computers | the backend's own loopback port | pairing code → session token (or the password) | `remote_control.computers {enabled, route, origin?}` | kept (attached TUIs store the URL) |

### Phones

Companion route (`remote_control.tunnel {enabled, route}` in the service configuration):

- The route is one random DNS label (16 hex characters), generated on first enable and
  **kept across disable**, because every phone's passkey is bound to the origin it forms.
  Only `rotate` replaces it, after which every phone must enroll again: whenever the companion
  origin changes (rotate, a tunnel whose hostname changed, a manually configured origin), the
  service forgets the registered phone (the companion's `recoverBrowser`) before restarting the
  companion, because a companion started at a new origin with the old phone record refuses to run.
- Enabling resolves the tunnel hostname (`RemoteTunnel.ensure`: creates the tunnel and
  waits for its certificate the first time, which can take minutes and runs outside the
  RC lock), then persists `tunnel` and `origin = https://<route>.<hostname>` together,
  restarting the companion when the origin changed. Nothing is persisted when issuance
  fails. Manual `PUT /api/remote/companion` origins remain supported for self-served HTTPS.
- The route is attached only while the companion runs (`127.0.0.1:<companion port>`),
  on a fiber the RC service owns; disable, policy off, revoke and enrollment restarts
  detach it. A tunnel hostname that no longer matches the persisted origin is reported,
  not silently adopted.
- Local-only administration: `GET /api/remote/tunnel` and `PUT /api/remote/tunnel` with
  `{enabled, rotate?}` return `RemoteControl.Tunnel` (`enabled`, `origin?`, `state:
  off|issuing|waiting|attaching|ready|failed`, `error?`); `waiting` means enabled while
  the companion is not running. CLI: `redsun remote tunnel status|enable|disable|rotate`;
  enabling remote control without an origin enables phone access first.
- Tests never create a tunnel: `RemoteService.make` takes a `TunnelHost` (`ensure`, `run`)
  and the suites pass fakes; the real host is `packages/server/src/remote-tunnel.ts`.

### Computers

Computer access (a redsun TUI on another computer; `remote_control.computers {enabled,
route, origin?}` in the service configuration): the backend itself on a second route of the
same tunnel, owned by the RC service like the companion route and attached while enabled,
with the backend's loopback `host:port` as target (the first plain-HTTP URL the server
reports). The RC service publishes the public URL into `/api/info` `urls` through a callback
the server process supplies (`createRoutes(..., onComputerURLs)`); the CLI's server process
no longer forks a tunnel. The route is **kept across disable** so attached computers keep
their address; `rotate` issues a new one. Upstream's `remote: {route}` service-config key
(from `opencode service set remote true`) is migrated into `computers` on the service's next
load and dropped from the file. This exposes the **whole local API** on a public hostname, so
it is a separate opt-in from phone access.

- Local administration: `GET/PUT /api/remote/computers` (`RemoteControl.Computers`, the
  `Tunnel` shape; `ComputersConfig {enabled, rotate?}`), `POST /api/remote/computers/pairing`
  → `RemoteControl.Pairing {link, code, expires_in}` (503 while the route is not ready). CLI:
  `redsun remote computers status|enable|disable|rotate|pair`. The service configuration
  CLI has no `remote` key: `service get` only reports whether computer access is on.
- Pairing instead of passwords: the link is `https://<route>.<hostname>/auth/connect/<code>`
  (upstream's `ServerPairing`: 16 random bytes, single use, 5 minutes). `redsun attach <link>`
  redeems it with `Accept: application/json` for a session token (accepted anywhere the
  password is, signed with the password, 30 days), stores `{token, expires}` per origin in the
  private `<state>/attachments.json` (never a password), and opens the TUI. `--server <url>`
  without `OPENCODE_PASSWORD` uses the stored token and renews it through
  `POST /api/auth/session` (authorized clients only) when under 7 days remain. Rotating the
  service password revokes every token; rotating the computer address makes every computer
  pair again (the old token stays valid, but only at the new address, which it does not know).
- `pair` has no `--remote` flag: redsun ships no web UI, so a pairing link opened in a browser
  on the backend route would only reach a 404.

Atomic phone enable: `POST /api/remote/enable` → `RemoteControl.Access {status, tunnel,
companion}` enrolls a companion when none is (the server generates the credential, stores the
handoff in the companion's private store through `importHandoff`, pointing at the registration
sidecar passed in `ServerOptions.remoteControl.registration`), enables phone access when it is
off or has no origin, and enables the policy; a second call changes nothing. The TUI does not
enroll on its own any more; the dialog calls this endpoint.

### The `/remote` dialog

Titled **Remote access**, with the backend status beside the title. Three groups whose rows
follow state; an action that needs confirmation turns its own row into the confirmation.

- **Phones.** Off: "Turn on phone access" (`POST /api/remote/enable`). On: "Add a phone"
  (opens the five-minute registration window and shows the origin as a link and QR; hidden
  while a phone is connected), pending approvals ("Approve phone <fingerprint>", confirmed),
  "Show phone link", "Turn off phone access" (policy off; the address and registered phones
  are kept).
- **Computers.** Off: "Turn on computer access", confirmed first because it exposes the whole
  local API to anyone who pairs. On: "Add a computer" (issues a pairing and shows
  `redsun attach <link>` as text and QR), "Show computer address" (the bare URL for a machine
  that already holds a token), "Turn off computer access" (the address is kept).
- **Advanced.** "New phone address" and "New computer address" (confirmed rotates), "Use a
  custom phone address" (manual companion origin), "Forget all phones and credentials"
  (confirmed revoke).

Footer: `Phones: <state> — <origin>`, one line of phone guidance (companion error, "Phone
connected", "No phone yet; choose Add a phone", "Companion starting"), `Computers: <state> —
<origin>`, then warnings. Rows and status lines appear only once the companion, tunnel and
computers states have all answered ("Checking remote access…" meanwhile), so the first row
is never stale; while an action runs the list is locked, not emptied. A TUI attached from
another computer (no local service registration) sees the status lines and "Manage remote
access on the host computer" instead of rows. The `state` labels are shared with the CLI:
off, issuing, waiting, attaching, ready, failed.

Trust: Anomaly operates the relay, the zone and certificate issuance (ZeroSSL); traffic
is end-to-end TLS to this host. Self-hosting is a Cloudflare Worker deployment under
your own zone (`OPENTUNNEL_API` selects the API origin), not a container.

## Passive attachment and restart

The managed service publishes `<ordinary-registration-path>.remote` under its global
state directory, containing **only** `{id,version,url,pid}`. Unlike the ordinary
registration file it has no service password. Its absolute path is in the handoff.
It can be stale after a crash; existence is not readiness. The service removes a stale
sidecar and recreates it through the same protected private-file helper as the handoff
(owner-only Windows ACL, POSIX 0600) so a companion's owner-only check can accept it;
an inherited state-directory ACL is not sufficient on Windows.

1. Read and validate this discovery file. Allow only local loopback HTTP URLs with no
   userinfo, query or fragment. Never follow redirects or send the token to a network
   host supplied by the browser. The approved contract is local-only.
2. Call `GET /api/remote` with the scoped Authorization header below. HTTP success
   means the application router is ready; `/api/health` is intentionally local-only.
3. Require `supported:true`, `enabled:true`, `version:1`, matching `backendID` from the
   imported handoff, and `processID === registration.id`. On mismatch stop attachment;
   do not silently adopt/re-enroll another backend. Version 1 means exactly the scoped
   capability table below, not all methods present in the generated client.
4. On disconnect/restart rediscover passively, revalidate both identities and capability
   version, subscribe anew and resnapshot. Never start/replace the backend. Disabled,
   revoked and invalid credentials all fail closed. A local operator can inspect status
   with `redsun remote status`; the scoped caller cannot query status while disabled.

Companion auth is exclusively:

```text
Authorization: Bearer rc1.<credentialID>.<token>
```

It is not a Basic password, query token, cookie, PTY ticket, forwarded address or
principal-identifying header. Never send it to a browser, URL or command argument.
Browser users must authenticate to the companion, whose server makes these requests.
Configure redsun loopback separately; RC does not change existing listener bindings.

## Version 1 HTTP capability table

All paths below require scoped authentication **and enabled policy**. Unknown methods,
paths, query keys and mutation fields are denied. IDs in these paths must have their
normal `ses_`, `msg_`, `per_`, `frm_` prefixes. `global` forms are not companion-owned.
The generated schemas define field types, required fields, pagination and response
envelopes; this table narrows their authorization surface.

| Method and route | Allowed input / result |
| --- | --- |
| GET `/api/remote` | `RemoteControl.Status` |
| GET `/api/remote/theme` | No query; `RemoteControl.Theme` |
| POST `/api/remote/heartbeat` | `{connected:boolean}`; Status |
| GET `/api/remote/agent` | Location query; `{location,data:[{id,name,mode}]}`; visible non-subagent choices |
| GET `/api/remote/model` | Location query; `{location,data:[{id,providerID,name,variants:[{id}]}]}` |
| GET `/api/location` | `location[directory]`, optional `location[workspace]`; resolved location |
| GET `/api/session` | `workspace,limit,order,search,parentID,directory,project,subpath,cursor`; paginated sessions |
| POST `/api/session` | Only `id,title,agent,model,location`; created session |
| GET `/api/session/active` | Active execution map |
| GET `/api/session/:sessionID` | Session info |
| GET `/api/session/:sessionID/message` | `limit,order,cursor`; history page |
| GET `/api/session/:sessionID/message/:messageID` | Single history message |
| GET `/api/session/:sessionID/inbox` | Pending durable inputs |
| POST `/api/session/:sessionID/prompt` | Required `id,text`; optional `files,delivery` |
| POST `/api/session/:sessionID/interrupt` | No body fields; optional `continue=true/false` query; `{interrupted}` |
| POST `/api/session/:sessionID/move` | `directory`, optional `workspaceID,delivery`; 204 |
| POST `/api/session/:sessionID/agent` | `{agent}`; 204 |
| POST `/api/session/:sessionID/model` | `{model:{id,providerID,variant?}}`; 204 |
| GET `/api/session/:sessionID/permission` | Pending permission requests |
| GET `/api/session/:sessionID/permission/:requestID` | Owned permission request |
| POST `/api/session/:sessionID/permission/:requestID/reply` | `reply:once/always/reject`, optional `message`; 204 |
| GET `/api/session/:sessionID/form` | Pending supported forms |
| GET `/api/session/:sessionID/form/:formID` | Owned supported form |
| GET `/api/session/:sessionID/form/:formID/state` | Settlement state |
| POST `/api/session/:sessionID/form/:formID/reply` | `{answer:{...}}`; canonical Form answer validation; 204 |
| POST `/api/session/:sessionID/form/:formID/cancel` | No body fields; 204 |
| GET `/api/event` | Scoped live SSE; see below |

The theme route returns the host TUI theme name, mode and resolved hex colors from the
global `cli.json` selection and global `themes` directory; project-level `.redsun/themes`
directories and TUI plugin-installed themes are not consulted. Configuration and theme
files are read on every request, with no cross-request cache; missing or invalid selections
fall back to `dusk`, and documents with both modes use dark. Colors use `#rrggbb`, with an
alpha suffix only when alpha is less than 1.

Location objects allow only `{directory,workspaceID?}`, model references only
`{id,providerID,variant?}`. Paths remain backend OS paths; a browser pathname is not a
filesystem path. Moves follow the existing durable queue behavior and must be confirmed
by reading the session location, not by assuming 204 means a busy session moved already.

Local-only administration: PUT `/api/remote/policy` with `{enabled}` returns
`{status,persisted}`; POST `/api/remote/enrollment` with
`{backendID,credentialID,digest}` returns 204 or 409; DELETE the same path revokes all
credentials and returns `{status,persisted}`. These require existing local authentication,
not the scoped token. Enrollment does not implicitly enable RC.

Refusals are 401 (including disabled/revoked/bad credentials and scope rejection).
Outer process refusal may have an empty body and Basic challenge. Handler failures
retain HTTP status (400 validation, 404 missing/unsupported, 409 conflict, 503 unavailable,
500 unexpected) but companion error bodies are generic
`{_tag:"RemoteRequestError",message:"Remote operation refused or failed"}`. Do not rely
on detailed local error fields or print arbitrary server errors. Unrecognized routes
are never an implicit capability. Success statuses/envelopes remain canonical.

## Attachments and response limitations

Companion prompt bodies are bounded to **6 MiB total**, at most four files. Each file
has only `uri` and optional `name` (255 characters maximum). URI must be base64 `data:`
with media type `text/plain`, `image/png`, `image/jpeg`, or `image/webp`. No raw `file:`,
HTTP fetch, attachment mentions, skill/agent attachments, metadata, `resume`, commands,
shell or synthetic-prompt APIs. Use ordinary prompt text to ask the agent to inspect
files through its normal permission-controlled tools; never implement raw file reads
through an attachment workaround.

History exposes user-visible text/reasoning and tool input/text output, not opaque
provider state, metadata, file-output URIs, raw provider/tool errors, or system/skill
instruction bodies. Inbox user items retain text but omit attachment/metadata internals.
Agent/model catalogs omit system prompts, provider settings, request bodies and headers.
Permission/form metadata is removed. External-URL forms are hidden/refused because they
can carry authorization URLs; supported fields are string/number/integer/boolean/
multiselect. Render missing optional metadata safely; do not assume parity with local UI.

This is **not content DLP**: text deliberately put into conversation or tool output can
contain sensitive user content. It is trusted-owner access. The implementation keeps
backend authentication/configuration material out of protocol-managed status, events,
errors and catalog internals; it does not promise to detect every secret an agent reads.

## Admission, liveness and synchronization

Authentication captures a credential ID plus the current revocation/disable epoch.
Route/query and bounded structured body checks run first. The final enabled/credential/
epoch check, immediately before entering the authorized API effect, is the **request
admission boundary**. A request still uploading when disable wins is refused. If it
already crossed that boundary, its operation may complete (including location resolution
or durable input admission) after disable. Disable does not interrupt admitted agent
work. HTTP cancellation does not undo a durably admitted prompt.

SSE subscriptions register against the same epoch, including a recheck when attaching
the stream. Disable/revoke closes existing companion streams; local streams survive.
Transient heartbeat reports belong to the authenticated credential, not a supplied
principal ID. Lease is **30 seconds**, measured with a monotonic clock; send heartbeats
roughly every 10 seconds. `connected:false` reports companion-ready; `true` reports an
authenticated browser/control connection. Across live leases, any connected report
wins. All leases expire and reset at process restart. SSE comments alone never renew
the lease. This is companion-reported liveness, not a phone connectivity probe.

Status fields: `supported,enabled,enrolled,backendID?,processID,version:1,leaseSeconds:30`
and `state:disabled|unavailable|ready|connected`. Enabled without a live lease is
unavailable. `backendID` is absent if an initial durable identity could not be persisted.
TUI state changes are published on `remote.status` (up to one-second detection), with
authoritative API refresh/reconnect and polling fallback.

Companion SSE includes only `server.connected`, `remote.status`, and `remote.sync`.
The explicit source-event list is `packages/server/src/remote-access.ts`; session,
permission, form and catalog changes in that list become `{id,created,type:"remote.sync",
data:{}}`. Raw event payloads, locations and metadata are not forwarded. Coalesce these
hints and refetch relevant snapshots; do not feed them to the ordinary full-fidelity
Solid session reducer. Unknown events, plugin RPC, credentials, config, filesystem,
PTY and shell administration events are dropped.

The global event feed is **live-only**, with no Last-Event-ID replay. Subscribe first,
then resnapshot sessions/history/inbox/active/forms/permissions, resnapshot again when
hints arrive during initial reads. On every reconnect resnapshot; use periodic refresh
as a backstop. Dropping-queue overflow fails a stream rather than silently preserving
an authoritative client state. The experimental durable session-event route is denied.

Always generate and retain a prompt `msg_...` ID before submission. Existing inbox
reconciliation returns the existing same-session user item for that ID, including
after promotion to history; it does **not** compare replacement text as an edit.
An ID belonging to another session/type conflicts. On an uncertain response, query
inbox and single-message history first. Retain original intent and ID; do not blindly
submit a new ID or assume an absent observation proves a failed request. These are the
existing contracts, not new exactly-once execution/replay semantics.

## Generated client consumption

Do not install the public upstream client release and assume it has these endpoints.
In this checkout run:

```text
cd packages/client
bun run generate
bun run script/export-remote.ts <new-output-directory>
```

The exclusive new directory contains the generated promise client's four TypeScript
modules, LICENSE, handoff/registration JSON Schemas, and `contract.json` with version
and SHA-256 artifact hashes. Vendor this directory into the companion and pin the redsun
commit alongside the manifest. It has no workspace runtime dependencies; the isolated
export test exercises it. Import `OpenCode` from its `index.ts`, use `OpenCode.make`
with baseUrl and a server-only Authorization header. Catalog methods are
`client.remoteCatalog.agents/models/theme`; policy/status methods are `client.remote.*`.
Other methods retain the generated session/form/permission API. Its full method surface
is **not** the authorization allowlist. Use a redirect-refusing, loopback-validating
server-side fetch wrapper. No separate npm package was published.

## Files and verification

Canonical contracts: `packages/schema/src/remote-control.ts`, event manifest;
`packages/protocol/src/groups/remote-{control,catalog}.ts`, API and client group mappings.
Backend: `packages/server/src/remote-{control,access,projection,tunnel}.ts`, handlers,
authorization, process/options/routes and scoped event handling.
CLI: `commands/handlers/remote{,-tunnel,-computers}.ts` and `attach.ts`,
`services/remote-local.ts` (loopback preflight shared by all), `services/attachments.ts`
(private token store), `services/server-connection.ts` (stored-token lookup and renewal),
command registry, service config and registration. Secure file helper:
`packages/util/src/private-file.ts`. TUI: remote context/dialog, app provider/command and
shared workspace status. Client: normal generated trees, build type references, export
script and test.

Focused coverage is in server `remote-control`, `remote-admission`, `remote-projection`
tests; CLI `redsun-remote-handoff`, `redsun-remote-attach`; TUI `remote-control`; client
`remote-export`.
Tests use temporary enrollment/configuration, isolated DBs and loopback/in-memory APIs,
not the developer backend, a real tunnel, or provider credentials. The execution-survival
test uses a deterministic runner barrier, not a paid model request.

Verification commands are run from their package directories:

- Core wrapper: `bun run test ../server/test` (offline/environment isolation).
- Core wrapper: `bun run test ../cli/test/redsun-remote-handoff.test.ts ../cli/test/redsun-remote-attach.test.ts`.
- TUI: `bun test test/remote-control.test.tsx test/app-lifecycle.test.tsx`.
- TUI themes: `bun test test/theme.test.ts test/theme test/cli/tui/theme-mode.test.tsx test/cli/tui/dialog-theme-list.test.tsx`.
- Theme: `bun test`.
- Client: `bun test test/remote-export.test.ts`; `bun run generate`.
- Root: `bun turbo typecheck --concurrency=3`; `bun lint`.

Live verification on one Linux device against the hosted relay (2026-10-09): phone access
end to end with a headless browser and a virtual authenticator (register, approve, passkey
sign-in, `connected`), and computer access (enable, pair, `redsun attach <link>`, `--server`
with the stored token and no password, token renewal, disable, rotate, service restart).
The `service.test.ts` managed-service subprocess cases time out on this host independently
of remote control; the RC tests do not share that fixture.

No cross-host end-to-end validation is claimed. The CLI handoff test exercises private file
creation on the platform it runs on (POSIX exclusive 0600 here; the Windows ACL path needs a
Windows run). There is no automatic
reconciling import/resume CLI, no optional directory root policy, no external
authorization-form UI, no per-browser lease identity, and no global SSE replay. Those are
limitations, not implemented companion features.
