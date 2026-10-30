// Adaptive tool transport: native tool calling first, the prompt protocol as
// the fallback, decided once per session.
//
// GoodVision's SmartRouter accepts native `tools` only when the key's routing
// policy has tool-capable model offers; otherwise every such request answers
// 422 `no_candidate` ("No model offer satisfies the effective policy") while
// the same request without tools is served. Which of the two applies is a
// console setting that can change without a rebuild, so instead of hard-wiring
// the prompt protocol this middleware sends the session's first tool-bearing
// request natively and, on that exact refusal, re-sends it through
// `promptToolsMiddleware`'s transformation and remembers the outcome for the
// session. A refusal costs one free round trip; an accepted request costs
// nothing extra.

import {
	APICallError,
	type LanguageModelV4CallOptions,
	type LanguageModelV4Middleware,
	type LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import {
	createPromptToolsStream,
	promptToolsMiddleware,
	transformParamsForPromptTools,
} from "./prompt-tools";

export type ToolTransport = "native" | "prompt";

export interface ToolTransportDecision {
	transport: ToolTransport;
	/** Why it was decided: the router's refusal, or a served native request. */
	reason: "tools_refused" | "native_accepted";
	at: number;
}

/**
 * A decision is kept for this long after it was made. Sessions are keyed by
 * their task id, so the limit only matters for a key that is reused across
 * sessions (no task id): it is re-probed after an hour, which is how a policy
 * change on the router side gets picked up.
 */
export const DECISION_TTL_MS = 60 * 60 * 1000;
const MAX_DECISIONS = 512;

const decisions = new Map<string, ToolTransportDecision>();

export function readToolTransportDecision(
	key: string,
	now: number = Date.now(),
): ToolTransportDecision | undefined {
	const decision = decisions.get(key);
	if (!decision) {
		return undefined;
	}
	if (now - decision.at > DECISION_TTL_MS) {
		decisions.delete(key);
		return undefined;
	}
	return decision;
}

export function recordToolTransportDecision(
	key: string,
	transport: ToolTransport,
	reason: ToolTransportDecision["reason"],
	now: number = Date.now(),
): ToolTransportDecision {
	const decision: ToolTransportDecision = { transport, reason, at: now };
	decisions.delete(key);
	decisions.set(key, decision);
	while (decisions.size > MAX_DECISIONS) {
		const oldest = decisions.keys().next().value;
		if (oldest === undefined) {
			break;
		}
		decisions.delete(oldest);
	}
	return decision;
}

/** Forget every decision (tests). */
export function resetToolTransportDecisions(): void {
	decisions.clear();
}

/**
 * The refusal that means "this key cannot declare tools": GoodVision's
 * 422 `no_candidate`. Anything else (a 4xx about the request, a 5xx, a network
 * failure) is not a transport problem and propagates unchanged.
 */
export function isNativeToolRefusal(error: unknown): boolean {
	if (!APICallError.isInstance(error) || error.statusCode !== 422) {
		return false;
	}
	const text = `${error.responseBody ?? ""}\n${error.message}`;
	return (
		text.includes("no_candidate") || text.includes("effective policy")
	);
}

function hasFunctionTools(params: LanguageModelV4CallOptions): boolean {
	return (
		(params.tools ?? []).some((tool) => tool.type === "function") &&
		params.toolChoice?.type !== "none"
	);
}

export interface AdaptiveToolTransportOptions {
	/** What a decision is remembered under: the session's task id, else the provider endpoint. */
	key: string;
	onDecision?: (decision: ToolTransportDecision) => void;
	now?: () => number;
}

/**
 * Middleware for `toolTransport: "auto"` endpoints. Place it first in the
 * middleware array so its `transformParams` output is the object its
 * `wrapStream` receives (the prompt-tools stream parser is keyed on it).
 */
export function createAdaptiveToolTransportMiddleware(
	options: AdaptiveToolTransportOptions,
): LanguageModelV4Middleware {
	const now = options.now ?? (() => Date.now());
	const decide = (
		transport: ToolTransport,
		reason: ToolTransportDecision["reason"],
	) => {
		const decision = recordToolTransportDecision(
			options.key,
			transport,
			reason,
			now(),
		);
		options.onDecision?.(decision);
	};
	return {
		specificationVersion: "v4",
		async transformParams({ params }) {
			// Once the prompt protocol is decided, every request (tools or not)
			// is rewritten up front, exactly as `promptToolsMiddleware` does.
			return readToolTransportDecision(options.key, now())?.transport ===
				"prompt"
				? transformParamsForPromptTools(params)
				: params;
		},
		async wrapStream({
			doStream,
			doGenerate,
			params,
			model,
		}): Promise<LanguageModelV4StreamResult> {
			const decision = readToolTransportDecision(options.key, now());
			if (decision?.transport === "prompt") {
				return promptToolsMiddleware.wrapStream!({
					doStream,
					doGenerate,
					params,
					model,
				});
			}
			const probing = decision === undefined && hasFunctionTools(params);
			try {
				const result = await doStream();
				if (probing) {
					decide("native", "native_accepted");
				}
				return result;
			} catch (error) {
				if (!hasFunctionTools(params) || !isNativeToolRefusal(error)) {
					throw error;
				}
				decide("prompt", "tools_refused");
				const emulated = transformParamsForPromptTools(params);
				const result = await model.doStream(emulated);
				return { ...result, stream: createPromptToolsStream(result.stream) };
			}
		},
	};
}
