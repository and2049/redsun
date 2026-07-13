import { Log } from "../util/log"
import path from "path"
import os from "os"
import { pathToFileURL } from "url"
import z from "zod"
import { Filesystem } from "../util/filesystem"
import { ModelsDev } from "../provider/models"
import { mergeDeep, pipe } from "remeda"
import { Global } from "../global"
import fs from "fs/promises"
import { lazy } from "../util/lazy"
import { NamedError } from "@redsun/util/error"
import { Flag } from "../flag/flag"
import { Auth } from "../auth"
import { type ParseError as JsoncParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser"
import { Instance } from "../project/instance"
import { LSPServer } from "../lsp/server"
import { BunProc } from "@/bun"
import { Installation } from "@/installation"
import { ConfigMarkdown } from "./markdown"

export namespace Config {
  const log = Log.create({ service: "config" })
  export type SourceScope = "user" | "project"

  // Custom merge function that concatenates extension arrays instead of replacing them
  function mergeConfigWithExtensions(target: Info, source: Info): Info {
    const merged = mergeDeep(target, source)
    // If both configs have extension arrays, concatenate them instead of replacing
    if (target.extension && source.extension) {
      const extensionSet = new Set([...target.extension, ...source.extension])
      merged.extension = Array.from(extensionSet)
    }
    return merged
  }

  export const state = Instance.state(async () => {
    const auth = await Auth.all()
    let result = await global()
    const extensions = {
      user: new Set(result.extension ?? []),
      project: new Set<string>(),
    }
    const projectMcp = new Set<string>()
    const projectProviderModules = new Set<string>()
    let userDefaultProjectTrust = result.defaultProjectTrust

    const mergeSource = (source: Info, scope: SourceScope) => {
      for (const entry of source.extension ?? []) extensions[scope].add(entry)
      if (scope === "project" && source.mcp && typeof source.mcp === "object") {
        for (const name of Object.keys(source.mcp)) projectMcp.add(name)
      }
      if (scope === "project") {
        for (const [providerID, provider] of Object.entries(source.provider ?? {})) {
          if (provider.npm) projectProviderModules.add(`${providerID}\0${provider.npm}`)
          for (const model of Object.values(provider.models ?? {})) {
            if (model.provider?.npm) projectProviderModules.add(`${providerID}\0${model.provider.npm}`)
          }
        }
      }
      if (scope === "user" && source.defaultProjectTrust !== undefined) {
        userDefaultProjectTrust = source.defaultProjectTrust
      }
      result = mergeConfigWithExtensions(result, source)
    }

    // Override with custom config if provided
    if (Flag.REDSUN_CONFIG) {
      mergeSource(await loadFile(Flag.REDSUN_CONFIG), "user")
      log.debug("loaded custom config", { path: Flag.REDSUN_CONFIG })
    }

    for (const file of ["redsun.jsonc", "redsun.json"]) {
      const found = await Filesystem.findUp(file, Instance.directory, Instance.worktree)
      for (const resolved of found.toReversed()) {
        mergeSource(await loadFile(resolved), "project")
      }
    }

    if (Flag.REDSUN_CONFIG_CONTENT) {
      mergeSource(JSON.parse(Flag.REDSUN_CONFIG_CONTENT), "user")
      log.debug("loaded custom config from REDSUN_CONFIG_CONTENT")
    }

    for (const [key, value] of Object.entries(auth)) {
      if (value.type === "wellknown") {
        process.env[value.key] = value.token
        const wellknown = (await fetch(`${key}/.well-known/redsun`).then((x) => x.json())) as any
        mergeSource(await load(JSON.stringify(wellknown.config ?? {}), process.cwd()), "user")
      }
    }

    result.agent = result.agent || {}
    result.mode = result.mode || {}
    result.extension = result.extension || []

    const directoryEntries: Array<{ path: string; scope: SourceScope }> = [
      { path: Global.Path.config, scope: "user" },
      ...(await Array.fromAsync(
        Filesystem.up({
          targets: [".redsun"],
          start: Instance.directory,
          stop: Instance.worktree,
        }),
      )).map((path) => ({ path, scope: "project" as const })),
      ...(await Array.fromAsync(
        Filesystem.up({
          targets: [".redsun"],
          start: Global.Path.home,
          stop: Global.Path.home,
        }),
      )).map((path) => ({ path, scope: "user" as const })),
    ]

    const configDir = process.env["REDSUN_CONFIG_DIR"]
    if (configDir) {
      try {
        await fs.mkdir(configDir, { recursive: true })
        directoryEntries.push({ path: configDir, scope: "user" })
        log.debug("loading config from REDSUN_CONFIG_DIR", { path: configDir })
      } catch (error) {
        if (!isUnavailable(error)) throw error
        log.warn("skipping unavailable REDSUN_CONFIG_DIR", { path: configDir })
      }
    }

    const scopedDirectories = Array.from(
      directoryEntries
        .reduce((result, entry) => {
          const previous = result.get(entry.path)
          result.set(entry.path, {
            path: entry.path,
            scope: previous?.scope === "project" || entry.scope === "project" ? "project" : "user",
          })
          return result
        }, new Map<string, { path: string; scope: SourceScope }>())
        .values(),
    )
    const directories = scopedDirectories.map((entry) => entry.path)
    const promises: Promise<void>[] = []
    for (const { path: dir, scope } of scopedDirectories) {
      try {
        await fs.readdir(dir)
        await assertValid(dir)
      } catch (error) {
        if (isUnavailable(error)) {
          log.warn("skipping unavailable config directory", { path: dir })
          continue
        }
        throw error
      }

      if (dir.endsWith(".redsun") || dir === configDir) {
        for (const file of ["redsun.jsonc", "redsun.json"]) {
          log.debug(`loading config from ${path.join(dir, file)}`)
          mergeSource(await loadFile(path.join(dir, file)), scope)
          // to satisy the type checker
          result.agent ??= {}
          result.mode ??= {}
          result.extension ??= []
        }
      }

      promises.push(installDependencies(dir))
      result.command = mergeDeep(result.command ?? {}, await loadCommand(dir))
      result.agent = mergeDeep(result.agent, await loadAgent(dir))
      result.agent = mergeDeep(result.agent, await loadMode(dir))
    }
    await Promise.allSettled(promises)

    // Migrate deprecated mode field to agent field
    for (const [name, mode] of Object.entries(result.mode)) {
      result.agent = mergeDeep(result.agent ?? {}, {
        [name]: {
          ...mode,
          mode: "primary" as const,
        },
      })
    }

    if (Flag.REDSUN_PERMISSION) {
      result.permission = mergeDeep(result.permission ?? {}, JSON.parse(Flag.REDSUN_PERMISSION))
    }

    if (!result.username) result.username = os.userInfo().username



    if (!result.keybinds) result.keybinds = Info.shape.keybinds.parse({})

    // Apply flag overrides for compaction settings
    if (Flag.REDSUN_DISABLE_AUTOCOMPACT) {
      result.compaction = { ...result.compaction, auto: false }
    }
    if (Flag.REDSUN_DISABLE_PRUNE) {
      result.compaction = { ...result.compaction, prune: false }
    }

    return {
      config: result,
      directories,
      scopedDirectories,
      extensions: {
        user: Array.from(extensions.user),
        project: Array.from(extensions.project),
      },
      projectMcp: Array.from(projectMcp),
      projectProviderModules: Array.from(projectProviderModules),
      userDefaultProjectTrust,
    }
  })

  const INVALID_DIRS = new Bun.Glob(`{${["agents", "commands", "extensions", "tools", "skills"].join(",")}}/`)
  async function assertValid(dir: string) {
    const invalid = await Array.fromAsync(
      INVALID_DIRS.scan({
        onlyFiles: false,
        cwd: dir,
      }),
    )
    for (const item of invalid) {
      throw new ConfigDirectoryTypoError({
        path: dir,
        dir: item,
        suggestion: item.substring(0, item.length - 1),
      })
    }
  }

  async function installDependencies(dir: string) {
    if (Installation.isLocal()) return

    const pkg = path.join(dir, "package.json")

    if (!(await Bun.file(pkg).exists())) {
      await Bun.write(pkg, "{}")
    }

    const gitignore = path.join(dir, ".gitignore")
    const hasGitIgnore = await Bun.file(gitignore).exists()
    if (!hasGitIgnore) await Bun.write(gitignore, ["node_modules", "package.json", "bun.lock", ".gitignore"].join("\n"))
  }

  const COMMAND_GLOB = new Bun.Glob("command/**/*.md")
  async function loadCommand(dir: string) {
    const result: Record<string, Command> = {}
    for await (const item of COMMAND_GLOB.scan({
      absolute: true,
      followSymlinks: true,
      dot: true,
      cwd: dir,
    })) {
      const md = await ConfigMarkdown.parse(item)
      if (!md.data) continue

      const name = (() => {
        const patterns = ["/.redsun/command/", "/command/"]
        const pattern = patterns.find((p) => item.includes(p))

        if (pattern) {
          const index = item.indexOf(pattern)
          return item.slice(index + pattern.length, -3)
        }
        return path.basename(item, ".md")
      })()

      const config = {
        name,
        ...md.data,
        template: md.content.trim(),
      }
      const parsed = Command.safeParse(config)
      if (parsed.success) {
        result[config.name] = parsed.data
        continue
      }
      throw new InvalidError({ path: item, issues: parsed.error.issues }, { cause: parsed.error })
    }
    return result
  }

  const AGENT_GLOB = new Bun.Glob("agent/**/*.md")
  async function loadAgent(dir: string) {
    const result: Record<string, Agent> = {}

    for await (const item of AGENT_GLOB.scan({
      absolute: true,
      followSymlinks: true,
      dot: true,
      cwd: dir,
    })) {
      const md = await ConfigMarkdown.parse(item)
      if (!md.data) continue

      // Extract relative path from agent folder for nested agents
      let agentName = path.basename(item, ".md")
      const agentFolderPath = item.includes("/.redsun/agent/")
        ? item.split("/.redsun/agent/")[1]
        : item.includes("/agent/")
          ? item.split("/agent/")[1]
          : agentName + ".md"

      // If agent is in a subfolder, include folder path in name
      if (agentFolderPath.includes("/")) {
        const relativePath = agentFolderPath.replace(".md", "")
        const pathParts = relativePath.split("/")
        agentName = pathParts.slice(0, -1).join("/") + "/" + pathParts[pathParts.length - 1]
      }

      const config = {
        name: agentName,
        ...md.data,
        prompt: md.content.trim(),
      }
      const parsed = Agent.safeParse(config)
      if (parsed.success) {
        result[config.name] = parsed.data
        continue
      }
      throw new InvalidError({ path: item, issues: parsed.error.issues }, { cause: parsed.error })
    }
    return result
  }

  const MODE_GLOB = new Bun.Glob("mode/*.md")
  async function loadMode(dir: string) {
    const result: Record<string, Agent> = {}
    for await (const item of MODE_GLOB.scan({
      absolute: true,
      followSymlinks: true,
      dot: true,
      cwd: dir,
    })) {
      const md = await ConfigMarkdown.parse(item)
      if (!md.data) continue

      const config = {
        name: path.basename(item, ".md"),
        ...md.data,
        prompt: md.content.trim(),
      }
      const parsed = Agent.safeParse(config)
      if (parsed.success) {
        result[config.name] = {
          ...parsed.data,
          mode: "primary" as const,
        }
        continue
      }
    }
    return result
  }

  export const McpLocal = z
    .object({
      type: z.literal("local").describe("Type of MCP server connection"),
      command: z.string().array().describe("Command and arguments to run the MCP server"),
      environment: z
        .record(z.string(), z.string())
        .optional()
        .describe("Environment variables to set when running the MCP server"),
      enabled: z.boolean().optional().describe("Enable or disable the MCP server on startup"),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Timeout in ms for fetching tools from the MCP server. Defaults to 5000 (5 seconds) if not specified.",
        ),
    })
    .strict()
    .meta({
      ref: "McpLocalConfig",
    })

  export const McpOAuth = z
    .object({
      clientId: z
        .string()
        .optional()
        .describe("OAuth client ID. If not provided, dynamic client registration (RFC 7591) will be attempted."),
      clientSecret: z.string().optional().describe("OAuth client secret (if required by the authorization server)"),
      scope: z.string().optional().describe("OAuth scopes to request during authorization"),
    })
    .strict()
    .meta({
      ref: "McpOAuthConfig",
    })
  export type McpOAuth = z.infer<typeof McpOAuth>

  export const McpRemote = z
    .object({
      type: z.literal("remote").describe("Type of MCP server connection"),
      url: z.string().describe("URL of the remote MCP server"),
      enabled: z.boolean().optional().describe("Enable or disable the MCP server on startup"),
      headers: z.record(z.string(), z.string()).optional().describe("Headers to send with the request"),
      oauth: z
        .union([McpOAuth, z.literal(false)])
        .optional()
        .describe(
          "OAuth authentication configuration for the MCP server. Set to false to disable OAuth auto-detection.",
        ),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Timeout in ms for fetching tools from the MCP server. Defaults to 5000 (5 seconds) if not specified.",
        ),
    })
    .strict()
    .meta({
      ref: "McpRemoteConfig",
    })

  export const Mcp = z.discriminatedUnion("type", [McpLocal, McpRemote])
  export type Mcp = z.infer<typeof Mcp>

  export const Permission = z.enum(["ask", "allow", "deny"])
  export type Permission = z.infer<typeof Permission>

  export const Command = z.object({
    template: z.string(),
    description: z.string().optional(),
    agent: z.string().optional(),
    model: z.string().optional(),
    subtask: z.boolean().optional(),
  })
  export type Command = z.infer<typeof Command>

  export const Agent = z
    .object({
      model: z.string().optional(),
      temperature: z.number().optional(),
      top_p: z.number().optional(),
      prompt: z.string().optional(),
      tools: z.record(z.string(), z.boolean()).optional(),
      disable: z.boolean().optional(),
      description: z.string().optional().describe("Description of when to use the agent"),
      mode: z.enum(["subagent", "primary", "all"]).optional(),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/, "Invalid hex color format")
        .optional()
        .describe("Hex color code for the agent (e.g., #FF5733)"),
      maxSteps: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of agentic iterations before forcing text-only response"),
      hidden: z
        .boolean()
        .optional()
        .describe("Hide the agent from the TUI agent list"),
      permission: z
        .object({
          edit: Permission.optional(),
          bash: z.union([Permission, z.record(z.string(), Permission)]).optional(),
          skill: z.union([Permission, z.record(z.string(), Permission)]).optional(),
          webfetch: Permission.optional(),
          doom_loop: Permission.optional(),
          external_directory: Permission.optional(),
        })
        .optional(),
    })
    .catchall(z.any())
    .meta({
      ref: "AgentConfig",
    })
  export type Agent = z.infer<typeof Agent>

  export const Keybinds = z
    .object({
      leader: z.string().optional().default("ctrl+x").describe("Leader key for keybind combinations"),
      app_exit: z.string().optional().default("ctrl+c,ctrl+d,<leader>q").describe("Exit the application"),
      editor_open: z.string().optional().default("<leader>e").describe("Open external editor"),
      theme_list: z.string().optional().default("<leader>t").describe("List available themes"),
      sidebar_toggle: z.string().optional().default("<leader>b").describe("Toggle sidebar"),
      scrollbar_toggle: z.string().optional().default("none").describe("Toggle session scrollbar"),
      username_toggle: z.string().optional().default("none").describe("Toggle username visibility"),
      status_view: z.string().optional().default("<leader>s").describe("View status"),
      session_export: z.string().optional().default("<leader>x").describe("Export session to editor"),
      session_new: z.string().optional().default("ctrl+n").describe("Create a new session"),
      session_list: z.string().optional().default("<leader>l").describe("List all sessions"),
      session_timeline: z.string().optional().default("<leader>g").describe("Show session timeline"),
      session_fork: z.string().optional().default("none").describe("Fork session from message"),
      session_rename: z.string().optional().default("none").describe("Rename session"),

      session_interrupt: z.string().optional().default("ctrl+\\").describe("Interrupt current session"),
      session_compact: z.string().optional().default("<leader>c").describe("Compact the session"),
      messages_page_up: z.string().optional().default("pageup").describe("Scroll messages up by one page"),
      messages_page_down: z.string().optional().default("pagedown").describe("Scroll messages down by one page"),
      messages_half_page_up: z.string().optional().default("ctrl+alt+u").describe("Scroll messages up by half page"),
      messages_half_page_down: z
        .string()
        .optional()
        .default("ctrl+alt+d")
        .describe("Scroll messages down by half page"),
      messages_first: z.string().optional().default("ctrl+g,home").describe("Navigate to first message"),
      messages_last: z.string().optional().default("ctrl+alt+g,end").describe("Navigate to last message"),
      messages_next: z.string().optional().default("none").describe("Navigate to next message"),
      messages_previous: z.string().optional().default("none").describe("Navigate to previous message"),
      messages_last_user: z.string().optional().default("none").describe("Navigate to last user message"),
      messages_copy: z.string().optional().default("<leader>y").describe("Copy message"),
      messages_undo: z.string().optional().default("<leader>u").describe("Undo message"),
      messages_redo: z.string().optional().default("<leader>r").describe("Redo message"),
      messages_toggle_conceal: z
        .string()
        .optional()
        .default("<leader>h")
        .describe("Toggle code block concealment in messages"),
      tool_details: z.string().optional().default("none").describe("Toggle tool details visibility"),
      model_list: z.string().optional().default("<leader>m").describe("List available models"),
      model_cycle_recent: z.string().optional().default("f2").describe("Next recently used model"),
      model_cycle_recent_reverse: z.string().optional().default("shift+f2").describe("Previous recently used model"),
      model_cycle_favorite: z.string().optional().default("none").describe("Next favorite model"),
      model_cycle_favorite_reverse: z.string().optional().default("none").describe("Previous favorite model"),
      command_list: z.string().optional().default("ctrl+p").describe("List available commands"),
      agent_list: z.string().optional().default("<leader>a").describe("List agents"),
      agent_cycle: z.string().optional().default("tab").describe("Next agent"),
      agent_cycle_reverse: z.string().optional().default("shift+tab").describe("Previous agent"),
      input_clear: z.string().optional().default("ctrl+c").describe("Clear input field"),
      input_paste: z.string().optional().default("ctrl+v").describe("Paste from clipboard"),
      input_submit: z.string().optional().default("return").describe("Submit input"),
      input_newline: z
        .string()
        .optional()
        .default("shift+return,ctrl+return,alt+return,ctrl+j")
        .describe("Insert newline in input"),
      input_move_left: z.string().optional().default("left,ctrl+b").describe("Move cursor left in input"),
      input_move_right: z.string().optional().default("right,ctrl+f").describe("Move cursor right in input"),
      input_move_up: z.string().optional().default("up").describe("Move cursor up in input"),
      input_move_down: z.string().optional().default("down").describe("Move cursor down in input"),
      input_select_left: z.string().optional().default("shift+left").describe("Select left in input"),
      input_select_right: z.string().optional().default("shift+right").describe("Select right in input"),
      input_select_up: z.string().optional().default("shift+up").describe("Select up in input"),
      input_select_down: z.string().optional().default("shift+down").describe("Select down in input"),
      input_line_home: z.string().optional().default("ctrl+a").describe("Move to start of line in input"),
      input_line_end: z.string().optional().default("ctrl+e").describe("Move to end of line in input"),
      input_select_line_home: z
        .string()
        .optional()
        .default("ctrl+shift+a")
        .describe("Select to start of line in input"),
      input_select_line_end: z.string().optional().default("ctrl+shift+e").describe("Select to end of line in input"),
      input_visual_line_home: z.string().optional().default("alt+a").describe("Move to start of visual line in input"),
      input_visual_line_end: z.string().optional().default("alt+e").describe("Move to end of visual line in input"),
      input_select_visual_line_home: z
        .string()
        .optional()
        .default("alt+shift+a")
        .describe("Select to start of visual line in input"),
      input_select_visual_line_end: z
        .string()
        .optional()
        .default("alt+shift+e")
        .describe("Select to end of visual line in input"),
      input_buffer_home: z.string().optional().default("home").describe("Move to start of buffer in input"),
      input_buffer_end: z.string().optional().default("end").describe("Move to end of buffer in input"),
      input_select_buffer_home: z
        .string()
        .optional()
        .default("shift+home")
        .describe("Select to start of buffer in input"),
      input_select_buffer_end: z.string().optional().default("shift+end").describe("Select to end of buffer in input"),
      input_delete_line: z.string().optional().default("ctrl+shift+d").describe("Delete line in input"),
      input_delete_to_line_end: z.string().optional().default("ctrl+k").describe("Delete to end of line in input"),
      input_delete_to_line_start: z.string().optional().default("ctrl+u").describe("Delete to start of line in input"),
      input_backspace: z.string().optional().default("backspace,shift+backspace").describe("Backspace in input"),
      input_delete: z.string().optional().default("ctrl+d,delete,shift+delete").describe("Delete character in input"),
      input_undo: z.string().optional().default("ctrl+-,super+z").describe("Undo in input"),
      input_redo: z.string().optional().default("ctrl+.,super+shift+z").describe("Redo in input"),
      input_word_forward: z
        .string()
        .optional()
        .default("alt+f,alt+right,ctrl+right")
        .describe("Move word forward in input"),
      input_word_backward: z
        .string()
        .optional()
        .default("alt+b,alt+left,ctrl+left")
        .describe("Move word backward in input"),
      input_select_word_forward: z
        .string()
        .optional()
        .default("alt+shift+f,alt+shift+right")
        .describe("Select word forward in input"),
      input_select_word_backward: z
        .string()
        .optional()
        .default("alt+shift+b,alt+shift+left")
        .describe("Select word backward in input"),
      input_delete_word_forward: z
        .string()
        .optional()
        .default("alt+d,alt+delete,ctrl+delete")
        .describe("Delete word forward in input"),
      input_delete_word_backward: z
        .string()
        .optional()
        .default("ctrl+w,ctrl+backspace,alt+backspace")
        .describe("Delete word backward in input"),
      history_previous: z.string().optional().default("up").describe("Previous history item"),
      history_next: z.string().optional().default("down").describe("Next history item"),
      session_child_cycle: z.string().optional().default("<leader>down,<leader>right").describe("Next child session"),
      session_child_cycle_reverse: z.string().optional().default("<leader>left").describe("Previous child session"),
      session_parent: z.string().optional().default("<leader>up").describe("Go to parent session"),
      terminal_suspend: z.string().optional().default("ctrl+z").describe("Suspend terminal"),
      terminal_title_toggle: z.string().optional().default("none").describe("Toggle terminal title"),
      tips_toggle: z.string().optional().default("<leader>h").describe("Toggle tips on home screen"),
    })
    .strict()
    .meta({
      ref: "KeybindsConfig",
    })

  export const TUI = z.object({
    scroll_speed: z.number().min(0.001).optional().describe("TUI scroll speed"),
    scroll_acceleration: z
      .object({
        enabled: z.boolean().describe("Enable scroll acceleration"),
      })
      .optional()
      .describe("Scroll acceleration settings"),
    diff_style: z
      .enum(["auto", "stacked"])
      .optional()
      .describe("Control diff rendering style: 'auto' adapts to terminal width, 'stacked' always shows single column"),
  })

  export const Server = z
    .object({
      port: z.number().int().positive().optional().describe("Port to listen on"),
      hostname: z.string().optional().describe("Hostname to listen on"),
      mdns: z.boolean().optional().describe("Enable mDNS service discovery"),
    })
    .strict()
    .meta({
      ref: "ServerConfig",
    })

  export const Layout = z.enum(["auto", "stretch"]).meta({
    ref: "LayoutConfig",
  })
  export type Layout = z.infer<typeof Layout>

  export const Provider = ModelsDev.Provider.partial()
    .extend({
      whitelist: z.array(z.string()).optional(),
      blacklist: z.array(z.string()).optional(),
      models: z.record(z.string(), ModelsDev.Model.partial()).optional(),
      options: z
        .object({
          apiKey: z.string().optional(),
          baseURL: z.string().optional(),
          enterpriseUrl: z.string().optional().describe("GitHub Enterprise URL for copilot authentication"),
          setCacheKey: z.boolean().optional().describe("Enable promptCacheKey for this provider (default false)"),
          openaiCompatibleCacheControl: z
            .boolean()
            .optional()
            .describe("Opt in to cache_control provider metadata for OpenAI-compatible providers that support it"),
          experimentalResponsesContinuation: z
            .union([z.literal(false), z.literal("api-only")])
            .optional()
            .describe("Experimental OpenAI Responses API continuation mode. Defaults to false."),
          timeout: z
            .union([
              z
                .number()
                .int()
                .positive()
                .describe(
                  "Timeout in milliseconds for requests to this provider. Default is 300000 (5 minutes). Set to false to disable timeout.",
                ),
              z.literal(false).describe("Disable timeout for this provider entirely."),
            ])
            .optional()
            .describe(
              "Timeout in milliseconds for requests to this provider. Default is 300000 (5 minutes). Set to false to disable timeout.",
            ),
        })
        .catchall(z.any())
        .optional(),
    })
    .strict()
    .meta({
      ref: "ProviderConfig",
    })
  export type Provider = z.infer<typeof Provider>

  export const Info = z
    .object({
      $schema: z.string().optional().describe("JSON schema reference for configuration validation"),
      theme: z.string().optional().describe("Theme name to use for the interface"),
      keybinds: Keybinds.optional().describe("Custom keybind configurations"),
      logLevel: Log.Level.optional().describe("Log level"),
      tui: TUI.optional().describe("TUI specific settings"),
      server: Server.optional()        .describe("Server configuration for redsun serve and web commands"),
      command: z
        .record(z.string(), Command)
        .optional()
        .describe("Command configuration, see https://opencode.ai/docs/commands"),
      watcher: z
        .object({
          ignore: z.array(z.string()).optional(),
        })
        .optional(),
      extension: z.string().array().optional(),
      defaultProjectTrust: z.enum(["ask", "always", "never"]).optional().describe("Default behavior for project trust prompts (default: ask)"),
      snapshot: z.boolean().optional(),

      disabled_providers: z.array(z.string()).optional().describe("Disable providers that are loaded automatically"),
      enabled_providers: z
        .array(z.string())
        .optional()
        .describe("When set, ONLY these providers will be enabled. All other providers will be ignored"),
      model: z.string().describe("Model to use in the format of provider/model, eg anthropic/claude-2").optional(),
      small_model: z
        .string()
        .describe("Small model to use for tasks like title generation in the format of provider/model")
        .optional(),
      task_router: z
        .object({
          compact: z.string().optional().describe("Model for context compaction"),
          summary: z.string().optional().describe("Model for session summaries"),
          title: z.string().optional().describe("Model for title generation"),
          explore: z.string().optional().describe("Model for exploration subagents"),
        })
        .optional()
        .describe("Per-task model routing for different task types"),
      default_agent: z
        .string()
        .optional()
        .describe(
          "Default agent to use when none is specified. Must be a primary agent. Falls back to 'build' if not set or if the specified agent is invalid.",
        ),
      username: z
        .string()
        .optional()
        .describe("Custom username to display in conversations instead of system username"),
      mode: z
        .object({
          build: Agent.optional(),
          plan: Agent.optional(),
        })
        .catchall(Agent)
        .optional()
        .describe("@deprecated Use `agent` field instead."),
      agent: z
        .object({
          // primary
          plan: Agent.optional(),
          build: Agent.optional(),
          // subagent
          general: Agent.optional(),
          explore: Agent.optional(),
          // specialized
          title: Agent.optional(),
          summary: Agent.optional(),
          compaction: Agent.optional(),
        })
        .catchall(Agent)
        .optional()
        .describe("Agent configuration, see https://opencode.ai/docs/agent"),
      provider: z
        .record(z.string(), Provider)
        .optional()
        .describe("Custom provider configurations and model overrides"),
      mcp: z.record(z.string(), Mcp).optional().describe("MCP (Model Context Protocol) server configurations"),
      formatter: z
        .union([
          z.literal(false),
          z.record(
            z.string(),
            z.object({
              disabled: z.boolean().optional(),
              command: z.array(z.string()).optional(),
              environment: z.record(z.string(), z.string()).optional(),
              extensions: z.array(z.string()).optional(),
            }),
          ),
        ])
        .optional(),
      lsp: z
        .union([
          z.literal(false),
          z.record(
            z.string(),
            z.union([
              z.object({
                disabled: z.literal(true),
              }),
              z.object({
                command: z.array(z.string()),
                extensions: z.array(z.string()).optional(),
                disabled: z.boolean().optional(),
                env: z.record(z.string(), z.string()).optional(),
                initialization: z.record(z.string(), z.any()).optional(),
              }),
            ]),
          ),
        ])
        .optional()
        .refine(
          (data) => {
            if (!data) return true
            if (typeof data === "boolean") return true
            const serverIds = new Set(Object.values(LSPServer).map((s) => s.id))

            return Object.entries(data).every(([id, config]) => {
              if (config.disabled) return true
              if (serverIds.has(id)) return true
              return Boolean(config.extensions)
            })
          },
          {
            error: "For custom LSP servers, 'extensions' array is required.",
          },
        ),
      instructions: z.array(z.string()).optional().describe("Additional instruction files or patterns to include"),
      layout: Layout.optional().describe("@deprecated Always uses stretch layout."),
      permission: z
        .object({
          edit: Permission.optional(),
          bash: z.union([Permission, z.record(z.string(), Permission)]).optional(),
          skill: z.union([Permission, z.record(z.string(), Permission)]).optional(),
          webfetch: Permission.optional(),
          doom_loop: Permission.optional(),
          external_directory: Permission.optional(),
        })
        .optional(),
      tools: z.record(z.string(), z.boolean()).optional(),
      compaction: z
        .object({
          auto: z.boolean().optional().describe("Enable automatic compaction when context is full (default: true)"),
          prune: z.boolean().optional().describe("Enable pruning of old tool outputs (default: true)"),
          strategy: z
            .enum(["hybrid", "algorithmic", "llm"])
            .optional()
            .describe("Compaction strategy: 'hybrid' = algorithmic extraction + LLM synthesis (default), 'algorithmic' = rule-based only (0 LLM tokens), 'llm' = full LLM summarization"),
          keepRecent: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Number of recent messages to keep verbatim in hybrid mode LLM input (default: 4)"),
          triggerThreshold: z
            .number()
            .gt(0)
            .max(1)
            .optional()
            .describe("Context usage ratio that triggers automatic compaction (default: 0.7)"),
          resetThreshold: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe("Context usage ratio that rearms automatic compaction after a trigger (default: 0.4)"),
          maxToolResults: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Maximum number of tool result summaries to keep in algorithmic compaction inventory (default: 30)"),
        })
        .refine(
          (value) => (value.resetThreshold ?? 0.4) < (value.triggerThreshold ?? 0.7),
          "compaction.resetThreshold must be lower than compaction.triggerThreshold",
        )
        .optional(),
      experimental: z
        .object({
          hook: z
            .object({
              file_edited: z
                .record(
                  z.string(),
                  z
                    .object({
                      command: z.string().array(),
                      environment: z.record(z.string(), z.string()).optional(),
                    })
                    .array(),
                )
                .optional(),
              session_completed: z
                .object({
                  command: z.string().array(),
                  environment: z.record(z.string(), z.string()).optional(),
                })
                .array()
                .optional(),
            })
            .optional(),
          chatMaxRetries: z.number().optional().describe("Number of retries for chat completions on failure"),
          disable_paste_summary: z.boolean().optional(),
          batch_tool: z.boolean().optional().describe("Enable the batch tool"),
          openTelemetry: z
            .boolean()
            .optional()
            .describe("Enable OpenTelemetry spans for AI SDK calls (using the 'experimental_telemetry' flag)"),
          primary_tools: z
            .array(z.string())
            .optional()
            .describe("Tools that should only be available to primary agents."),
          continue_loop_on_deny: z.boolean().optional().describe("Continue the agent loop when a tool call is denied"),
        })
        .optional(),
    })
    .strict()
    .meta({
      ref: "Config",
    })

  export type Info = z.output<typeof Info>

  export const global = lazy(async () => {
    let result: Info = pipe(
      {},
      mergeDeep(await loadFile(path.join(Global.Path.config, "config.json"))),
      mergeDeep(await loadFile(path.join(Global.Path.config, "redsun.json"))),
      mergeDeep(await loadFile(path.join(Global.Path.config, "redsun.jsonc"))),
    )

    await import(path.join(Global.Path.config, "config"), {
      with: {
        type: "toml",
      },
    })
      .then(async (mod) => {
        const { provider, model, ...rest } = mod.default
        if (provider && model) result.model = `${provider}/${model}`
        result["$schema"] = "https://redsun.sh/config.json"
        result = mergeDeep(result, rest)
        await Bun.write(path.join(Global.Path.config, "config.json"), JSON.stringify(result, null, 2))
        await fs.unlink(path.join(Global.Path.config, "config"))
      })
      .catch(() => {})

    return result
  })

  async function loadFile(filepath: string): Promise<Info> {
    log.info("loading", { path: filepath })
    let text = await Bun.file(filepath)
      .text()
      .catch((err) => {
        if (isUnavailable(err)) return
        throw new JsonError({ path: filepath }, { cause: err })
      })
    if (!text) return {}
    return load(text, filepath)
  }

  function isUnavailable(error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code
    return code === "ENOENT" || code === "EACCES" || code === "EPERM"
  }

  async function load(text: string, configFilepath: string) {
    text = text.replace(/\{env:([^}]+)\}/g, (_, varName) => {
      return process.env[varName] || ""
    })

    const fileMatches = text.match(/\{file:[^}]+\}/g)
    if (fileMatches) {
      const configDir = path.dirname(configFilepath)
      const lines = text.split("\n")

      for (const match of fileMatches) {
        const lineIndex = lines.findIndex((line) => line.includes(match))
        if (lineIndex !== -1 && lines[lineIndex].trim().startsWith("//")) {
          continue // Skip if line is commented
        }
        let filePath = match.replace(/^\{file:/, "").replace(/\}$/, "")
        if (filePath.startsWith("~/")) {
          filePath = path.join(os.homedir(), filePath.slice(2))
        }
        const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(configDir, filePath)
        const fileContent = (
          await Bun.file(resolvedPath)
            .text()
            .catch((error) => {
              const errMsg = `bad file reference: "${match}"`
              if (error.code === "ENOENT") {
                throw new InvalidError(
                  {
                    path: configFilepath,
                    message: errMsg + ` ${resolvedPath} does not exist`,
                  },
                  { cause: error },
                )
              }
              throw new InvalidError({ path: configFilepath, message: errMsg }, { cause: error })
            })
        ).trim()
        // escape newlines/quotes, strip outer quotes
        text = text.replace(match, JSON.stringify(fileContent).slice(1, -1))
      }
    }

    const errors: JsoncParseError[] = []
    const data = parseJsonc(text, errors, { allowTrailingComma: true })
    if (errors.length) {
      const lines = text.split("\n")
      const errorDetails = errors
        .map((e) => {
          const beforeOffset = text.substring(0, e.offset).split("\n")
          const line = beforeOffset.length
          const column = beforeOffset[beforeOffset.length - 1].length + 1
          const problemLine = lines[line - 1]

          const error = `${printParseErrorCode(e.error)} at line ${line}, column ${column}`
          if (!problemLine) return error

          return `${error}\n   Line ${line}: ${problemLine}\n${"".padStart(column + 9)}^`
        })
        .join("\n")

      throw new JsonError({
        path: configFilepath,
        message: `\n--- JSONC Input ---\n${text}\n--- Errors ---\n${errorDetails}\n--- End ---`,
      })
    }

    const parsed = Info.safeParse(data)
    if (parsed.success) {
      if (!parsed.data.$schema) {
        parsed.data.$schema = "https://redsun.sh/config.json"
        await Bun.write(configFilepath, JSON.stringify(parsed.data, null, 2))
      }
      const data = parsed.data
      if (data.extension) {
        const configDirUrl = pathToFileURL(path.dirname(configFilepath)).href
        for (let i = 0; i < data.extension.length; i++) {
          const extension = data.extension[i]
          try {
            data.extension[i] = import.meta.resolve!(extension, configDirUrl)
          } catch (err) {}
        }
      }
      return data
    }

    throw new InvalidError({
      path: configFilepath,
      issues: parsed.error.issues,
    })
  }
  export const JsonError = NamedError.create(
    "ConfigJsonError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
    }),
  )

  export const ConfigDirectoryTypoError = NamedError.create(
    "ConfigDirectoryTypoError",
    z.object({
      path: z.string(),
      dir: z.string(),
      suggestion: z.string(),
    }),
  )

  export const InvalidError = NamedError.create(
    "ConfigInvalidError",
    z.object({
      path: z.string(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
      message: z.string().optional(),
    }),
  )

  export async function get() {
    return state().then((x) => x.config)
  }

  export async function update(config: Info) {
    const filepath = path.join(Instance.directory, "redsun.json")
    const existing = await loadFile(filepath)
    await Bun.write(filepath, JSON.stringify(mergeDeep(existing, config), null, 2))
    await Instance.dispose()
  }

  export async function directories() {
    return state().then((x) => x.directories)
  }

  export async function executableDirectories(scope: SourceScope) {
    return state().then((x) => x.scopedDirectories.filter((entry) => entry.scope === scope).map((entry) => entry.path))
  }

  export async function extensionEntries(scope: SourceScope) {
    return state().then((x) => x.extensions[scope])
  }

  export async function isProjectMcp(name: string) {
    return state().then((x) => x.projectMcp.includes(name))
  }

  export async function isProjectProviderModule(providerID: string, npm: string) {
    return state().then((x) => x.projectProviderModules.includes(`${providerID}\0${npm}`))
  }

  export async function userDefaultProjectTrust() {
    return state().then((x) => x.userDefaultProjectTrust)
  }
}
