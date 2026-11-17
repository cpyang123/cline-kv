import { type ApiHandler, createHandlerAsync } from "@cline/llms";
import type { BasicLogger } from "@cline/shared";
import {
	type ConnectionConfig,
	resolveConnectionProviderConfig,
} from "../../services/llms/handler-factory";
import {
	type ProviderConfig,
	type ProviderSettings,
	toProviderConfig,
} from "../../services/llms/provider-settings";
import type { KnowledgeVaultWriter } from "./constants";
import type { NoteWriterHandler } from "./writer";
import {
	GOODVISION_PROVIDER_ID,
	knowledgeVaultWriterRequestOptions,
	resolveGoodVisionWriterModelId,
} from "./writer-options";

/** The session's provider connection, as hosts hold it on `CoreSessionConfig`. */
export type KnowledgeVaultWriterSessionConnection = ConnectionConfig;

/** The slice of `ProviderSettingsManager` the GoodVision writer reads. */
export interface KnowledgeVaultProviderSettingsSource {
	getProviderSettings(providerId: string): ProviderSettings | undefined;
}

export interface CreateKnowledgeVaultWriterHandlerOptions {
	/** The KV writer setting: `task` = the session's own model, `goodvision` = the GoodVision router. */
	writer: KnowledgeVaultWriter;
	/** The session's provider connection (used by the `task` writer). */
	session: KnowledgeVaultWriterSessionConnection;
	/**
	 * Where the GoodVision provider's saved settings (credentials, base URL,
	 * model) come from; usually the host's `ProviderSettingsManager`. Required
	 * for the `goodvision` writer.
	 */
	providerSettings?: KnowledgeVaultProviderSettingsSource;
	/**
	 * The model the host committed for GoodVision, preferred over the model
	 * saved in providers.json; the router's `auto` is the last fallback.
	 */
	goodVisionModelId?: string;
	/** Extra provider config fields applied to every writer handler (e.g. a host's proxy-aware `fetch`). */
	providerConfigOverrides?: Partial<ProviderConfig>;
	logger?: BasicLogger;
	/** Handler factory; defaults to `@cline/llms` `createHandlerAsync`. */
	createHandler?: (config: ProviderConfig) => Promise<ApiHandler>;
}

/**
 * Resolve the provider config a Knowledge Vault writer call runs on, with the
 * writer request options applied: no extended thinking (effort and budget are
 * dropped), 900 output tokens, and temperature 0 only when neither the
 * GoodVision gateway, an `auto` model id, nor a temperature-rejecting model is
 * involved.
 */
export function resolveKnowledgeVaultWriterProviderConfig(
	options: CreateKnowledgeVaultWriterHandlerOptions,
): ProviderConfig {
	let base: ProviderConfig;
	if (options.writer === "goodvision") {
		const settings = options.providerSettings?.getProviderSettings(
			GOODVISION_PROVIDER_ID,
		);
		if (!settings) {
			throw new Error(
				"The Knowledge Vault writer is set to GoodVision, but no GoodVision provider is configured.",
			);
		}
		const modelId = resolveGoodVisionWriterModelId(
			options.goodVisionModelId,
			settings.model,
		);
		base = toProviderConfig({ ...settings, model: modelId });
	} else {
		base = resolveConnectionProviderConfig(options.session);
	}

	const {
		reasoningEffort: _reasoningEffort,
		thinkingBudgetTokens: _thinkingBudgetTokens,
		temperature: _temperature,
		abortSignal: _abortSignal,
		...rest
	} = { ...base, ...options.providerConfigOverrides };
	return {
		...rest,
		...knowledgeVaultWriterRequestOptions(
			options.writer,
			rest.modelId,
			rest.providerId,
		),
		...(options.logger ? { logger: options.logger } : {}),
	};
}

/**
 * Build the handler the note writer runs on. With the `task` writer it is the
 * session's own provider and model (the actor doubles as the writer, as in the
 * paper's Knowledge Vault arm); with the `goodvision` writer it is the
 * GoodVision SmartRouter saved in providers.json, whatever the task ran on.
 * The returned handler reports the provider id from `getModel()` so notes
 * record which provider wrote them.
 */
export async function createKnowledgeVaultWriterHandler(
	options: CreateKnowledgeVaultWriterHandlerOptions,
): Promise<NoteWriterHandler> {
	const config = resolveKnowledgeVaultWriterProviderConfig(options);
	const handler = await (options.createHandler ?? createHandlerAsync)(config);
	return {
		createMessage: (systemPrompt, messages, tools) =>
			handler.createMessage(systemPrompt, messages, tools),
		getModel: () => ({ ...handler.getModel(), providerId: config.providerId }),
	};
}
