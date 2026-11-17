// Responses API / Chat Completions routing for the OpenAI-compatible vendor.
//
// OpenAI's reasoning-era models are served best (GPT-6 Luna: only) through
// the Responses API when a request carries function tools: Chat Completions
// refuses tools combined with a reasoning effort for some of them, which the
// chat leg can only answer by turning reasoning off (see
// reasoning-tools-fallback.ts). The router below sends a request through the
// Responses API and, when the endpoint turns out not to serve `/responses`
// (self-hosted servers, gateways, Azure legacy deployment paths), re-sends the
// same call through Chat Completions before any output reached the caller,
// remembers that for the endpoint + model, and tells the user once per
// request through a provider notice.
//
// The classifiers are deliberately narrow: only a missing route falls back.
// Auth, quota, overload and parameter errors are real errors on a working
// Responses endpoint and propagate unchanged.

import {
	APICallError,
	type LanguageModelV4,
	type LanguageModelV4CallOptions,
	type LanguageModelV4GenerateResult,
	type LanguageModelV4Middleware,
	type LanguageModelV4Prompt,
	type LanguageModelV4StreamPart,
	type LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import type { BasicLogger } from "@cline/shared";
import { trimTrailingSlashes } from "../url";
import type { ProviderNotice } from "./types";

/** The configured protocol a routed request started from. */
export type ResponsesApiProtocol = "auto" | "openai-responses";

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

/**
 * Notices queued while a provider module serves requests. A module is created
 * per stream call, so whatever is queued belongs to that request; the gateway
 * drains it through `ProviderFactoryResult.takeNotices`.
 */
export class ProviderNoticeQueue {
	private pending: ProviderNotice[] = [];

	push(notice: ProviderNotice): void {
		this.pending.push(notice);
	}

	/** Remove a queued notice that turned out not to apply. */
	withdraw(notice: ProviderNotice): void {
		const index = this.pending.indexOf(notice);
		if (index >= 0) {
			this.pending.splice(index, 1);
		}
	}

	take(): ProviderNotice[] {
		return this.pending.splice(0);
	}
}

interface NoticeSubject {
	modelId: string;
	endpointHost: string;
	/** Omitted for providers without Responses routing. */
	apiProtocol?: string;
	/**
	 * The base URL is an Azure deployment URL (`/openai/deployments/<name>`),
	 * which has no `/responses` route; the notice points at the v1 base URL.
	 */
	azureDeploymentUrl?: boolean;
}

function noticeMetadata(
	kind: ProviderNotice["kind"],
	subject: NoticeSubject,
	status?: number,
): Record<string, unknown> {
	return {
		kind,
		modelId: subject.modelId,
		endpointHost: subject.endpointHost,
		...(subject.apiProtocol ? { apiProtocol: subject.apiProtocol } : {}),
		...(status !== undefined ? { status } : {}),
	};
}

export function responsesUnavailableNotice(
	subject: NoticeSubject & { apiProtocol: ResponsesApiProtocol },
	status?: number,
): ProviderNotice {
	const { modelId, endpointHost } = subject;
	return {
		kind: "responses_unavailable",
		message:
			subject.apiProtocol === "openai-responses"
				? subject.azureDeploymentUrl
					? `The Responses API is selected for ${modelId}, but Azure deployment URLs (/openai/deployments/...) don't serve it${status !== undefined ? ` (HTTP ${status})` : ""}, so Cline is using Chat Completions instead. To use the Responses API, set the base URL to https://${endpointHost}/openai/v1.`
					: `The Responses API is selected for ${modelId}, but ${endpointHost} doesn't support it${status !== undefined ? ` (HTTP ${status})` : ""}, so Cline is using Chat Completions instead. You can change this under API in the OpenAI Compatible settings.`
				: `${endpointHost} doesn't support the Responses API for ${modelId}, so Cline is using Chat Completions instead.`,
		metadata: noticeMetadata("responses_unavailable", subject, status),
	};
}

export function reasoningDisabledForToolsNotice(
	subject: NoticeSubject,
): ProviderNotice {
	return {
		kind: "reasoning_disabled_for_tools",
		message: `${subject.modelId} doesn't accept tools with reasoning on Chat Completions, so Cline is sending its tool requests with reasoning turned off.`,
		metadata: noticeMetadata("reasoning_disabled_for_tools", subject),
	};
}

export function reasoningReplayDroppedNotice(
	subject: NoticeSubject & { apiProtocol: ResponsesApiProtocol },
	status?: number,
): ProviderNotice {
	return {
		kind: "reasoning_replay_dropped",
		message: `${subject.endpointHost} rejected the model's earlier reasoning, so Cline resent the request without it.`,
		metadata: noticeMetadata("reasoning_replay_dropped", subject, status),
	};
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/** `@ai-sdk/openai` raises this when a `/responses` URL streams chat chunks. */
const CHAT_COMPLETIONS_STREAM_MISMATCH =
	/received a chat completions stream while using the openai responses api/i;

/** The model or deployment is missing: the route exists, chat would fail too. */
const MISSING_MODEL_PATTERNS = [
	/model_not_found/i,
	/deploymentnotfound/i,
	/\b(?:model|deployment)\b[^\n.]{0,160}\bdoes not exist\b/i,
];

/** Errors about reasoning items replayed in the request input. */
const REPLAYED_REASONING_PATTERNS = [
	/encrypted[_ ]content/i,
	/\breasoning items?\b/i,
	/\bof type ['"`]?reasoning['"`]?/i,
	/\bitem with id\b/i,
	/\bitem\b[^\n]{0,120}\bnot found\b/i,
	/['"`]rs_[A-Za-z0-9_-]+['"`]/,
];

/** 400/422 messages that name the route or operation, not a parameter. */
const ROUTE_REJECTION_PATTERNS = [
	/unrecognized request url/i,
	/\binvalid url\b/i,
	/\bunknown (?:endpoint|route|url|path)\b/i,
	/\b(?:endpoint|route|path) (?:was )?not found\b/i,
	/\bno route\b/i,
	/operationnotsupported/i,
	/\bunsupported operation\b/i,
	/\boperation (?:is )?not supported\b/i,
	/\bunexpected endpoint\b/i,
];

function errorText(error: APICallError): string {
	return `${error.responseBody ?? ""}\n${error.message}`;
}

function isResponsesUrl(url: string | undefined): boolean {
	if (!url) {
		return false;
	}
	try {
		return trimTrailingSlashes(new URL(url).pathname).endsWith("/responses");
	} catch {
		return false;
	}
}

/** The endpoint answered with an event stream, so it serves the route. */
function wasStreamed(error: APICallError): boolean {
	const headers = error.responseHeaders ?? {};
	return Object.entries(headers).some(
		([name, value]) =>
			name.toLowerCase() === "content-type" &&
			typeof value === "string" &&
			value.toLowerCase().includes("text/event-stream"),
	);
}

/** OpenAI-style errors name the offending request field in `error.param`. */
function namesRequestParameter(error: APICallError): boolean {
	if (!error.responseBody) {
		return false;
	}
	try {
		const body = JSON.parse(error.responseBody) as {
			error?: { param?: unknown };
			param?: unknown;
		};
		const param = body?.error?.param ?? body?.param;
		return typeof param === "string" && param.trim().length > 0;
	} catch {
		return false;
	}
}

function namesReplayedReasoning(text: string): boolean {
	return REPLAYED_REASONING_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Whether a failed Responses request means "this endpoint does not serve the
 * Responses API": an HTTP 404/405/501 for a `/responses` URL that does not
 * name a missing model or deployment, a 400/422 that names the route or
 * operation rather than a parameter, or a `/responses` URL that answered with
 * Chat Completions chunks. Never auth (401/403), rate limits (429), other 5xx,
 * parameter errors, aborts, or errors raised inside a running event stream.
 */
export function isResponsesUnsupportedError(error: unknown): boolean {
	if (!APICallError.isInstance(error) || !isResponsesUrl(error.url)) {
		return false;
	}
	if (CHAT_COMPLETIONS_STREAM_MISMATCH.test(error.message)) {
		return true;
	}
	const status = error.statusCode;
	if (status === undefined || wasStreamed(error)) {
		return false;
	}
	const text = errorText(error);
	if (
		MISSING_MODEL_PATTERNS.some((pattern) => pattern.test(text)) ||
		namesReplayedReasoning(text)
	) {
		return false;
	}
	if (status === 404 || status === 405 || status === 501) {
		return true;
	}
	if (status !== 400 && status !== 422) {
		return false;
	}
	if (/operationnotsupported/i.test(text)) {
		return true;
	}
	if (namesRequestParameter(error)) {
		return false;
	}
	return (
		ROUTE_REJECTION_PATTERNS.some((pattern) => pattern.test(text)) ||
		(/\bnot supported\b|\bunsupported\b/i.test(text) &&
			/\/responses\b|\bresponses (?:api|endpoint)\b|\bendpoint\b/i.test(text))
	);
}

/**
 * Whether the key may not use the Responses API although it may use Chat
 * Completions: an OpenAI restricted key without the Responses permission
 * answers 401/403 "Missing scopes: api.responses.write". Only Auto falls back
 * on it; an explicit Responses choice surfaces it.
 */
export function isResponsesPermissionRefusal(error: unknown): boolean {
	if (
		!APICallError.isInstance(error) ||
		!isResponsesUrl(error.url) ||
		(error.statusCode !== 401 && error.statusCode !== 403)
	) {
		return false;
	}
	return /missing scopes?|api\.responses|insufficient permissions/i.test(
		errorText(error),
	);
}

/**
 * Whether a Responses request was refused because of the reasoning items it
 * replayed (an encrypted blob the endpoint cannot verify, an item id it does
 * not know): an HTTP 400/404 whose message names a reasoning item, encrypted
 * content, or an unknown item id.
 */
export function isReasoningReplayRejection(error: unknown): boolean {
	const failure = describeFailure(error);
	return (
		failure !== undefined &&
		(failure.status === undefined ||
			failure.status === 400 ||
			failure.status === 404) &&
		namesReplayedReasoning(failure.text)
	);
}

/**
 * Whether the endpoint refused to generate reasoning summaries, which OpenAI
 * requires a verified organization for ("Your organization must be verified
 * to generate reasoning summaries", `param: "reasoning.summary"`). The
 * request is re-sent without a summary.
 */
export function isReasoningSummaryRefusal(error: unknown): boolean {
	const failure = describeFailure(error);
	return (
		failure !== undefined &&
		(failure.status === undefined || failure.status === 400) &&
		(/["']param["']\s*:\s*["']reasoning\.summary["']/.test(failure.text) ||
			/verified to generate reasoning summar/i.test(failure.text))
	);
}

/**
 * Status and text of a failed request: an APICallError (HTTP error before
 * the stream) or a provider stream error (an error event inside the stream,
 * a plain object with a message and, sometimes, a status).
 */
function describeFailure(
	error: unknown,
): { status?: number; text: string } | undefined {
	if (APICallError.isInstance(error)) {
		return { status: error.statusCode, text: errorText(error) };
	}
	if (!error || typeof error !== "object") {
		return undefined;
	}
	const record = error as Record<string, unknown>;
	const message = typeof record.message === "string" ? record.message : "";
	let detail = "";
	try {
		detail = JSON.stringify(record);
	} catch {
		// Circular structures: the message alone is enough.
	}
	const status =
		typeof record.statusCode === "number"
			? record.statusCode
			: typeof record.status === "number"
				? record.status
				: undefined;
	return message || detail
		? { status, text: `${detail}\n${message}` }
		: undefined;
}

function statusOf(error: unknown): number | undefined {
	return APICallError.isInstance(error) ? error.statusCode : undefined;
}

// ---------------------------------------------------------------------------
// Decision memory
// ---------------------------------------------------------------------------

export interface ProtocolDecision {
	/** Only the fallback is remembered; the Responses API is the default. */
	protocol: "chat";
	/** HTTP status of the refusal that caused the fallback, when it had one. */
	status?: number;
	at: number;
}

/**
 * A fallback is kept for this long. An endpoint that starts serving
 * `/responses` (a proxy upgrade) is picked up after at most an hour.
 */
export const PROTOCOL_DECISION_TTL_MS = 60 * 60 * 1000;
const MAX_PROTOCOL_DECISIONS = 512;

const protocolDecisions = new Map<string, ProtocolDecision>();

/** What a decision is remembered under: the endpoint base URL and the model. */
/**
 * Reasoning items an endpoint rejected when they were replayed, per decision
 * memory key. They stay in the session's history, so later requests drop
 * them up front instead of being refused and re-sent every time; items
 * produced afterwards are still replayed.
 */
const rejectedReasoningItems = new Map<string, Set<string>>();
/** Decision memory keys whose endpoint refuses reasoning summaries. */
const summaryRefusals = new Map<string, number>();
const MAX_REJECTED_ITEMS_PER_KEY = 2048;

function rememberRejectedItems(key: string, itemIds: Iterable<string>): void {
	const known = rejectedReasoningItems.get(key) ?? new Set<string>();
	for (const id of itemIds) known.add(id);
	while (known.size > MAX_REJECTED_ITEMS_PER_KEY) {
		const oldest = known.values().next().value;
		if (oldest === undefined) break;
		known.delete(oldest);
	}
	rejectedReasoningItems.delete(key);
	rejectedReasoningItems.set(key, known);
	while (rejectedReasoningItems.size > MAX_PROTOCOL_DECISIONS) {
		const oldest = rejectedReasoningItems.keys().next().value;
		if (oldest === undefined) break;
		rejectedReasoningItems.delete(oldest);
	}
}

function rememberSummaryRefusal(key: string, now: number): void {
	summaryRefusals.delete(key);
	summaryRefusals.set(key, now);
	while (summaryRefusals.size > MAX_PROTOCOL_DECISIONS) {
		const oldest = summaryRefusals.keys().next().value;
		if (oldest === undefined) break;
		summaryRefusals.delete(oldest);
	}
}

function refusesSummaries(key: string, now: number): boolean {
	const at = summaryRefusals.get(key);
	if (at === undefined) return false;
	if (now - at > PROTOCOL_DECISION_TTL_MS) {
		summaryRefusals.delete(key);
		return false;
	}
	return true;
}

export function protocolDecisionKey(baseUrl: string, modelId: string): string {
	try {
		const url = new URL(baseUrl);
		return `${url.origin}${trimTrailingSlashes(url.pathname)}|${modelId}`;
	} catch {
		return `${trimTrailingSlashes(baseUrl)}|${modelId}`;
	}
}

export function readProtocolDecision(
	key: string,
	now: number = Date.now(),
): ProtocolDecision | undefined {
	const decision = protocolDecisions.get(key);
	if (!decision) {
		return undefined;
	}
	if (now - decision.at > PROTOCOL_DECISION_TTL_MS) {
		protocolDecisions.delete(key);
		return undefined;
	}
	return decision;
}

export function recordProtocolDecision(
	key: string,
	status: number | undefined,
	now: number = Date.now(),
): ProtocolDecision {
	const decision: ProtocolDecision = {
		protocol: "chat",
		...(status !== undefined ? { status } : {}),
		at: now,
	};
	protocolDecisions.delete(key);
	protocolDecisions.set(key, decision);
	while (protocolDecisions.size > MAX_PROTOCOL_DECISIONS) {
		const oldest = protocolDecisions.keys().next().value;
		if (oldest === undefined) {
			break;
		}
		protocolDecisions.delete(oldest);
	}
	return decision;
}

/** Forget every decision (tests). */
export function resetProtocolDecisions(): void {
	rejectedReasoningItems.clear();
	summaryRefusals.clear();
	protocolDecisions.clear();
}

// ---------------------------------------------------------------------------
// Prompt rewriting
// ---------------------------------------------------------------------------

type AssistantPart = Extract<
	LanguageModelV4Prompt[number],
	{ role: "assistant" }
>["content"][number];

/** Reasoning produced by the Responses API carries its item id. */
function isResponsesReasoningPart(part: AssistantPart): boolean {
	if (part.type !== "reasoning") {
		return false;
	}
	const options = part.providerOptions as
		| Record<string, Record<string, unknown> | undefined>
		| undefined;
	return (
		typeof options?.openai?.itemId === "string" ||
		typeof options?.azure?.itemId === "string"
	);
}

function isAnyReasoningPart(part: AssistantPart): boolean {
	return part.type === "reasoning" || part.type === "reasoning-file";
}

/**
 * Drop assistant parts matching `shouldDrop`. Returns the same prompt object
 * when nothing matched, so callers can tell whether anything was removed.
 * An assistant message left with no content is dropped with its parts.
 */
function withoutAssistantParts(
	prompt: LanguageModelV4Prompt,
	shouldDrop: (part: AssistantPart) => boolean,
): LanguageModelV4Prompt {
	let changed = false;
	const next: LanguageModelV4Prompt = [];
	for (const message of prompt) {
		if (message.role !== "assistant" || !message.content.some(shouldDrop)) {
			next.push(message);
			continue;
		}
		changed = true;
		const content = message.content.filter((part) => !shouldDrop(part));
		if (content.length > 0) {
			next.push({ ...message, content });
		}
	}
	return changed ? next : prompt;
}

/**
 * Remove reasoning that came from the Responses API. Chat Completions would
 * replay its summary text as `reasoning_content`, which the endpoint did not
 * produce and may reject.
 */
export function stripResponsesReasoning(
	prompt: LanguageModelV4Prompt,
): LanguageModelV4Prompt {
	return withoutAssistantParts(prompt, isResponsesReasoningPart);
}

function responsesReasoningItemId(part: AssistantPart): string | undefined {
	if (part.type !== "reasoning") return undefined;
	const options = part.providerOptions as
		| Record<string, Record<string, unknown> | undefined>
		| undefined;
	const id = options?.openai?.itemId ?? options?.azure?.itemId;
	return typeof id === "string" ? id : undefined;
}

/** Ids of the Responses reasoning items replayed in a prompt. */
export function responsesReasoningItemIds(
	prompt: LanguageModelV4Prompt,
): string[] {
	const ids: string[] = [];
	for (const message of prompt) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			const id = responsesReasoningItemId(part);
			if (id) ids.push(id);
		}
	}
	return ids;
}

/** Remove the Responses reasoning items with these ids. */
export function stripReasoningItems(
	prompt: LanguageModelV4Prompt,
	itemIds: ReadonlySet<string>,
): LanguageModelV4Prompt {
	if (itemIds.size === 0) return prompt;
	return withoutAssistantParts(prompt, (part) => {
		const id = responsesReasoningItemId(part);
		return id !== undefined && itemIds.has(id);
	});
}

/** Remove every reasoning part (a re-send after the endpoint refused them). */
export function stripAllReasoning(
	prompt: LanguageModelV4Prompt,
): LanguageModelV4Prompt {
	return withoutAssistantParts(prompt, isAnyReasoningPart);
}

/**
 * Chat-leg middleware for providers that can route to the Responses API: a
 * session that switched from the Responses API to Chat Completions (setting
 * change, remembered fallback) still holds Responses reasoning in its history.
 */
export const stripResponsesReasoningMiddleware: LanguageModelV4Middleware = {
	specificationVersion: "v4",
	transformParams: async ({ params }) => {
		const prompt = stripResponsesReasoning(params.prompt);
		return prompt === params.prompt ? params : { ...params, prompt };
	},
};

// ---------------------------------------------------------------------------
// Stream peeking
// ---------------------------------------------------------------------------

/** Parts that precede model output on every stream and carry none of it. */
const LEADING_PART_TYPES = new Set<LanguageModelV4StreamPart["type"]>([
	"stream-start",
	"response-metadata",
	"raw",
]);

interface PeekedStream {
	/** An error part that arrived before any other part. */
	earlyError?: { error: unknown };
	/** The stream as it would have been read, nothing lost. */
	stream: ReadableStream<LanguageModelV4StreamPart>;
	cancel(): void;
}

/**
 * Read the leading parts of a stream up to the first part that is not
 * `stream-start`/`response-metadata`/`raw`, so an error that arrives before
 * any output can be inspected before the stream is handed on.
 */
async function peekLeadingParts(
	stream: ReadableStream<LanguageModelV4StreamPart>,
): Promise<PeekedStream> {
	const reader = stream.getReader();
	const buffered: LanguageModelV4StreamPart[] = [];
	let earlyError: { error: unknown } | undefined;
	let readFailure: { error: unknown } | undefined;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffered.push(value);
			if (value.type === "error") {
				earlyError = { error: value.error };
				break;
			}
			if (!LEADING_PART_TYPES.has(value.type)) {
				break;
			}
		}
	} catch (error) {
		readFailure = { error };
	}
	return {
		earlyError,
		stream: new ReadableStream<LanguageModelV4StreamPart>({
			start(controller) {
				for (const part of buffered) {
					controller.enqueue(part);
				}
			},
			async pull(controller) {
				// Raised only once the buffered parts were read: erroring the
				// controller earlier would discard them.
				if (readFailure) {
					controller.error(readFailure.error);
					return;
				}
				try {
					const { done, value } = await reader.read();
					if (done) {
						controller.close();
					} else {
						controller.enqueue(value);
					}
				} catch (error) {
					controller.error(error);
				}
			},
			cancel(reason) {
				return reader.cancel(reason);
			},
		}),
		cancel: () => {
			reader.cancel().catch(() => undefined);
		},
	};
}

// ---------------------------------------------------------------------------
// Router model
// ---------------------------------------------------------------------------

export interface ResponsesRouterOptions {
	/** The Chat Completions model, with its fetch chain and middleware. */
	chat: LanguageModelV4;
	/** The Responses API model for the same endpoint and model id. */
	responses: LanguageModelV4;
	/** Decision memory key, see {@link protocolDecisionKey}. */
	memoryKey: string;
	modelId: string;
	endpointHost: string;
	apiProtocol: ResponsesApiProtocol;
	/** See {@link NoticeSubject.azureDeploymentUrl}. */
	azureDeploymentUrl?: boolean;
	notices: ProviderNoticeQueue;
	logger?: BasicLogger;
	/** Log line prefix, e.g. the provider id. */
	label?: string;
	now?: () => number;
}

interface RouterLeg<R> {
	chat(options: LanguageModelV4CallOptions): PromiseLike<R>;
	responses(options: LanguageModelV4CallOptions): Promise<R>;
}

/**
 * A model that serves each call through the Responses API and falls back to
 * Chat Completions when the endpoint does not serve `/responses`. It presents
 * the chat model's provider, model id and supported URLs, so callers see one
 * model whichever protocol served the call.
 */
class ResponsesRouterModel implements LanguageModelV4 {
	readonly specificationVersion = "v4";
	readonly provider: string;
	readonly modelId: string;
	private readonly now: () => number;
	private readonly subject: NoticeSubject & {
		apiProtocol: ResponsesApiProtocol;
	};

	constructor(private readonly options: ResponsesRouterOptions) {
		this.provider = options.chat.provider;
		this.modelId = options.chat.modelId;
		this.now = options.now ?? (() => Date.now());
		this.subject = {
			modelId: options.modelId,
			endpointHost: options.endpointHost,
			apiProtocol: options.apiProtocol,
			...(options.azureDeploymentUrl ? { azureDeploymentUrl: true } : {}),
		};
	}

	get supportedUrls(): LanguageModelV4["supportedUrls"] {
		return this.options.chat.supportedUrls;
	}

	doStream(
		options: LanguageModelV4CallOptions,
	): Promise<LanguageModelV4StreamResult> {
		return this.route(options, {
			chat: (callOptions) => this.options.chat.doStream(callOptions),
			responses: (callOptions) => this.streamResponses(callOptions),
		});
	}

	doGenerate(
		options: LanguageModelV4CallOptions,
	): Promise<LanguageModelV4GenerateResult> {
		return this.route(options, {
			chat: (callOptions) => this.options.chat.doGenerate(callOptions),
			responses: async (callOptions) =>
				this.options.responses.doGenerate(callOptions),
		});
	}

	private async route<R>(
		options: LanguageModelV4CallOptions,
		leg: RouterLeg<R>,
	): Promise<R> {
		const remembered = readProtocolDecision(this.options.memoryKey, this.now());
		if (remembered) {
			this.options.logger?.debug?.(
				`${this.prefix()}${this.options.modelId}: using Chat Completions (Responses API unavailable at ${this.options.endpointHost}, remembered)`,
			);
			return this.viaChat(options, leg, remembered.status, true);
		}
		try {
			return await this.viaResponses(options, leg);
		} catch (error) {
			if (
				!isResponsesUnsupportedError(error) &&
				!(
					this.options.apiProtocol === "auto" &&
					isResponsesPermissionRefusal(error)
				)
			) {
				throw error;
			}
			return this.viaChat(options, leg, statusOf(error), false);
		}
	}

	/**
	 * One Responses call, adjusted for what this endpoint is known to refuse
	 * (previously rejected reasoning items, reasoning summaries) and re-sent
	 * when it refuses something new: replayed reasoning (re-sent without any,
	 * those items remembered) or reasoning summaries (re-sent without one,
	 * remembered). Each adjustment is made at most once per call.
	 */
	private async viaResponses<R>(
		options: LanguageModelV4CallOptions,
		leg: RouterLeg<R>,
	): Promise<R> {
		const key = this.options.memoryKey;
		let call = this.withKnownRefusals(options);
		let strippedReplay = false;
		let droppedSummary = false;
		for (;;) {
			try {
				return await leg.responses(call);
			} catch (error) {
				if (!strippedReplay && isReasoningReplayRejection(error)) {
					const prompt = stripAllReasoning(call.prompt);
					if (prompt === call.prompt) throw error;
					rememberRejectedItems(key, responsesReasoningItemIds(call.prompt));
					this.options.notices.push(
						reasoningReplayDroppedNotice(this.subject, statusOf(error)),
					);
					this.options.logger?.log(
						`${this.prefix()}${this.options.endpointHost} rejected replayed reasoning for ${this.options.modelId} (HTTP ${statusOf(error) ?? "?"}); resending without it`,
					);
					strippedReplay = true;
					call = { ...call, prompt };
					continue;
				}
				if (!droppedSummary && isReasoningSummaryRefusal(error)) {
					rememberSummaryRefusal(key, this.now());
					this.options.logger?.log(
						`${this.prefix()}${this.options.endpointHost} refuses reasoning summaries for ${this.options.modelId}; resending without one`,
					);
					droppedSummary = true;
					call = withoutReasoningSummary(call);
					continue;
				}
				throw error;
			}
		}
	}

	private withKnownRefusals(
		options: LanguageModelV4CallOptions,
	): LanguageModelV4CallOptions {
		const key = this.options.memoryKey;
		let call = options;
		const rejected = rejectedReasoningItems.get(key);
		if (rejected) {
			const prompt = stripReasoningItems(call.prompt, rejected);
			if (prompt !== call.prompt) call = { ...call, prompt };
		}
		if (refusesSummaries(key, this.now())) {
			call = withoutReasoningSummary(call);
		}
		return call;
	}

	private async viaChat<R>(
		options: LanguageModelV4CallOptions,
		leg: RouterLeg<R>,
		status: number | undefined,
		remembered: boolean,
	): Promise<R> {
		const notice = responsesUnavailableNotice(this.subject, status);
		this.options.notices.push(notice);
		try {
			const prompt = stripResponsesReasoning(options.prompt);
			const result = await leg.chat(
				prompt === options.prompt ? options : { ...options, prompt },
			);
			if (!remembered) {
				recordProtocolDecision(this.options.memoryKey, status, this.now());
				this.options.logger?.log(
					`${this.prefix()}${this.options.endpointHost} does not serve the Responses API for ${this.options.modelId} (HTTP ${status ?? "?"}); using Chat Completions for this endpoint and model`,
				);
			}
			return result;
		} catch (error) {
			// The chat leg's own error is what the user sees; the notice would
			// claim a fallback that did not happen.
			this.options.notices.withdraw(notice);
			throw error;
		}
	}

	private async streamResponses(
		options: LanguageModelV4CallOptions,
	): Promise<LanguageModelV4StreamResult> {
		const result = await this.options.responses.doStream(options);
		const peeked = await peekLeadingParts(result.stream);
		const early = peeked.earlyError?.error;
		if (
			early !== undefined &&
			(isResponsesUnsupportedError(early) ||
				isReasoningReplayRejection(early) ||
				isReasoningSummaryRefusal(early))
		) {
			peeked.cancel();
			throw early;
		}
		return { ...result, stream: peeked.stream };
	}

	private prefix(): string {
		return this.options.label ? `[${this.options.label}] ` : "";
	}
}

/**
 * Fetch for the Responses leg: a streamed `/responses` request answered with
 * a 200 JSON body carrying an `error` (LM Studio answers unknown routes this
 * way, "Unexpected endpoint or method. (POST /v1/responses)") is returned as
 * the 404 it means, so the router falls back instead of reading an empty
 * stream. Every other response passes through untouched.
 */
export function createResponsesRouteCheckFetch(
	baseFetch: typeof fetch,
): typeof fetch {
	const checked = (async (input, init) => {
		const response = await baseFetch(input, init);
		const url = input instanceof Request ? input.url : String(input);
		const contentType = response.headers.get("content-type") ?? "";
		if (
			!response.ok ||
			!isResponsesUrl(url) ||
			contentType.toLowerCase().includes("text/event-stream") ||
			!wantsStream(init)
		) {
			return response;
		}
		let text: string;
		try {
			text = await response.clone().text();
		} catch {
			return response;
		}
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			return response;
		}
		const error =
			body && typeof body === "object"
				? (body as Record<string, unknown>).error
				: undefined;
		if (error === undefined || error === null) {
			return response;
		}
		void response.body?.cancel().catch(() => undefined);
		const headers = new Headers(response.headers);
		headers.delete("content-length");
		headers.delete("content-encoding");
		headers.set("content-type", "application/json");
		return new Response(text, {
			status: 404,
			statusText: "Not Found",
			headers,
		});
	}) as typeof fetch;
	const base = baseFetch as typeof fetch & {
		preconnect?: (...args: unknown[]) => unknown;
	};
	(checked as typeof base).preconnect =
		typeof base.preconnect === "function"
			? base.preconnect.bind(baseFetch)
			: () => undefined;
	return checked;
}

function wantsStream(init: RequestInit | undefined): boolean {
	if (typeof init?.body !== "string") return false;
	try {
		return (JSON.parse(init.body) as { stream?: unknown }).stream === true;
	} catch {
		return false;
	}
}

/**
 * The call with `reasoningSummary: null` in the openai bucket, which makes
 * @ai-sdk/openai omit `reasoning.summary` (it only defaults the summary when
 * the option is undefined).
 */
function withoutReasoningSummary(
	options: LanguageModelV4CallOptions,
): LanguageModelV4CallOptions {
	const providerOptions = (options.providerOptions ?? {}) as Record<
		string,
		Record<string, unknown> | undefined
	>;
	return {
		...options,
		providerOptions: {
			...providerOptions,
			openai: { ...(providerOptions.openai ?? {}), reasoningSummary: null },
		} as LanguageModelV4CallOptions["providerOptions"],
	};
}

export function createResponsesRouterModel(
	options: ResponsesRouterOptions,
): LanguageModelV4 {
	return new ResponsesRouterModel(options);
}
