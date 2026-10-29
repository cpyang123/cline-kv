import type { CoreSessionConfig } from "@cline/core"
import {
	DEFAULT_KNOWLEDGE_VAULT_TEMPLATE,
	DEFAULT_KNOWLEDGE_VAULT_WRITE_MODE,
	DEFAULT_KNOWLEDGE_VAULT_WRITER,
} from "@shared/knowledge-vault"
import {
	buildKnowledgeVaultHooks,
	buildKnowledgeVaultWriterHandler,
	composeAgentHooks,
	KnowledgeVaultStore,
} from "@/core/knowledge-vault"
import type { StateManager } from "@/core/storage/StateManager"
import { buildSessionConfig, type SessionConfigInput } from "./cline-session-factory"
import { buildAgentHooks, type HookMessageEmitter } from "./hooks-adapter"

export interface SdkSessionConfigBuilderOptions {
	stateManager: StateManager
	emitHookMessage: HookMessageEmitter
	onConsecutiveMistakeLimitReached?: CoreSessionConfig["onConsecutiveMistakeLimitReached"]
}

/**
 * Unlike the CLI interactive runtime, plan-mode sessions do NOT expose a
 * switch_to_act_mode tool: matching the legacy extension, the model cannot
 * switch modes itself and must ask the user to flip the Plan/Act toggle. The
 * plan-mode system prompt (planModeSwitchTool: false in the session factory)
 * carries the matching instructions.
 */
export class SdkSessionConfigBuilder {
	constructor(private readonly options: SdkSessionConfigBuilderOptions) {}

	async build(input: SessionConfigInput): Promise<Awaited<ReturnType<typeof buildSessionConfig>>> {
		const config = await buildSessionConfig(input)
		if (this.options.onConsecutiveMistakeLimitReached) {
			config.onConsecutiveMistakeLimitReached = this.options.onConsecutiveMistakeLimitReached
		}

		const { stateManager, emitHookMessage } = this.options
		const fileHooks = buildAgentHooks(stateManager, emitHookMessage, input.cwd)
		// Knowledge Vault: recall the workspace's notes on the first run, write one
		// note per completed session. Settings are read per run so the toggle
		// applies without rebuilding the session.
		const vault = buildKnowledgeVaultHooks({
			isEnabled: () => stateManager.getGlobalSettingsKey("knowledgeVaultEnabled") ?? true,
			getTemplate: () => stateManager.getGlobalSettingsKey("knowledgeVaultTemplate") ?? DEFAULT_KNOWLEDGE_VAULT_TEMPLATE,
			getWriter: () => stateManager.getGlobalSettingsKey("knowledgeVaultWriter") ?? DEFAULT_KNOWLEDGE_VAULT_WRITER,
			getWriteMode: () =>
				stateManager.getGlobalSettingsKey("knowledgeVaultWriteMode") ?? DEFAULT_KNOWLEDGE_VAULT_WRITE_MODE,
			store: KnowledgeVaultStore.forWorkspace(input.workspaceRoot?.trim() || input.cwd),
			createWriterHandler: () => buildKnowledgeVaultWriterHandler(stateManager),
			emitHookMessage,
		})
		config.hooks = composeAgentHooks(fileHooks, vault.hooks)

		return config
	}
}
