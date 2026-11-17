import { createInterface } from "node:readline";
import {
	BUILT_IN_PROVIDER,
	createOAuthClientCallbacks,
	ensureCustomProvidersLoaded,
	getProviderAuthHandler,
	KNOWLEDGE_VAULT_GOODVISION_PROVIDER_ID,
	loginAndSaveProviderOAuthCredentials,
	type ProviderSettings,
	type ProviderSettingsManager,
	saveProviderOAuthCredentials,
} from "@cline/core";
import { Command } from "commander";
import React from "react";
import { disableOpenTuiGraphicsProbe } from "../tui/opentui-env";
import open from "../utils/open";
import {
	getPersistedProviderApiKey,
	isOAuthProvider,
	normalizeAuthProviderId,
	normalizeProviderId,
	type OAuthCredentials,
	toProviderApiKey,
} from "../utils/provider-auth";
import { listLocalProviders } from "../utils/provider-catalog";
import { identifyTelemetryAccount } from "../utils/telemetry";

export {
	getPersistedProviderApiKey,
	isOAuthProvider,
	normalizeAuthProviderId,
	normalizeProviderId,
	toProviderApiKey,
};
export type { OAuthCredentials };

const c = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	cyan: "\x1b[36m",
	green: "\x1b[32m",
};

type AuthIo = {
	writeln: (text?: string) => void;
	writeErr: (text: string) => void;
};

type AuthQuickSetupInput = {
	provider: string;
	apikey: string;
	modelid: string;
	baseurl?: string;
	azureApiVersion?: string;
	apiProtocol?: string;
};

/** `--api-protocol` values: how the OpenAI-compatible provider talks to its endpoint. */
export const AUTH_API_PROTOCOLS = ["auto", "chat", "responses"] as const;
export type AuthApiProtocol = (typeof AUTH_API_PROTOCOLS)[number];

/**
 * The providers.json `protocol` for an `--api-protocol` value: `undefined`
 * for auto (the key is removed), `null` for an unknown value.
 */
export function resolveAuthApiProtocol(
	value: string,
): "openai-chat" | "openai-responses" | undefined | null {
	switch (value.trim().toLowerCase()) {
		case "auto":
			return undefined;
		case "chat":
		case "openai-chat":
		case "chat-completions":
			return "openai-chat";
		case "responses":
		case "openai-responses":
			return "openai-responses";
		default:
			return null;
	}
}

/** Providers whose base URL `--baseurl` may set. */
const BASE_URL_EDITABLE_PROVIDERS: ReadonlySet<string> = new Set([
	BUILT_IN_PROVIDER.OPENAI_COMPATIBLE,
	BUILT_IN_PROVIDER.OPENAI_NATIVE,
	KNOWLEDGE_VAULT_GOODVISION_PROVIDER_ID,
]);

type AuthCommandInput = {
	providerSettingsManager: ProviderSettingsManager;
	io: AuthIo;
	explicitProvider?: string;
	apikey?: string;
	modelid?: string;
	baseurl?: string;
	azureApiVersion?: string;
	apiProtocol?: string;
};

type ParsedAuthCommandArgs = {
	explicitProvider?: string;
	apikey?: string;
	modelid?: string;
	baseurl?: string;
	azureApiVersion?: string;
	apiProtocol?: string;
	parseError?: string;
};

/**
 * Create the `auth` subcommand for Commander.
 *
 * In the auth context, `-p` means `--provider` and `-m` means `--modelid`,
 * which intentionally shadows the global `-p` (--plan) and `-m` (--model)
 * short flags. Commander scopes options per-command, so there is no conflict.
 */
export function createAuthCommand(): Command {
	const cmd = new Command("auth")
		.description("Authenticate with an LLM provider")
		.exitOverride()
		.configureOutput({ writeOut: () => {}, writeErr: () => {} })
		.argument("[provider]", "provider id (positional shorthand for -p)")
		.option("-p, --provider <id>", "provider id")
		.option("-k, --apikey <key>", "API key")
		.option("-m, --modelid <id>", "model id")
		.option("-b, --baseurl <url>", "base URL")
		.option("--azure-api-version <version>", "Azure API version")
		.option(
			"--api-protocol <protocol>",
			"OpenAI-compatible API: auto, chat (Chat Completions) or responses",
		);
	return cmd;
}

