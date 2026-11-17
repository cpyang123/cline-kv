import { createGateway } from "@ai-sdk/gateway";
import type { OpenAIProvider } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type {
	LanguageModelV4,
	LanguageModelV4Middleware,
} from "@ai-sdk/provider";
import type {
	GatewayProviderContext,
	GatewayResolvedProviderConfig,
} from "@cline/shared";
import { modelProducesImages } from "@cline/shared";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { wrapLanguageModel } from "ai";
import type { OpenAICompatibleApiProtocol } from "../config";
import { ensureFetch, resolveApiKey } from "../http";
import { createAdaptiveToolTransportMiddleware } from "../middleware/adaptive-tool-transport";
import { promptToolsMiddleware } from "../middleware/prompt-tools";
import { splitToolImagesMiddleware } from "../middleware/split-tool-images";
import { createStreamTimeLimitMiddleware } from "../middleware/stream-time-limit";
import {
	isOpenAIChatVariantModelId,
	isOpenAIReasoningEraModelId,
} from "../model-facts";
import { createReasoningToolsFallbackFetch } from "./reasoning-tools-fallback";
import {
	createResponsesRouteCheckFetch,
	createResponsesRouterModel,
	ProviderNoticeQueue,
	protocolDecisionKey,
	reasoningDisabledForToolsNotice,
	stripResponsesReasoningMiddleware,
} from "./responses-router";
import type { ProviderFactoryResult } from "./types";

type FetchInput = Parameters<typeof fetch>[0];
type FetchWithOptionalPreconnect = typeof fetch & {
	preconnect?: (...args: unknown[]) => unknown;
};

function trimTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value.charCodeAt(end - 1) === 47) {
		end -= 1;
	}
	return value.slice(0, end);
}

