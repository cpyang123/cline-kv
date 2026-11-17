import {
	getProviderAuthStorageId,
	type ProviderSettingsManager,
	saveLocalProviderSettings,
} from "@cline/core";
import {
	type DialogDismissKey,
	isAnyKeyDismiss,
} from "../../utils/dialog-keys";

const CLINE_PASS_SUBSCRIPTION_PATH = "/dashboard/subscription";
const DEFAULT_APP_BASE_URL = "https://app.cline.bot";

/**
 * Persist a manually entered API key for an OAuth-capable provider — the
 * escape hatch for when OAuth login isn't working. Any stored OAuth tokens
 * are cleared: the auth handler prefers auth.accessToken over apiKey, so a
 * stale token would otherwise keep winning over the manual key.
 *
 * The key is written both to the provider's auth storage entry (cline-pass
 * stores credentials under "cline") and to the provider's own entry: settings
 * resolution lets a direct entry shadow the storage entry, and provider
 * switching copies merged settings (including auth) into direct entries, so
 * both must be updated for the manual key to reliably take effect.
 */
export async function saveManualProviderApiKey(
	manager: ProviderSettingsManager,
	providerId: string,
	apiKey: string,
): Promise<void> {
	// Empty strings delete these keys from the stored auth object.
	const clearedAuth = { accessToken: "", refreshToken: "", apiKey: "" };
	const storageProviderId = getProviderAuthStorageId(providerId) ?? providerId;
	await saveLocalProviderSettings(manager, {
		providerId: storageProviderId,
		apiKey,
		auth: clearedAuth,
	});
	if (
		providerId !== storageProviderId &&
		manager.read().providers[providerId]
	) {
		await saveLocalProviderSettings(manager, {
			providerId,
			apiKey,
			auth: clearedAuth,
		});
	}
}

/**
 * Key handling for the OAuth waiting screens: `K` switches to manual API key
 * entry when that fallback is available; any other (unmodified) key cancels
 * the pending auth attempt; modifier-held keys are ignored.
 *
 * Like the ClinePass promo dialog, this screen must never depend on Esc
 * alone: it is non-interactive, it may be waiting on a browser flow that
 * never completes, and Esc is the least reliably delivered key across
 * terminals (notably on Windows, where console input layers can swallow it).
 * Modifier-held keys are ignored so that holding Cmd/Ctrl to click the
 * auth/verification link never cancels the flow mid-click.
 */
export function resolveOAuthWaitKeyAction(
	key: DialogDismissKey,
	allowApiKeyFallback: boolean | undefined,
): "use_api_key" | "cancel" | "ignore" {
	if (!isAnyKeyDismiss(key)) return "ignore";
	return allowApiKeyFallback && key.name === "k" ? "use_api_key" : "cancel";
}

export function buildClinePassSubscriptionPageUrl(
	appBaseUrl: string | undefined,
): string {
	const url = new URL(
		CLINE_PASS_SUBSCRIPTION_PATH,
		appBaseUrl || DEFAULT_APP_BASE_URL,
	);
	url.searchParams.set("personal", "true");
	return url.toString();
}

/** OpenAI-compatible API protocol as stored in providers.json (`undefined` = Auto). */
export type ProviderApiProtocol =
	| "openai-chat"
	| "openai-responses"
	| undefined;

const API_PROTOCOL_OPTIONS: ReadonlyArray<{
	value: ProviderApiProtocol;
	label: string;
}> = [
	{ value: undefined, label: "Auto" },
	{ value: "openai-chat", label: "Chat Completions" },
	{ value: "openai-responses", label: "Responses API" },
];

/** Only the OpenAI-compatible provider reads the `protocol` setting. */
export function supportsApiProtocolSetting(providerId: string): boolean {
	return providerId === "openai-compatible";
}

export function normalizeProviderApiProtocol(
	value: unknown,
): ProviderApiProtocol {
	return value === "openai-chat" || value === "openai-responses"
		? value
		: undefined;
}

export function cycleProviderApiProtocol(
	current: ProviderApiProtocol,
	direction: 1 | -1 = 1,
): ProviderApiProtocol {
	const index = API_PROTOCOL_OPTIONS.findIndex(
		(option) => option.value === current,
	);
	const next =
		(Math.max(0, index) + direction + API_PROTOCOL_OPTIONS.length) %
		API_PROTOCOL_OPTIONS.length;
	return API_PROTOCOL_OPTIONS[next]?.value;
}

export function formatProviderApiProtocol(
	protocol: ProviderApiProtocol,
): string {
	return (
		API_PROTOCOL_OPTIONS.find((option) => option.value === protocol)?.label ??
		"Auto"
	);
}