export function parseAuthCommandArgs(args: string[]): ParsedAuthCommandArgs {
	const cmd = createAuthCommand();
	try {
		cmd.parse(args, { from: "user" });
	} catch {
		// Commander throws on --help / --version / unknown flags via exitOverride
		return { parseError: `unknown auth option in: ${args.join(" ")}` };
	}
	const opts = cmd.opts<{
		provider?: string;
		apikey?: string;
		modelid?: string;
		baseurl?: string;
		azureApiVersion?: string;
		apiProtocol?: string;
	}>();
	const positionalProvider = cmd.args[0];
	return {
		explicitProvider: opts.provider ?? positionalProvider,
		apikey: opts.apikey,
		modelid: opts.modelid,
		baseurl: opts.baseurl,
		azureApiVersion: opts.azureApiVersion,
		apiProtocol: opts.apiProtocol,
	};
}

async function loadProviderCatalog(
	providerSettingsManager: ProviderSettingsManager,
): Promise<Array<{ id: string; name: string }>> {
	await ensureCustomProvidersLoaded(providerSettingsManager);
	const catalog = await listLocalProviders(providerSettingsManager);
	return catalog.providers
		.map((provider) => ({
			id: provider.id.trim(),
			name: provider.name.trim() || provider.id.trim(),
		}))
		.filter((provider) => provider.id.length > 0)
		.sort((a, b) => a.id.localeCompare(b.id));
}

async function ensureQuickSetupInputValid(
	input: AuthQuickSetupInput,
	providerSettingsManager: ProviderSettingsManager,
): Promise<string | undefined> {
	const normalizedProvider = normalizeProviderId(input.provider);
	const providerCatalog = await loadProviderCatalog(providerSettingsManager);
	if (!providerCatalog.some((provider) => provider.id === normalizedProvider)) {
		return `invalid provider "${input.provider}"`;
	}
	if (!input.apikey.trim()) {
		return "auth quick setup requires --apikey <key>";
	}
	if (!input.modelid.trim()) {
		return "auth quick setup requires --modelid <id>";
	}
	if (
		input.baseurl?.trim() &&
		!BASE_URL_EDITABLE_PROVIDERS.has(normalizedProvider)
	) {
		return "base URL is only supported for OpenAI, OpenAI-compatible and GoodVision providers";
	}
	const apiProtocolError = validateApiProtocolInput(
		normalizedProvider,
		input.apiProtocol,
	);
	if (apiProtocolError) {
		return apiProtocolError;
	}
	if (
		input.azureApiVersion?.trim() &&
		normalizedProvider !== BUILT_IN_PROVIDER.OPENAI_COMPATIBLE
	) {
		return "Azure API version is only supported for OpenAI-compatible providers";
	}
	return undefined;
}

function validateApiProtocolInput(
	providerId: string,
	apiProtocol: string | undefined,
): string | undefined {
	if (apiProtocol === undefined) {
		return undefined;
	}
	if (providerId !== BUILT_IN_PROVIDER.OPENAI_COMPATIBLE) {
		return "API protocol is only supported for the OpenAI-compatible provider";
	}
	if (resolveAuthApiProtocol(apiProtocol) === null) {
		return `invalid API protocol "${apiProtocol}" (expected ${AUTH_API_PROTOCOLS.join(", ")})`;
	}
	return undefined;
}

function applyApiProtocol(
	settings: ProviderSettings,
	apiProtocol: string | undefined,
): void {
	if (apiProtocol === undefined) {
		return;
	}
	const protocol = resolveAuthApiProtocol(apiProtocol);
	if (protocol) {
		settings.protocol = protocol;
	} else {
		delete settings.protocol;
	}
}

/**
 * `cline auth openai-compatible --api-protocol <p>` without key/model flags:
 * switch the protocol of the configured provider, keeping everything else.
 */
async function runApiProtocolUpdate(input: AuthCommandInput): Promise<number> {
	const providerId = normalizeProviderId((input.explicitProvider ?? "").trim());
	const validationError = validateApiProtocolInput(
		providerId,
		input.apiProtocol,
	);
	if (validationError) {
		input.io.writeErr(validationError);
		return 1;
	}
	const existing =
		input.providerSettingsManager.getProviderSettings(providerId);
	if (!existing) {
		input.io.writeErr(
			`provider "${providerId}" is not configured yet (use: auth --provider ${providerId} --apikey <key> --modelid <id> --api-protocol ${input.apiProtocol})`,
		);
		return 1;
	}
	const next: ProviderSettings = { ...existing };
	applyApiProtocol(next, input.apiProtocol);
	input.providerSettingsManager.saveProviderSettings(next);
	input.io.writeln(
		`${c.green}API protocol set:${c.reset} ${c.cyan}${providerId}${c.reset} (${formatApiProtocol(next.protocol)})`,
	);
	return 0;
}

