import type { KnowledgeVaultWriter } from "./constants";

/** The provider id of the GoodVision SmartRouter (the `goodvision` writer). */
export const GOODVISION_PROVIDER_ID = "goodvision";
/** The router alias the GoodVision writer falls back to when no model is configured. */
export const GOODVISION_DEFAULT_WRITER_MODEL = "auto";

/** The writer's output budget (RSM_WRITER_MAXTOK / RSM_INLINE_MAXTOK in the harness). */
export const KNOWLEDGE_VAULT_WRITER_MAX_OUTPUT_TOKENS = 900;
/** The writer samples at temperature 0, as `distill_fused_note` hardcodes. */
export const KNOWLEDGE_VAULT_WRITER_TEMPERATURE = 0;

// Same patterns as the SDK's `isOpenAIReasoningEraModelId` (not exported): o-series and
// gpt-5-and-later ids reject any temperature but the default.
const OPENAI_O_SERIES_MODEL_ID_PATTERN = /(^|[^a-z0-9])o[134](?=$|[^a-z0-9])/;
const OPENAI_GPT5_AND_LATER_MODEL_ID_PATTERN =
	/(^|[^a-z0-9])gpt-?[5-9](?=$|[^a-z0-9])/;

export function modelRejectsTemperature(modelId: string | undefined): boolean {
	const normalized = modelId?.trim().toLowerCase();
	if (!normalized) {
		return false;
	}
	return (
		OPENAI_O_SERIES_MODEL_ID_PATTERN.test(normalized) ||
		OPENAI_GPT5_AND_LATER_MODEL_ID_PATTERN.test(normalized)
	);
}

/** Request options of a Knowledge Vault writer call, in `ProviderConfig` terms. */
export interface KnowledgeVaultWriterRequestOptions {
	/** Extended thinking is always off: the writer is a one-shot, tool-free completion. */
	thinking: false;
	maxOutputTokens: number;
	/** Present only when the call may pin a temperature (see {@link knowledgeVaultWriterRequestOptions}). */
	temperature?: number;
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
export function knowledgeVaultWriterRequestOptions(
	writer: KnowledgeVaultWriter,
	modelId: string | undefined,
	providerId?: string,
): KnowledgeVaultWriterRequestOptions {
	const routesThroughGateway =
		writer === "goodvision" ||
		providerId === GOODVISION_PROVIDER_ID ||
		modelId?.trim().toLowerCase() === GOODVISION_DEFAULT_WRITER_MODEL;
	const pinTemperature =
		!routesThroughGateway && !modelRejectsTemperature(modelId);
	return {
		thinking: false,
		maxOutputTokens: KNOWLEDGE_VAULT_WRITER_MAX_OUTPUT_TOKENS,
		...(pinTemperature
			? { temperature: KNOWLEDGE_VAULT_WRITER_TEMPERATURE }
			: {}),
	};
}

/**
 * The model the GoodVision writer runs on: the first non-blank candidate (a
 * host passes the model it committed for GoodVision, then the model saved in
 * providers.json), else the router's `auto`.
 */
export function resolveGoodVisionWriterModelId(
	...candidates: Array<string | undefined | null>
): string {
	for (const candidate of candidates) {
		const trimmed = candidate?.trim();
		if (trimmed) {
			return trimmed;
		}
	}
	return GOODVISION_DEFAULT_WRITER_MODEL;
}