function readAzureApiVersion(
	config: GatewayResolvedProviderConfig,
): string | undefined {
	const apiVersion = config.options?.apiVersion;
	if (typeof apiVersion !== "string") {
		return undefined;
	}
	const trimmed = apiVersion.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function shouldAddAzureApiVersion(url: URL): boolean {
	return (
		url.pathname.startsWith("/openai/deployments/") &&
		!url.searchParams.has("api-version")
	);
}

function withAzureApiVersion(
	input: FetchInput,
	apiVersion: string,
): FetchInput {
	let url: URL;
	try {
		url = new URL(input instanceof Request ? input.url : input.toString());
	} catch {
		return input;
	}
	if (!shouldAddAzureApiVersion(url)) {
		return input;
	}
	url.searchParams.set("api-version", apiVersion);
	if (input instanceof Request) {
		return new Request(url.toString(), input);
	}
	return (typeof input === "string" ? url.toString() : url) as FetchInput;
}

function createAzureApiVersionFetch(
	config: GatewayResolvedProviderConfig,
): typeof fetch | undefined {
	const apiVersion = readAzureApiVersion(config);
	if (!apiVersion) {
		return config.fetch;
	}
	const baseFetch = config.fetch ?? globalThis.fetch;
	if (!baseFetch) {
		return config.fetch;
	}
	const azureFetch = ((input, init) =>
		baseFetch(withAzureApiVersion(input, apiVersion), init)) as typeof fetch;
	const baseFetchWithPreconnect = baseFetch as FetchWithOptionalPreconnect;
	(azureFetch as FetchWithOptionalPreconnect).preconnect =
		typeof baseFetchWithPreconnect.preconnect === "function"
			? baseFetchWithPreconnect.preconnect.bind(baseFetch)
			: () => undefined;
	return azureFetch;
}

type ResponseErrorHandler = (response: Response) => Promise<void> | void;

export interface UpstreamRetryPolicy {
	attempts: number;
	baseDelayMs: number;
	maxDelayMs?: number;
}

const UPSTREAM_RETRY_STATUSES = new Set([502, 503, 504]);

function readUpstreamRetryPolicy(
	metadata: Record<string, unknown> | undefined,
): UpstreamRetryPolicy | undefined {
	const policy = metadata?.upstreamRetry as
		| Partial<UpstreamRetryPolicy>
		| undefined;
	if (
		!policy ||
		typeof policy.attempts !== "number" ||
		policy.attempts < 2 ||
		typeof policy.baseDelayMs !== "number"
	) {
		return undefined;
	}
	return {
		attempts: policy.attempts,
		baseDelayMs: policy.baseDelayMs,
		...(typeof policy.maxDelayMs === "number"
			? { maxDelayMs: policy.maxDelayMs }
			: {}),
	};
}

function isReplayableBody(body: unknown): boolean {
	return body === undefined || body === null || typeof body === "string";
}

function abortableDelay(
	ms: number,
	signal: AbortSignal | null | undefined,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new Error("aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Retry 502/503/504 responses with exponential backoff. Only requests whose
 * body can be re-sent (a string or none) are retried, the abort signal cuts the
 * wait short, and the last response is returned when attempts run out so the
 * caller's own error handling sees the real status.
 */
export function createUpstreamRetryFetch(
	baseFetch: typeof fetch,
	policy: UpstreamRetryPolicy,
	sleep: (
		ms: number,
		signal: AbortSignal | null | undefined,
	) => Promise<void> = abortableDelay,
): typeof fetch {
	const retryFetch = (async (input, init) => {
		const signal = (init?.signal ??
			(input instanceof Request ? input.signal : undefined)) as
			| AbortSignal
			| null
			| undefined;
		let response = await baseFetch(input, init);
		if (
			!isReplayableBody(init?.body) ||
			(input instanceof Request && init?.body === undefined && input.body)
		) {
			return response;
		}
		for (
			let attempt = 1;
			attempt < policy.attempts && UPSTREAM_RETRY_STATUSES.has(response.status);
			attempt += 1
		) {
			if (signal?.aborted) {
				return response;
			}
			const delay = Math.min(
				policy.baseDelayMs * 2 ** (attempt - 1),
				policy.maxDelayMs ?? Number.POSITIVE_INFINITY,
			);
			try {
				await sleep(delay, signal);
			} catch {
				return response;
			}
			response = await baseFetch(input, init);
		}
		return response;
	}) as typeof fetch;
	const baseFetchWithPreconnect = baseFetch as FetchWithOptionalPreconnect;
	(retryFetch as FetchWithOptionalPreconnect).preconnect =
		typeof baseFetchWithPreconnect.preconnect === "function"
			? baseFetchWithPreconnect.preconnect.bind(baseFetch)
			: () => undefined;
	return retryFetch;
}

function resolveVercelGatewayImageBaseUrl(
	baseUrl: string | undefined,
): string | undefined {
	if (!baseUrl) return undefined;
	try {
		const url = new URL(baseUrl);
		if (
			url.hostname === "ai-gateway.vercel.sh" &&
			trimTrailingSlashes(url.pathname) === "/v1"
		) {
			// The provider's generic OpenAI-compatible endpoint is not the AI SDK
			// Gateway endpoint. Let @ai-sdk/gateway select its current versioned
			// `/ai` base instead of producing `/v1/image-model`.
			return undefined;
		}
		return trimTrailingSlashes(url.toString());
	} catch {
		return baseUrl;
	}
}

function readResponseErrorHandler(
	config: GatewayResolvedProviderConfig,
): ResponseErrorHandler | undefined {
	const handler = config.options?.onResponseError;
	return typeof handler === "function"
		? (handler as ResponseErrorHandler)
		: undefined;
}

function createResponseErrorFetch(input: {
	fetch: typeof fetch;
	onResponseError: ResponseErrorHandler;
}): typeof fetch {
	const responseErrorFetch = (async (requestInput, init) => {
		const response = await input.fetch(requestInput, init);

		await input.onResponseError(response);

		return response;
	}) as typeof fetch;

	const baseFetchWithPreconnect = input.fetch as FetchWithOptionalPreconnect;
	(responseErrorFetch as FetchWithOptionalPreconnect).preconnect =
		typeof baseFetchWithPreconnect.preconnect === "function"
			? baseFetchWithPreconnect.preconnect.bind(input.fetch)
			: () => undefined;
	return responseErrorFetch;
}

/**
 * OpenAI's chat-completions API rejects `max_tokens` for reasoning-era
 * models ("Unsupported parameter: 'max_tokens' is not supported with this
 * model. Use 'max_completion_tokens' instead."). Rename the parameter only
 * for model ids that require it: OpenAI, Azure OpenAI, and the major
 * OpenAI-compatible gateways (OpenRouter, LiteLLM) all accept
 * `max_completion_tokens`, while older third-party servers that only know
 * `max_tokens` do not serve o-series/gpt-5 model ids — so every other
 * request keeps its exact current wire format.
 */
export function withMaxCompletionTokensForReasoningModels(
	body: Record<string, unknown>,
): Record<string, unknown> {
	const { max_tokens: maxTokens, ...rest } = body;
	if (
		maxTokens == null ||
		typeof body.model !== "string" ||
		!isOpenAIReasoningEraModelId(body.model)
	) {
		return body;
	}
	return {
		...rest,
		// Keep an explicit `max_completion_tokens` passed via provider
		// options passthrough if one is already present.
		max_completion_tokens: rest.max_completion_tokens ?? maxTokens,
	};
}

function isOpenRouterImageGenerationRequest(input: FetchInput): boolean {
	try {
		const url = new URL(
			input instanceof Request ? input.url : input.toString(),
		);
		return trimTrailingSlashes(url.pathname).endsWith("/images");
	} catch {
		return false;
	}
}

export function createSuccessDataResponseFetch(
	baseFetch: typeof fetch,
): typeof fetch {
	const responseEnvelopeFetch = (async (requestInput, init) => {
		const response = await baseFetch(requestInput, init);
		if (!response.ok || !isOpenRouterImageGenerationRequest(requestInput)) {
			return response;
		}

		const text = await response.text();
		let unwrapped = text;
		try {
			const payload = JSON.parse(text) as unknown;
			if (
				payload &&
				typeof payload === "object" &&
				!Array.isArray(payload) &&
				"success" in payload &&
				payload.success === true &&
				"data" in payload
			) {
				unwrapped = JSON.stringify(payload.data);
			}
		} catch {
			// Recreate the original response below so consuming it for envelope
			// detection never changes provider behavior.
		}

		const headers = new Headers(response.headers);
		headers.delete("content-encoding");
		headers.delete("content-length");
		return new Response(unwrapped, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}) as typeof fetch;

	const baseFetchWithPreconnect = baseFetch as FetchWithOptionalPreconnect;
	(responseEnvelopeFetch as FetchWithOptionalPreconnect).preconnect =
		typeof baseFetchWithPreconnect.preconnect === "function"
			? baseFetchWithPreconnect.preconnect.bind(baseFetch)
			: () => undefined;
	return responseEnvelopeFetch;
}

/**
 * What an adaptive tool-transport decision is remembered under: the session
 * (its `X-Task-ID` request header, set by the session factory), else the
 * endpoint itself for standalone handlers without a session.
 */
function toolTransportKey(context: GatewayProviderContext): string {
	const headers = context.config.headers ?? {};
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() === "x-task-id" && value?.trim()) {
			return `session:${value.trim()}`;
		}
	}
	return `endpoint:${context.provider.id}|${context.config.baseUrl ?? ""}`;
}

/** Where the built-in OpenAI Compatible provider points when no base URL is set. */
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Hosts known to serve OpenAI models through `<base URL>/responses`. */
const OPENAI_RESPONSES_HOST_SUFFIXES = [
	".openai.azure.com",
	".cognitiveservices.azure.com",
	".services.ai.azure.com",
];

/**
 * Whether automatic protocol selection may use the Responses API for this
 * base URL: OpenAI and Azure OpenAI hosts, except Azure's legacy
 * `/openai/deployments/<name>` base URLs, which have no `/responses` route
 * under them.
 */
function isOpenAIResponsesEndpoint(baseUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		return false;
	}
	const host = url.hostname.toLowerCase();
	return (
		(host === "api.openai.com" ||
			OPENAI_RESPONSES_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) &&
		!url.pathname.toLowerCase().includes("/openai/deployments/")
	);
}

/** An Azure legacy deployment base URL (`.../openai/deployments/<name>`). */
function isAzureDeploymentUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	try {
		return new URL(baseUrl).pathname
			.toLowerCase()
			.includes("/openai/deployments/");
	} catch {
		return false;
	}
}