function formatApiProtocol(protocol: ProviderSettings["protocol"]): string {
	switch (protocol) {
		case "openai-chat":
			return "Chat Completions";
		case "openai-responses":
			return "Responses";
		default:
			return "auto";
	}
}

function saveQuickAuthProviderSettings(input: {
	providerSettingsManager: ProviderSettingsManager;
	providerId: string;
	apikey: string;
	modelid: string;
	baseurl?: string;
	azureApiVersion?: string;
	apiProtocol?: string;
}): void {
	const existing = input.providerSettingsManager.getProviderSettings(
		input.providerId,
	);
	const nextSettings: ProviderSettings = {
		...(existing ?? {
			provider: input.providerId as ProviderSettings["provider"],
		}),
		provider: input.providerId as ProviderSettings["provider"],
		apiKey: input.apikey,
		model: input.modelid,
	};
	if (input.baseurl?.trim()) {
		nextSettings.baseUrl = input.baseurl.trim();
	}
	if (input.azureApiVersion?.trim()) {
		nextSettings.azure = {
			...(nextSettings.azure ?? {}),
			apiVersion: input.azureApiVersion.trim(),
		};
	}
	applyApiProtocol(nextSettings, input.apiProtocol);
	input.providerSettingsManager.saveProviderSettings(nextSettings);
}

