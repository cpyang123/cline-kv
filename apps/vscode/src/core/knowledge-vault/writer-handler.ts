import type { KnowledgeVaultNoteWriterHandler as NoteWriterHandler } from "@cline/core"
import {
	type KnowledgeVaultWriter,
	knowledgeVaultWriterRequestOptions,
	resolveGoodVisionWriterModelId as resolveCoreGoodVisionWriterModelId,
} from "@cline/core"
import type { ApiProvider } from "@shared/api"
import { Logger } from "@shared/services/Logger"
import type { StateManager } from "@/core/storage/StateManager"
import { resolveModelId } from "@/sdk/cline-session-factory"
import { parseProviderId } from "@/sdk/model-catalog/provider-id"
import { createProviderConfigStore } from "@/sdk/model-catalog/store"
import { getProviderSettingsManager } from "@/sdk/provider-migration"
import { type BuildApiHandlerOptions, buildApiHandlerWithHostContext } from "@/sdk/sdk-api-handler"

export const GOODVISION_PROVIDER_ID: ApiProvider = "goodvision"

/**
 * Request options of a writer call in the extension's handler terms: the core
 * Knowledge Vault's `knowledgeVaultWriterRequestOptions` (no extended thinking,
 * 900 output tokens, temperature 0 unless GoodVision, an `auto` model id, or a
 * temperature-rejecting model is involved).
 */
export function writerHandlerOptions(
	writer: KnowledgeVaultWriter,
	modelId: string | undefined,
	providerId?: string,
): BuildApiHandlerOptions {
	const options = knowledgeVaultWriterRequestOptions(writer, modelId, providerId)
	return {
		disableReasoning: true,
		maxOutputTokens: options.maxOutputTokens,
		...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
	}
}

/**
 * The model the GoodVision writer runs on: the model committed for GoodVision in
 * Act mode, else the one saved in providers.json, else the router's `auto`.
 */
export function resolveGoodVisionWriterModelId(): string {
	let committed: string | undefined
	try {
		committed = createProviderConfigStore().readSelection(parseProviderId(GOODVISION_PROVIDER_ID), "act")?.modelId
	} catch (error) {
		Logger.warn("[KnowledgeVault] Failed to read the committed GoodVision model:", error)
	}
	let saved: string | undefined
	try {
		saved = getProviderSettingsManager().getProviderSettings(GOODVISION_PROVIDER_ID)?.model
	} catch {
		Logger.warn("[KnowledgeVault] Failed to read the GoodVision model from providers.json")
	}
	return resolveCoreGoodVisionWriterModelId(committed, saved)
}

/**
 * Build the handler the note writer runs on. By default the writer is the
 * task's own Act-mode provider and model (the actor doubles as the writer, as in
 * the paper's Knowledge Vault arm); with the GoodVision writer setting it is the
 * SmartRouter configured under API Configuration, whatever the task ran on. The
 * writer is a one-shot, tool-free completion, so extended thinking is off.
 * `resolveModelId` reads the same slots the session factory does.
 */
export async function buildKnowledgeVaultWriterHandler(stateManager: StateManager): Promise<NoteWriterHandler> {
	const apiConfiguration = stateManager.getApiConfiguration()
	const writer = stateManager.getGlobalSettingsKey("knowledgeVaultWriter") === "goodvision" ? "goodvision" : "task"
	const configuration =
		writer === "goodvision"
			? {
					...apiConfiguration,
					actModeApiProvider: GOODVISION_PROVIDER_ID,
					actModeApiModelId: resolveGoodVisionWriterModelId(),
				}
			: apiConfiguration
	const modelId =
		writer === "goodvision"
			? configuration.actModeApiModelId
			: resolveModelId(configuration.actModeApiProvider ?? "cline", "act", configuration)
	return buildApiHandlerWithHostContext(
		configuration,
		"act",
		writerHandlerOptions(writer, modelId, configuration.actModeApiProvider),
	)
}
