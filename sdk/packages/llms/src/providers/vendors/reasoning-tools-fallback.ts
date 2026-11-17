// Reasoning-effort fallback for tool-bearing Chat Completions requests.
//
// Some OpenAI models refuse function tools combined with a reasoning effort on
// Chat Completions. GPT-6 Luna answers 400 "Function tools with
// reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions.
// To use function tools, use /v1/responses or set reasoning_effort to 'none'."
// (seen through Azure OpenAI, 2026-11). OpenAI does not publish which models
// do this, and an endpoint can route one id to different backends, so this
// wrapper does not keep a model-id list. Instead it reacts to that exact
// refusal: it re-sends the request once with `reasoning_effort: "none"`, as the
// error asks, and remembers the model for the endpoint. Later tool-bearing
// requests for that model then go out with "none" up front, without the extra
// round trip. Requests without tools keep their reasoning effort.
//
// A request that sends no `reasoning_effort` at all is refused the same way:
// the endpoint applies the model's default effort, which is not "none"
// (cline/cline#15055, #12866). It gets the same fallback.
//
// Only Chat Completions requests are touched: a Responses API body also has
// `tools` and no `reasoning_effort`, and must never get one injected.

import { trimTrailingSlashes } from "../url";

type FetchInput = Parameters<typeof fetch>[0];
type FetchWithOptionalPreconnect = typeof fetch & {
	preconnect?: (...args: unknown[]) => unknown;
};

const REASONING_WITH_TOOLS_REFUSAL =
	/function tools with reasoning_effort are not supported/i;

const MAX_REMEMBERED = 256;

/** Endpoint + model pairs known to refuse tools with a reasoning effort. */
const refusingModels = new Set<string>();

/** Forget every remembered model (tests). */
export function resetReasoningToolsFallbacks(): void {
	refusingModels.clear();
}

export function isReasoningWithToolsRefusal(text: string): boolean {
	return REASONING_WITH_TOOLS_REFUSAL.test(text);
}

type ToolRequestBody = Record<string, unknown> & {
	model: string;
	reasoning_effort?: string;
};

/**
 * The parsed JSON body when the request declares tools and does not already
 * send `reasoning_effort: "none"` (an explicit effort, or none at all, which
 * leaves the model's default). Any other request is not this wrapper's concern.
 */
function readToolRequestWithEffort(
	input: FetchInput,
	init: RequestInit | undefined,
): ToolRequestBody | undefined {
	if (typeof init?.body !== "string" || !isChatCompletionsRequest(input)) {
		return undefined;
	}
	let body: unknown;
	try {
		body = JSON.parse(init.body);
	} catch {
		return undefined;
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return undefined;
	}
	const record = body as Record<string, unknown>;
	if (
		typeof record.model !== "string" ||
		!Array.isArray(record.tools) ||
		record.tools.length === 0 ||
		(record.reasoning_effort !== undefined &&
			typeof record.reasoning_effort !== "string") ||
		// OpenRouter-style bodies carry their own `reasoning` object; adding
		// reasoning_effort next to it would send conflicting parameters.
		record.reasoning !== undefined ||
		record.reasoning_effort === "none"
	) {
		return undefined;
	}
	return record as ToolRequestBody;
}

function isChatCompletionsRequest(input: FetchInput): boolean {
	try {
		const url = new URL(
			input instanceof Request ? input.url : input.toString(),
		);
		return trimTrailingSlashes(url.pathname).endsWith("/chat/completions");
	} catch {
		return false;
	}
}

function isRouterAlias(model: string): boolean {
	return /(^|\/)auto$/i.test(model.trim());
}

/** A 400 that names reasoning_effort: the "none" sent up front was refused. */
async function rejectsEffortNone(response: Response): Promise<boolean> {
	try {
		return /reasoning_effort/i.test(await response.clone().text());
	} catch {
		return false;
	}
}

function rememberKey(input: FetchInput, model: string): string {
	let endpoint: string;
	try {
		const url = new URL(
			input instanceof Request ? input.url : input.toString(),
		);
		endpoint = `${url.origin}${url.pathname}`;
	} catch {
		endpoint = String(input instanceof Request ? input.url : input);
	}
	return `${endpoint}|${model}`;
}

function remember(key: string): void {
	refusingModels.delete(key);
	refusingModels.add(key);
	while (refusingModels.size > MAX_REMEMBERED) {
		const oldest = refusingModels.values().next().value;
		if (oldest === undefined) {
			break;
		}
		refusingModels.delete(oldest);
	}
}

function withoutReasoning(
	init: RequestInit,
	body: ToolRequestBody,
): RequestInit {
	return {
		...init,
		body: JSON.stringify({ ...body, reasoning_effort: "none" }),
	};
}

export interface ReasoningToolsFallbackInfo {
	model: string;
	/** "default" when the request sent no effort. */
	requestedEffort: string;
	/**
	 * The model was already known to refuse, so the request went out with
	 * "none" up front. `false` on the refusal that taught it (once per
	 * endpoint + model per process).
	 */
	remembered: boolean;
}

export interface ReasoningToolsFallbackOptions {
	/**
	 * Called every time a request is sent with `reasoning_effort: "none"` in
	 * place of the effort it asked for: on the first refusal and on every
	 * later request for a remembered model.
	 */
	onApplied?: (info: ReasoningToolsFallbackInfo) => void;
}

export function createReasoningToolsFallbackFetch(
	baseFetch: typeof fetch,
	options: ReasoningToolsFallbackOptions = {},
): typeof fetch {
	const fallbackFetch = (async (input, init) => {
		const body = readToolRequestWithEffort(input, init);
		if (!body || !init) {
			return baseFetch(input, init);
		}
		const requestedEffort = body.reasoning_effort ?? "default";
		const key = rememberKey(input, body.model);
		if (refusingModels.has(key)) {
			const degraded = await baseFetch(input, withoutReasoning(init, body));
			if (degraded.status === 400 && (await rejectsEffortNone(degraded))) {
				// The id now reaches a model that does not take "none" (a router
				// alias picking another backend): forget it, send the original.
				refusingModels.delete(key);
				void degraded.body?.cancel().catch(() => undefined);
				return baseFetch(input, init);
			}
			options.onApplied?.({
				model: body.model,
				requestedEffort,
				remembered: true,
			});
			return degraded;
		}
		const response = await baseFetch(input, init);
		if (response.status !== 400) {
			return response;
		}
		let text: string;
		try {
			text = await response.clone().text();
		} catch {
			return response;
		}
		if (!isReasoningWithToolsRefusal(text)) {
			return response;
		}
		// Router aliases (GoodVision `auto`, `openrouter/auto`) pick a backend
		// per request, so one backend's refusal says nothing about the next.
		if (!isRouterAlias(body.model)) {
			remember(key);
		}
		options.onApplied?.({
			model: body.model,
			requestedEffort,
			remembered: false,
		});
		void response.body?.cancel().catch(() => undefined);
		return baseFetch(input, withoutReasoning(init, body));
	}) as typeof fetch;
	const baseFetchWithPreconnect = baseFetch as FetchWithOptionalPreconnect;
	(fallbackFetch as FetchWithOptionalPreconnect).preconnect =
		typeof baseFetchWithPreconnect.preconnect === "function"
			? baseFetchWithPreconnect.preconnect.bind(baseFetch)
			: () => undefined;
	return fallbackFetch;
}
