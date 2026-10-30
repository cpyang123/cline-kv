// Stream time limit: turn a provider's hard cap on streaming time into a clean
// output-limit stop instead of a dropped connection.
//
// GoodVision's test host closes every streaming response about 30 seconds
// after it started, whether or not tokens are still flowing (measured
// 2026-10-30: a continuously streaming 6000-token reply died at 31.0 s with
// "socket connection was closed unexpectedly"). From the agent's side that is
// a mid-stream network death: the partial text is shown, the turn fails, and
// nothing retries because re-streaming would duplicate what was shown. This
// middleware ends the stream itself a few seconds before the cap, with a
// `length` finish reason, so the runtime treats the turn like one that hit
// the output-token limit: the partial text is kept and the model is nudged to
// continue in smaller steps.
//
// A stream that has produced no text or tool call by the deadline is left
// alone: there is nothing worth keeping, and the provider's own failure then
// goes through the pre-content network retry (`retry-empty-response.ts`).

import type {
	LanguageModelV4Middleware,
	LanguageModelV4StreamPart,
	LanguageModelV4StreamResult,
	LanguageModelV4Usage,
} from "@ai-sdk/provider";

export const STREAM_TIME_LIMIT_RAW_REASON = "stream-time-limit";

export interface StreamTimeLimitOptions {
	/** How long after the request started the stream is ended, in ms. */
	limitMs: number;
	now?: () => number;
	onCut?: (info: { elapsedMs: number; limitMs: number }) => void;
}

function unknownUsage(): LanguageModelV4Usage {
	return {
		inputTokens: {
			total: undefined,
			noCache: undefined,
			cacheRead: undefined,
			cacheWrite: undefined,
		},
		outputTokens: { total: undefined, text: undefined, reasoning: undefined },
		raw: undefined,
	};
}

/**
 * Pass `source` through until `limitMs` after `startedAt`, then (if some text
 * or tool call was produced) close the open text and reasoning parts, drop any
 * half-built tool input, emit a `length` finish and cancel the source.
 */
export function limitStreamTime(
	source: ReadableStream<LanguageModelV4StreamPart>,
	options: StreamTimeLimitOptions & { startedAt: number },
): ReadableStream<LanguageModelV4StreamPart> {
	const now = options.now ?? (() => Date.now());
	const reader = source.getReader();
	const openText = new Set<string>();
	const openReasoning = new Set<string>();
	let sawContent = false;
	let settled = false;
	// Deadline passed with nothing worth keeping: the provider's stream decides.
	let disarmed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	return new ReadableStream<LanguageModelV4StreamPart>({
		start(controller) {
			const cut = () => {
				if (settled || disarmed) {
					return;
				}
				if (!sawContent) {
					disarmed = true;
					return;
				}
				settled = true;
				for (const id of openText) {
					controller.enqueue({ type: "text-end", id });
				}
				for (const id of openReasoning) {
					controller.enqueue({ type: "reasoning-end", id });
				}
				controller.enqueue({
					type: "finish",
					finishReason: {
						unified: "length",
						raw: STREAM_TIME_LIMIT_RAW_REASON,
					},
					usage: unknownUsage(),
				});
				controller.close();
				void reader.cancel().catch(() => undefined);
				options.onCut?.({
					elapsedMs: now() - options.startedAt,
					limitMs: options.limitMs,
				});
			};
			const track = (part: LanguageModelV4StreamPart) => {
				switch (part.type) {
					case "text-start":
						openText.add(part.id);
						break;
					case "text-end":
						openText.delete(part.id);
						break;
					case "text-delta":
						if (part.delta) sawContent = true;
						break;
					case "reasoning-start":
						openReasoning.add(part.id);
						break;
					case "reasoning-end":
						openReasoning.delete(part.id);
						break;
					case "tool-call":
						sawContent = true;
						break;
					default:
						break;
				}
			};
			const remaining = options.limitMs - (now() - options.startedAt);
			timer = setTimeout(cut, Math.max(0, remaining));
			void (async () => {
				try {
					for (;;) {
						const { value, done } = await reader.read();
						if (settled) {
							return;
						}
						if (done) {
							settled = true;
							clearTimeout(timer);
							controller.close();
							return;
						}
						// Timers can lag behind a busy stream; a delta past the deadline
						// is the cue to stop (complete parts and the finish still pass).
						// Judged before this part is counted, so a first token that
						// arrives late is never the thing that gets cut.
						const isDelta =
							value.type === "text-delta" ||
							value.type === "reasoning-delta" ||
							value.type === "tool-input-delta";
						if (
							!disarmed &&
							isDelta &&
							now() - options.startedAt >= options.limitMs
						) {
							clearTimeout(timer);
							cut();
							if (settled) {
								return;
							}
						}
						track(value);
						controller.enqueue(value);
					}
				} catch (error) {
					if (settled) {
						return;
					}
					settled = true;
					clearTimeout(timer);
					controller.error(error);
				}
			})();
		},
		cancel(reason) {
			settled = true;
			clearTimeout(timer);
			return reader.cancel(reason);
		},
	});
}

/**
 * Middleware form, for `wrapLanguageModel`. Place it innermost (last in the
 * middleware array) so it sees the raw provider stream and outer middlewares
 * (prompt-tools parsing) see a well-formed, `length`-finished stream.
 */
export function createStreamTimeLimitMiddleware(
	options: StreamTimeLimitOptions,
): LanguageModelV4Middleware {
	const now = options.now ?? (() => Date.now());
	return {
		specificationVersion: "v4",
		async wrapStream({ doStream }): Promise<LanguageModelV4StreamResult> {
			const startedAt = now();
			const result = await doStream();
			return {
				...result,
				stream: limitStreamTime(result.stream, { ...options, now, startedAt }),
			};
		},
	};
}
