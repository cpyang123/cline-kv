import type { ApiProvider } from "@shared/api"
import { Logger } from "@shared/services/Logger"
import type { StateManager } from "@/core/storage/StateManager"
import { resolveModelId } from "@/sdk/cline-session-factory"
import { parseProviderId } from "@/sdk/model-catalog/provider-id"
import { createProviderConfigStore } from "@/sdk/model-catalog/store"
import { getProviderSettingsManager } from "@/sdk/provider-migration"
import { type BuildApiHandlerOptions, buildApiHandlerWithHostContext } from "@/sdk/sdk-api-handler"
import type { NoteWriterHandler } from "./writer"

export const GOODVISION_PROVIDER_ID: ApiProvider = "goodvision"
const GOODVISION_DEFAULT_WRITER_MODEL = "auto"

/** The writer's output budget (RSM_WRITER_MAXTOK / RSM_INLINE_MAXTOK in the harness). */
export const WRITER_MAX_OUTPUT_TOKENS = 900
/** The writer samples at temperature 0, as `distill_fused_note` hardcodes. */
export const WRITER_TEMPERATURE = 0

// Same patterns as the SDK's `isOpenAIReasoningEraModelId` (not exported): o-series and
// gpt-5-and-later ids reject any temperature but the default.
const OPENAI_O_SERIES_MODEL_ID_PATTERN = /(^|[^a-z0-9])o[134](?=$|[^a-z0-9])/
const OPENAI_GPT5_AND_LATER_MODEL_ID_PATTERN = /(^|[^a-z0-9])gpt-?[5-9](?=$|[^a-z0-9])/

export function modelRejectsTemperature(modelId: string | undefined): boolean {
	const normalized = modelId?.trim().toLowerCase()
	if (!normalized) {
		return false
	}
	return OPENAI_O_SERIES_MODEL_ID_PATTERN.test(normalized) || OPENAI_GPT5_AND_LATER_MODEL_ID_PATTERN.test(normalized)
}

/**
 * Request options of a writer call: no extended thinking, 900 output tokens, and
 * temperature 0 unless the model rejects it. A call that goes through the
 * GoodVision gateway never gets a temperature, whether the GoodVision writer is
 * selected or the task itself runs on GoodVision: this mirrors the harness's
 * strict mode for OpenAI-protocol gateways, and the router's `auto` route answers
 * a request that carries `temperature: 0` with 502 `upstream_unavailable` on
 * every attempt (observed 2026-10-30), so pinning it there makes the writer fail
 * instead of making it deterministic. A bare `auto` model id is treated the same
 * way for any provider, since it is a router alias and not a model.
 */
export function writerHandlerOptions(
	writer: "task" | "goodvision",
	modelId: string | undefined,
	providerId?: string,
): BuildApiHandlerOptions {
	const routesThroughGateway =
		writer === "goodvision" || providerId === GOODVISION_PROVIDER_ID || modelId?.trim().toLowerCase() === "auto"
	const pinTemperature = !routesThroughGateway && !modelRejectsTemperature(modelId)
	return {
		disableReasoning: true,
		maxOutputTokens: WRITER_MAX_OUTPUT_TOKENS,
		...(pinTemperature ? { temperature: WRITER_TEMPERATURE } : {}),
	}
}

/**
 * The model the GoodVision writer runs on: the model committed for GoodVision in
 * Act mode, else the one saved in providers.json, else the router's `auto`.
 */
export function resolveGoodVisionWriterModelId(): string {
	try {
		const selection = createProviderConfigStore().readSelection(parseProviderId(GOODVISION_PROVIDER_ID), "act")
		if (selection?.modelId?.trim()) {
			return selection.modelId.trim()
		}
	} catch (error) {
		Logger.warn("[KnowledgeVault] Failed to read the committed GoodVision model:", error)
	}
	try {
		const model = getProviderSettingsManager().getProviderSettings(GOODVISION_PROVIDER_ID)?.model?.trim()
		if (model) {
			return model
		}
	} catch {
		Logger.warn("[KnowledgeVault] Failed to read the GoodVision model from providers.json")
	}
	return GOODVISION_DEFAULT_WRITER_MODEL
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
