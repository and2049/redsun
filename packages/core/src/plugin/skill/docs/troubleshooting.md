# Troubleshooting

> **Tip:** You can ask redsun to debug itself. Describe the problem and ask it to use this troubleshooting page; it can read
> the steps below, inspect its service and logs, and help identify the issue.

redsun uses a client-server architecture. A background server owns sessions, plugins, permissions, and other application
state. Start by determining whether an issue is in a client, the shared server, or a specific project.

## Check the background service

Show the current server status:

```bash
redsun service status
```

Verify that its API is healthy:

```bash
redsun api get /api/health
```

If the service is stuck or unhealthy, restart it:

```bash
redsun service restart
```

You can also stop and start it explicitly:

```bash
redsun service stop
redsun service start
```

> **Note:** redsun normally discovers or starts the shared background service automatically. The service commands are only
> needed when diagnosing its lifecycle.

## Allow a browser origin

If a browser client on another origin cannot connect because of CORS, add the client's origin to the service configuration:

```bash
redsun service set cors http://192.168.1.10:3001
redsun service get cors
```

Use an exact HTTP or HTTPS origin, including the port when needed, without a path or trailing slash. To allow multiple
origins, pass a comma-separated list as one argument; whitespace around each origin is trimmed:

```bash
redsun service set cors "http://192.168.1.10:3001, https://app.example.com"
```

`service get cors` prints a JSON array. Remove the configured list with:

```bash
redsun service unset cors
```

Setting or unsetting service configuration stops the background service. Its next start picks up the new configuration;
use `redsun service start` to start it explicitly.

For a foreground server, repeat `--cors` for each additional allowed origin:

```bash
redsun serve --cors http://192.168.1.10:3001 --cors https://app.example.com
```

With `serve --service`, supplied `--cors` flags override the persisted list for that process. Without those flags, service
mode uses the persisted list. CORS does not change the listening address or bypass server authentication.

## Inspect the API

The `api` command uses the local service discovery and authentication flow. It accepts either an HTTP method and path or an
OpenAPI operation ID.

See the [API reference](https://opencode.ai/v2/docs/api) for all endpoints and operation IDs.

Pass a JSON request body with `--data` or `-d`, and add headers with `--header` or `-H`.

> **Warning:** Running `redsun api` may start the background service when no compatible healthy service is available.

## Read logs

Installed builds write logs to:

```text
~/.local/share/redsun/log/opencode.log
```

Follow the log while reproducing the problem:

```bash
tail -f ~/.local/share/redsun/log/opencode.log
```

Each line includes a process `run` ID and a `role` field. Use `role=server` for session, provider, plugin, permission, and
tool activity.

```bash
grep 'role=server' ~/.local/share/redsun/log/opencode.log
grep 'run=8fc3b1d5' ~/.local/share/redsun/log/opencode.log
```

## Capture CPU and memory profiles

On macOS and Linux, you can signal a running redsun process to capture diagnostic data. Get the background server PID
from the health endpoint:

```bash
redsun api get /api/health
```

Use the `pid` from the response with one of these signals:

- `SIGPROF` captures a ten-second CPU profile:

  ```bash
  kill -SIGPROF <pid>
  ```

  The result is written to the log directory as `cpu-<pid>-<timestamp>.cpuprofile`.

- `SIGUSR1` captures a memory (heap) snapshot:

  ```bash
  kill -SIGUSR1 <pid>
  ```

  The result is written to the log directory as `heap-<pid>-<timestamp>.heapsnapshot`.

Wait for `CPU profile written` or `heap snapshot written` in `opencode.log` before opening the file. The corresponding
log entry includes its complete path. You can inspect both file types in Chrome DevTools.

> **Note:** Signal-triggered profiles are not available on Windows. Writing a heap snapshot can pause the process and temporarily
> increase its memory usage.

## Service files

The shared server registers itself at:

```text
~/.local/state/redsun/service.json
```

Its private service configuration is stored separately at:

```text
~/.config/redsun/service.json
```

The database normally lives at:

```text
~/.local/share/redsun/redsun-release.db
```

`OPENCODE_DB` can override the database location.

> **Warning:** Do not delete or edit service files or the database while troubleshooting. Use the service commands to manage the
> daemon, and make a backup before inspecting persistent data with external tools.

## Report an issue

Include the following when reporting a reproducible problem:

- Output from `redsun --version`
- Output from `redsun service status`
- The smallest sequence of steps that reproduces the issue
- Whether the issue affects the shared service, a specific client, or one project
- Relevant log lines, including their `run` and `role` fields

Remove API keys, authorization headers, prompts, file contents, and other sensitive data before sharing logs.

File reproducible problems in [GitHub Issues](https://github.com/and2049/redsun/issues).