async function askForInputInTerminal(question: string): Promise<string> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error("OAuth login requires an interactive terminal session");
	}

	return new Promise<string>((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${question} `, (value) => {
			rl.close();
			resolve(value);
		});
	});
}

function createOAuthCallbacks(io: AuthIo): {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onPrompt: (prompt: {
		message: string;
		defaultValue?: string;
	}) => Promise<string>;
} {
	return createOAuthClientCallbacks({
		onPrompt: ({ message, defaultValue }) =>
			askForInputInTerminal(message).then((value) => {
				const trimmed = value.trim();
				return trimmed || defaultValue || "";
			}),
		onOutput: (message) => {
			io.writeln(`${c.dim}[auth] ${message}${c.reset}`);
		},
		openUrl: (url) => open(url, { wait: false }).then(() => undefined),
		onOpenUrlError: ({ error }) => {
			io.writeln(
				`${c.dim}[auth] Could not open browser automatically; open the URL above manually.${c.reset}`,
			);
			io.writeln(
				`${c.dim}[auth] Browser open failed: ${error instanceof Error ? error.message : String(error)}${c.reset}`,
			);
		},
	});
}

export function saveOAuthProviderSettings(
	providerSettingsManager: ProviderSettingsManager,
	providerId: string,
	existing: ProviderSettings | undefined,
	credentials: OAuthCredentials,
): ProviderSettings {
	return saveProviderOAuthCredentials({
		manager: providerSettingsManager,
		providerId,
		settings: existing,
		credentials,
	});
}

export async function ensureOAuthProviderApiKey(input: {
	providerId: string;
	currentApiKey?: string;
	existingSettings?: ProviderSettings;
	providerSettingsManager: ProviderSettingsManager;
	io: AuthIo;
}): Promise<{
	apiKey?: string;
	selectedProviderSettings?: ProviderSettings;
}> {
	if (input.currentApiKey || !isOAuthProvider(input.providerId)) {
		return {
			apiKey: input.currentApiKey,
			selectedProviderSettings: input.existingSettings,
		};
	}
	const selectedProviderSettings = await loginAndSaveProviderOAuthCredentials(
		input.providerSettingsManager,
		input.providerId,
		{ callbacks: createOAuthCallbacks(input.io) },
	);
	const handler = getProviderAuthHandler(input.providerId);
	return {
		apiKey: handler?.getApiKey(selectedProviderSettings),
		selectedProviderSettings,
	};
}

async function runQuickAuthSetup(input: AuthCommandInput): Promise<number> {
	const providerId = normalizeProviderId((input.explicitProvider ?? "").trim());
	const apikey = input.apikey?.trim() ?? "";
	const modelid = input.modelid?.trim() ?? "";
	const baseurl = input.baseurl?.trim();
	const azureApiVersion = input.azureApiVersion?.trim();
	const apiProtocol = input.apiProtocol?.trim();
	const validationError = await ensureQuickSetupInputValid(
		{
			provider: providerId,
			apikey,
			modelid,
			baseurl,
			azureApiVersion,
			apiProtocol,
		},
		input.providerSettingsManager,
	);
	if (validationError) {
		input.io.writeErr(validationError);
		return 1;
	}
	saveQuickAuthProviderSettings({
		providerSettingsManager: input.providerSettingsManager,
		providerId,
		apikey,
		modelid,
		baseurl,
		azureApiVersion,
		apiProtocol,
	});
	input.io.writeln(
		`${c.green}Provider configured:${c.reset} ${c.cyan}${providerId}${c.reset} (${modelid})`,
	);
	return 0;
}

export async function loadAuthTuiRuntime() {
	disableOpenTuiGraphicsProbe();
	const { createCliRenderer } = await import("@opentui/core");
	const { createRoot } = await import("@opentui/react");
	const { OnboardingView } = await import("../tui/views/onboarding");
	return { createCliRenderer, createRoot, OnboardingView };
}

async function runInteractiveAuthTui(input: AuthCommandInput): Promise<number> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		input.io.writeErr(
			"interactive auth setup requires a TTY (use --provider/--apikey/--modelid for non-interactive setup)",
		);
		return 1;
	}
	const { createCliRenderer, createRoot, OnboardingView } =
		await loadAuthTuiRuntime();
	const renderer = await createCliRenderer({
		exitOnCtrlC: false,
		autoFocus: false,
		enableMouseMovement: true,
	});

	return await new Promise<number>((resolve, reject) => {
		let root: ReturnType<typeof createRoot>;
		try {
			root = createRoot(renderer);
		} catch (error) {
			renderer.destroy();
			reject(error);
			return;
		}
		let settled = false;
		let unmounted = false;
		const unmountRoot = () => {
			if (unmounted) {
				return;
			}
			unmounted = true;
			root.unmount();
		};
		const settle = (code: number) => {
			if (settled) {
				return;
			}
			settled = true;
			unmountRoot();
			renderer.destroy();
			resolve(code);
		};
		renderer.on("destroy", () => {
			unmountRoot();
			if (!settled) {
				settled = true;
				resolve(1);
			}
		});
		try {
			root.render(
				React.createElement(OnboardingView, {
					providerSettingsManager: input.providerSettingsManager,
					onComplete: () => settle(0),
					onExit: () => settle(1),
				}),
			);
		} catch (error) {
			unmountRoot();
			renderer.destroy();
			reject(error);
		}
	});
}

export async function runAuthCommand(input: AuthCommandInput): Promise<number> {
	const hasQuickSetupFlags =
		typeof input.apikey === "string" ||
		typeof input.modelid === "string" ||
		typeof input.baseurl === "string" ||
		typeof input.azureApiVersion === "string";

	if (hasQuickSetupFlags) {
		if (!input.explicitProvider?.trim()) {
			input.io.writeErr(
				"auth quick setup requires --provider <id> when using --apikey/--modelid/--baseurl/--azure-api-version/--api-protocol",
			);
			return 1;
		}
		return runQuickAuthSetup(input);
	}

	if (typeof input.apiProtocol === "string") {
		if (!input.explicitProvider?.trim()) {
			input.io.writeErr(
				"auth --api-protocol requires --provider openai-compatible",
			);
			return 1;
		}
		return runApiProtocolUpdate(input);
	}

	if (input.explicitProvider?.trim()) {
		const providerId = normalizeAuthProviderId(input.explicitProvider);
		if (isOAuthProvider(providerId)) {
			return runAuthProviderCommand(
				input.providerSettingsManager,
				providerId,
				input.io,
			);
		}
		input.io.writeErr(
			`provider "${providerId}" requires API key setup (use subcommand: auth --provider ${providerId} --apikey <key> --modelid <id>)`,
		);
		return 1;
	}

	return runInteractiveAuthTui(input);
}

export async function runAuthProviderCommand(
	providerSettingsManager: ProviderSettingsManager,
	providerId: string,
	io: AuthIo,
): Promise<number> {
	if (!isOAuthProvider(providerId)) {
		io.writeErr(
			`provider "${providerId}" does not support OAuth login (supported: cline, openai-codex, oca)`,
		);
		return 1;
	}
	try {
		const settings = await loginAndSaveProviderOAuthCredentials(
			providerSettingsManager,
			providerId,
			{ callbacks: createOAuthCallbacks(io) },
		);
		identifyTelemetryAccount({
			id: settings.auth?.accountId,
			provider: providerId,
		});
		io.writeln(
			`${c.green}You are now logged in to ${c.cyan}${providerId}${c.reset}`,
		);
		return 0;
	} catch (error) {
		io.writeErr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