function readApiProtocol(
	config: GatewayResolvedProviderConfig,
): OpenAICompatibleApiProtocol | undefined {
	const value = config.options?.apiProtocol;
	return value === "openai-chat" || value === "openai-responses"
		? value
		: undefined;
}

function endpointHostOf(baseUrl: string | undefined): string {
	if (baseUrl) {
		try {
			return new URL(baseUrl).host;
		} catch {
			// Fall through to the generic wording.
		}
	}
	return "the endpoint";
}

/**
 * `@ai-sdk/openai` keys its provider options and reasoning metadata on
 * `azure` when the provider name contains "azure", on `openai` otherwise.
 * Cline writes the `openai` bucket, so keep "azure" out of the name.
 */
function responsesProviderName(providerId: string): string {
	return providerId.toLowerCase().includes("azure")
		? "openai-compatible"
		: providerId;
}

export async function createOpenAICompatibleProviderModule(
	config: GatewayResolvedProviderConfig,
	context: GatewayProviderContext,
): Promise<ProviderFactoryResult> {
	// Don't preflight-check for a missing API key. If credentials are
	// missing or wrong, the provider's own response (e.g. 401) is the
	// authoritative error and is surfaced to the user as-is. This keeps
	// `llms` unopinionated about which providers do or don't need a key.
	const apiKey = await resolveApiKey(config);
	const notices = new ProviderNoticeQueue();
	// Only providers that declare it route between the Responses API and
	// Chat Completions; every other provider stays on Chat Completions.
	const routesResponses = context.provider.metadata?.openaiResponses === "auto";
	const apiProtocolSetting = routesResponses
		? readApiProtocol(config)
		: undefined;
	const apiProtocol = apiProtocolSetting ?? "auto";
	const baseUrl =
		config.baseUrl ?? (routesResponses ? DEFAULT_OPENAI_BASE_URL : undefined);
	const endpointHost = endpointHostOf(baseUrl);
	const fetch = createAzureApiVersionFetch(config);
	const onResponseError = readResponseErrorHandler(config);
	const upstreamRetry = readUpstreamRetryPolicy(context.provider.metadata);
	const retryingFetch = upstreamRetry
		? createUpstreamRetryFetch(ensureFetch(fetch), upstreamRetry)
		: fetch;
	// Models that refuse function tools with a reasoning effort on Chat
	// Completions (GPT-6 Luna) get the request re-sent with effort "none".
	const reasoningFallbackFetch = createReasoningToolsFallbackFetch(
		ensureFetch(retryingFetch),
		{
			onApplied: ({ model, requestedEffort, remembered }) => {
				notices.push(
					reasoningDisabledForToolsNotice({
						modelId: model,
						endpointHost,
						...(routesResponses ? { apiProtocol } : {}),
					}),
				);
				if (!remembered) {
					context.logger?.log(
						`[${context.provider.id}] ${model} refuses function tools with reasoning on chat completions (requested effort: ${requestedEffort}); sending its tool requests with reasoning_effort "none"`,
					);
				}
			},
		},
	);
	const providerFetch = onResponseError
		? createResponseErrorFetch({
				fetch: reasoningFallbackFetch,
				onResponseError,
			})
		: reasoningFallbackFetch;
	const provider = createOpenAICompatible({
		name: context.provider.id,
		apiKey,
		...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
		...(config.headers ? { headers: config.headers } : {}),
		...(providerFetch ? { fetch: providerFetch } : {}),
		includeUsage: true,
		transformRequestBody: withMaxCompletionTokensForReasoningModels,
	} as never);
	const useOpenRouterImageTransport =
		context.provider.metadata?.imageTransport === "openrouter" &&
		modelProducesImages(context.model);
	const openRouterFetch =
		context.provider.metadata?.responseEnvelope === "success-data"
			? createSuccessDataResponseFetch(ensureFetch(providerFetch))
			: providerFetch;
	const openRouterImageProvider = useOpenRouterImageTransport
		? createOpenRouter({
				apiKey,
				baseURL: config.baseUrl,
				headers: config.headers,
				fetch: openRouterFetch,
				compatibility:
					context.provider.id === "openrouter" ? "strict" : "compatible",
			})
		: undefined;
	const vercelGateway =
		context.provider.id === "vercel-ai-gateway"
			? createGateway({
					apiKey,
					baseURL: resolveVercelGatewayImageBaseUrl(config.baseUrl),
					headers: config.headers,
					fetch: providerFetch,
				})
			: undefined;
	const toolTransport = context.provider.metadata?.toolTransport;
	const streamTimeLimitMs = context.provider.metadata?.streamTimeLimitMs;
	// Innermost: sees the raw provider stream, so the tool-transport layers
	// above it receive a well-formed stream with a `length` finish at the cut.
	const streamTimeLimit =
		typeof streamTimeLimitMs === "number" && streamTimeLimitMs > 0
			? [
					createStreamTimeLimitMiddleware({
						limitMs: streamTimeLimitMs,
						onCut: ({ elapsedMs, limitMs }) =>
							context.logger?.log(
								`[${context.provider.id}] stream ended at ${Math.round(elapsedMs / 1000)}s by the client (provider closes streams at ~${Math.round(limitMs / 1000)}s); the turn continues as an output-limit cut`,
							),
					}),
				]
			: [];
	// A session that moved off the Responses API still carries its reasoning
	// items, which Chat Completions must not replay as `reasoning_content`.
	const chatHistoryMiddleware: LanguageModelV4Middleware[] = routesResponses
		? [stripResponsesReasoningMiddleware]
		: [];
	// Wrap each constructed model with `splitToolImagesMiddleware` so
	// `role:"tool"` messages whose `output.type === 'content'` carries
	// image-data parts get split into a placeholder text + a synthetic
	// `role:"user"` message carrying the images. The OpenAI Chat
	// Completions wire format does NOT support multimodal tool messages
	// (the `@ai-sdk/openai-compatible` chat-messages converter
	// `JSON.stringify`s the parts array, losing image bytes). The
	// middleware operates on the typed `LanguageModelV4Prompt` BEFORE
	// the converter runs, so the converter sees only text-only tool
	// messages with adjacent multimodal user messages — the wire
	// pattern that classic Cline used in production for years (see
	// `convertToOpenAiMessages` in `src/core/api/transform/openai-format.ts`
	// on origin/main).
	const chatModel = (modelId: string): LanguageModelV4 =>
		wrapLanguageModel({
			model: (openRouterImageProvider?.chat(modelId) ??
				provider(modelId)) as LanguageModelV4,
			// `toolTransport: "prompt"` endpoints refuse native tool
			// definitions: tools are emulated through the prompt first,
			// so no tool messages remain for the image split to handle.
			// `"auto"` endpoints may or may not accept them (GoodVision,
			// depending on the key's routing policy): the session's first
			// tool-bearing request decides, see adaptive-tool-transport.ts.
			middleware:
				toolTransport === "prompt"
					? [
							promptToolsMiddleware,
							splitToolImagesMiddleware,
							...streamTimeLimit,
							...chatHistoryMiddleware,
						]
					: toolTransport === "auto"
						? [
								createAdaptiveToolTransportMiddleware({
									key: toolTransportKey(context),
									onDecision: (decision) =>
										context.logger?.log(
											`[${context.provider.id}] tool transport: ${decision.transport} (${decision.reason})`,
										),
								}),
								splitToolImagesMiddleware,
								...streamTimeLimit,
								...chatHistoryMiddleware,
							]
						: [
								splitToolImagesMiddleware,
								...streamTimeLimit,
								...chatHistoryMiddleware,
							],
		}) as LanguageModelV4;
	const responsesProvider = await createResponsesProvider({
		routesResponses,
		apiProtocol,
		apiKey,
		baseUrl,
		config,
		context,
		// Transports that only exist for Chat Completions keep it.
		chatOnly:
			toolTransport !== undefined ||
			streamTimeLimit.length > 0 ||
			useOpenRouterImageTransport,
		fetch: retryingFetch,
		onResponseError,
	});
	return {
		operations: {
			language: (modelId) => {
				const chat = chatModel(modelId);
				if (
					!responsesProvider ||
					(apiProtocol === "auto" &&
						(!isOpenAIReasoningEraModelId(modelId) ||
							// gpt-5-chat and similar are not reasoning models.
							isOpenAIChatVariantModelId(modelId)))
				) {
					return chat;
				}
				return createResponsesRouterModel({
					chat,
					responses: responsesProvider.responses(modelId) as LanguageModelV4,
					// Per mode: a fallback remembered under Auto must not stop an
					// explicit Responses choice from trying /responses again.
					memoryKey: `${protocolDecisionKey(
						baseUrl ?? DEFAULT_OPENAI_BASE_URL,
						modelId,
					)}|${apiProtocol}`,
					modelId,
					endpointHost,
					apiProtocol:
						apiProtocol === "openai-responses" ? apiProtocol : "auto",
					azureDeploymentUrl: isAzureDeploymentUrl(baseUrl),
					notices,
					logger: context.logger,
					label: context.provider.id,
				});
			},
			imageGeneration: (modelId) =>
				vercelGateway
					? vercelGateway.imageModel(modelId)
					: openRouterImageProvider
						? openRouterImageProvider.imageModel(modelId)
						: provider.imageModel(modelId),
		},
		takeNotices: () => notices.take(),
	};
}

