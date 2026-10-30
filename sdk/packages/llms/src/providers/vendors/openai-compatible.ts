import { createGateway } from "@ai-sdk/gateway";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type {
	GatewayProviderContext,
	GatewayResolvedProviderConfig,
} from "@cline/shared";
import { modelProducesImages } from "@cline/shared";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { wrapLanguageModel } from "ai";
import { ensureFetch, resolveApiKey } from "../http";
import { createAdaptiveToolTransportMiddleware } from "../middleware/adaptive-tool-transport";
import { promptToolsMiddleware } from "../middleware/prompt-tools";
import { splitToolImagesMiddleware } from "../middleware/split-tool-images";
import { isOpenAIReasoningEraModelId } from "../model-facts";
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

export async function createOpenAICompatibleProviderModule(
	config: GatewayResolvedProviderConfig,
	context: GatewayProviderContext,
): Promise<ProviderFactoryResult> {
	// Don't preflight-check for a missing API key. If credentials are
	// missing or wrong, the provider's own response (e.g. 401) is the
	// authoritative error and is surfaced to the user as-is. This keeps
	// `llms` unopinionated about which providers do or don't need a key.
	const apiKey = await resolveApiKey(config);
	const fetch = createAzureApiVersionFetch(config);
	const onResponseError = readResponseErrorHandler(config);
	const upstreamRetry = readUpstreamRetryPolicy(context.provider.metadata);
	const retryingFetch = upstreamRetry
		? createUpstreamRetryFetch(ensureFetch(fetch), upstreamRetry)
		: fetch;
	const providerFetch = onResponseError
		? createResponseErrorFetch({
				fetch: ensureFetch(retryingFetch),
				onResponseError,
			})
		: retryingFetch;
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
	return {
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
		operations: {
			language: (modelId) =>
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
							? [promptToolsMiddleware, splitToolImagesMiddleware]
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
									]
								: splitToolImagesMiddleware,
				}),
			imageGeneration: (modelId) =>
				vercelGateway
					? vercelGateway.imageModel(modelId)
					: openRouterImageProvider
						? openRouterImageProvider.imageModel(modelId)
						: provider.imageModel(modelId),
		},
	};
}
