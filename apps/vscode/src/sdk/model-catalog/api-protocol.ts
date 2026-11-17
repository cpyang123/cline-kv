import type { ProviderConfig } from "@cline/llms"
import { Logger } from "@shared/services/Logger"
import { getProviderSettingsManager } from "../provider-migration"
import type { OpenAICompatibleApiProtocol, ProviderId } from "./contracts"
import { toSdkProviderId } from "./sdk-provider-id"

/** Narrow a stored or wire value to an explicit protocol; anything else means Auto. */
export function parseOpenAICompatibleApiProtocol(value: unknown): OpenAICompatibleApiProtocol | undefined {
	return value === "openai-chat" || value === "openai-responses" ? value : undefined
}

/**
 * Only the built-in OpenAI Compatible entry stores its API choice in the
 * providers.json `protocol` key. Custom providers use that key for their own
 * collection protocol, which this setting must never touch.
 */
export function storesOpenAICompatibleApiProtocol(providerId: ProviderId): boolean {
	return toSdkProviderId(providerId) === "openai-compatible"
}

/**
 * The stored API choice as a provider-config fragment, for config built
 * outside the core session path (core merges providers.json itself for the
 * agent loop): commit messages, the Knowledge Vault writer and compaction.
 */
export function resolveOpenAICompatibleApiProtocol(providerId: string): Pick<ProviderConfig, "apiProtocol"> {
	const sdkProviderId = toSdkProviderId(providerId)
	if (sdkProviderId !== "openai-compatible") {
		return {}
	}
	try {
		const apiProtocol = parseOpenAICompatibleApiProtocol(
			getProviderSettingsManager().getProviderSettings(sdkProviderId)?.protocol,
		)
		return apiProtocol ? { apiProtocol } : {}
	} catch {
		Logger.warn("[ApiProtocol] Failed to read the OpenAI Compatible API setting from providers.json")
		return {}
	}
}
