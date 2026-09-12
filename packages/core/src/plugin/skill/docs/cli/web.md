# Web

redsun ships with a web ui that is served from the same server that powers the
TUI. It's available by default and password protected.

## Access

```bash
$ redsun pair

  URLs      http://127.0.0.1:49374
  Username  opencode
  Password  ********
```

By default the server runs on port 49374 and listens only on localhost. You can
change this config with the `redsun service` command.

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

Changing a setting stops the background server. To apply the new config

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
