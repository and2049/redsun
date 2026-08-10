import type { Hooks } from "@opencode-ai/plugin"
import { ClaudeCodeExecutable } from "@/claude-code/executable"
import { ClaudeCodeModels } from "@/claude-code/models"
import { ClaudeCodeProbe } from "@/claude-code/probe"

/**
 * Registers the `claude-code` delegated-agent provider. The config() hook
 * runs before Provider.Service reads `cfg.provider`, so injecting the entry
 * here makes `claude-code/<model>` addressable everywhere (model picker,
 * task_router.*, agent.<name>.model) with no provider.ts changes.
 *
 * The provider only appears when the `claude` CLI is resolvable. The auth
 * method never signs the user in itself — sign-in stays owned by the CLI
 * (`claude` + /login); "connecting" verifies that sign-in through the SDK
 * init handshake and stores the account label so the provider shows as
 * connected with the subscription it uses.
 */
export async function ClaudeCodePlugin(): Promise<Hooks> {
  let claudeConfig: { binary_path?: string; config_dir?: string; env?: Record<string, string> } = {}
  return {
    async config(config) {
      const cfg = config as {
        claude_code?: { enabled?: boolean; binary_path?: string; config_dir?: string; env?: Record<string, string> }
        provider?: Record<string, unknown>
      }
      claudeConfig = cfg.claude_code ?? {}
      if (cfg.claude_code?.enabled === false) return
      if (cfg.provider?.[ClaudeCodeModels.PROVIDER_ID]) return
      const resolution = ClaudeCodeExecutable.resolve(cfg.claude_code?.binary_path)
      if ("error" in resolution) return
      cfg.provider = {
        ...cfg.provider,
        [ClaudeCodeModels.PROVIDER_ID]: ClaudeCodeModels.providerConfig(),
      }
    },
    auth: {
      provider: ClaudeCodeModels.PROVIDER_ID,
      methods: [
        {
          type: "oauth",
          label: "Claude Code CLI (Pro/Max subscription)",
          authorize: async () => ({
            url: "https://claude.com/claude-code",
            instructions:
              "Verifying your Claude Code CLI sign-in. If this fails, run `claude` in a terminal, sign in with /login, then retry.",
            method: "auto",
            callback: async () => {
              const resolution = ClaudeCodeExecutable.resolve(claudeConfig.binary_path)
              if ("error" in resolution) return { type: "failed" as const }
              const result = await ClaudeCodeProbe.probe({
                executablePath: resolution.path,
                configDir: claudeConfig.config_dir,
                env: claudeConfig.env,
              })
              if (!result.ok) return { type: "failed" as const }
              return {
                type: "success" as const,
                key: "claude-code-cli",
                metadata: {
                  ...(result.account.email ? { email: result.account.email } : {}),
                  ...(result.account.subscription ? { subscription: result.account.subscription } : {}),
                  ...(result.account.apiProvider ? { backend: result.account.apiProvider } : {}),
                },
              }
            },
          }),
        },
      ],
    },
  }
}
