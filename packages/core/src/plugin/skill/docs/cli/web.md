# Web

redsun does not ship a web UI. The server that powers the TUI is password
protected, and browser or remote clients connect to it over HTTP.

## Access

```bash
$ redsun pair

  Open a link to connect. Links work once and expire in 5 minutes.

  http://127.0.0.1:49374/auth/connect/...

  █▀▀▀▀▀█ ...
```

Opening a link in a browser signs it in with a session cookie and loads the web
UI. Scanning the QR code from the redsun app, or pasting the link into its
server address field, connects the app the same way. Sessions last 30 days;
changing the server password signs every session out.

### Over SSH

When the server listens only on localhost, forward its port from your machine
and open the printed link locally:

```bash
$ ssh -L 49374:127.0.0.1:49374 my-server
```

By default the server listens only on localhost. Its port depends on the
platform:

| Platform              | Default port |
| --------------------- | ------------ |
| macOS, Linux, and WSL | 49374        |
| Windows               | 28894        |

Windows reserves ports from 49152 up, and WSL mirrored networking reserves
another block below that. Print the current address with
`redsun service status`:

```bash
$ redsun service status
http://127.0.0.1:49374
```

You can change this config with the `redsun service` command.

### Remote access

To connect from anywhere, pair through an [OpenTunnel](https://github.com/anomalyco/opentunnel)
remote address:

```bash
$ redsun pair --remote
```

The first time it turns remote access on, it asks before going ahead:

```text
▲  This will expose your redsun server to the internet.
│  Traffic is end-to-end encrypted, and access requires your server password.
│  To pair locally instead, run `redsun pair` without the --remote flag.
│
◆  Expose your server to the internet?
│  ● Yes / ○ No
```

Without an interactive terminal, the command fails unless you pass `--yes` to
accept. Once accepted, later runs skip the prompt, even after remote access has
been turned off with `redsun service set remote false`.

## Configure

Set any option with `redsun service set`:

```bash
# Listen on every network interface
$ redsun service set hostname 0.0.0.0

# Use a fixed port instead of the channel default
$ redsun service set port 49374

# Replace the generated password
$ redsun service set password "a-long-secret"

# Allow a web client served from another origin
$ redsun service set cors https://app.example.com,https://other.example.com

# Pass an environment variable to the server process
$ redsun service set env OPENCODE_LOG_LEVEL DEBUG
```

Changing a setting stops the background server. Start it again to apply the new config:

```bash
$ redsun service start
```

## Standalone

`redsun serve` runs the same server in the foreground instead of through the
shared background service.

```bash
$ redsun serve --hostname 0.0.0.0 --port 4096
server listening on http://0.0.0.0:4096
server password <password>
```

Use it when you want to:

- Run redsun on a shared, always-on, or remote host, then connect clients with
  `redsun --server <url>`.
- Control the hostname, port, and CORS origins for a single process.
- Run under a supervisor like systemd, Docker, or another environment that expects
  a foreground process.
- Keep a dedicated server instead of the shared background service.

Connect a client to it with `--server`:

```bash
$ redsun --server http://127.0.0.1:4096
```