/**
 * The Responses API provider for a module whose requests may use it, else
 * undefined (the module serves Chat Completions only). Per-model selection
 * happens in `language`.
 */
async function createResponsesProvider(input: {
	routesResponses: boolean;
	apiProtocol: "auto" | OpenAICompatibleApiProtocol;
	apiKey: string | undefined;
	baseUrl: string | undefined;
	config: GatewayResolvedProviderConfig;
	context: GatewayProviderContext;
	chatOnly: boolean;
	/** The vendor's fetch chain below the Chat Completions reasoning fallback. */
	fetch: typeof fetch | undefined;
	onResponseError: ResponseErrorHandler | undefined;
}): Promise<OpenAIProvider | undefined> {
	const { apiProtocol, apiKey, config, onResponseError } = input;
	const baseUrl = input.baseUrl ?? DEFAULT_OPENAI_BASE_URL;
	if (
		!input.routesResponses ||
		input.chatOnly ||
		apiProtocol === "openai-chat" ||
		// Automatic selection only for OpenAI's own hosts with a key: a
		// keyless endpoint is a self-hosted server, which speaks chat.
		(apiProtocol === "auto" && (!apiKey || !isOpenAIResponsesEndpoint(baseUrl)))
	) {
		return undefined;
	}
	// The Responses leg shares the fetch chain except the reasoning fallback,
	// which only applies to Chat Completions bodies.
	// A server without the route may also answer it with a JSON error and
	// status 200 (LM Studio); that is turned into the 404 it means.
	const routeCheckedFetch = createResponsesRouteCheckFetch(
		ensureFetch(input.fetch),
	);
	const responsesFetch = onResponseError
		? createResponseErrorFetch({
				fetch: routeCheckedFetch,
				onResponseError,
			})
		: routeCheckedFetch;
	try {
		const { createOpenAI } = await import("@ai-sdk/openai");
		return createOpenAI({
			name: responsesProviderName(input.context.provider.id),
			// Always explicit: without it `@ai-sdk/openai` reads OPENAI_API_KEY
			// (and OPENAI_BASE_URL) from the environment and would send that key
			// to whatever endpoint is configured. A keyless endpoint the user
			// explicitly put on the Responses API gets an empty key and no
			// Authorization header, exactly like its Chat Completions requests.
			apiKey: apiKey ?? "",
			baseURL: baseUrl,
			headers: apiKey
				? config.headers
				: ({ Authorization: undefined, ...config.headers } as unknown as Record<
						string,
						string
					>),
			...(responsesFetch ? { fetch: responsesFetch } : {}),
		});
	} catch (error) {
		// The adapter validates OPENAI_BASE_URL when it loads; a bad value in
		// the environment must not take Chat Completions down with it.
		input.context.logger?.log(
			`[${input.context.provider.id}] Responses API unavailable (${error instanceof Error ? error.message : String(error)}); using Chat Completions`,
		);
		return undefined;
	}
}
