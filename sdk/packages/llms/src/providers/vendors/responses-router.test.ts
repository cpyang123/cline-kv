import {
	APICallError,
	type LanguageModelV4,
	type LanguageModelV4CallOptions,
	type LanguageModelV4Prompt,
	type LanguageModelV4StreamPart,
	type LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createResponsesRouteCheckFetch,
	createResponsesRouterModel,
	isReasoningReplayRejection,
	isReasoningSummaryRefusal,
	isResponsesPermissionRefusal,
	isResponsesUnsupportedError,
	PROTOCOL_DECISION_TTL_MS,
	ProviderNoticeQueue,
	protocolDecisionKey,
	type ResponsesApiProtocol,
	readProtocolDecision,
	recordProtocolDecision,
	resetProtocolDecisions,
	responsesUnavailableNotice,
	stripAllReasoning,
	stripResponsesReasoning,
	stripResponsesReasoningMiddleware,
} from "./responses-router";

const RESPONSES_URL = "https://res.openai.azure.com/openai/v1/responses";
const CHAT_URL = "https://res.openai.azure.com/openai/v1/chat/completions";
const KEY = "https://res.openai.azure.com/openai/v1|gpt-6-luna";

function apiError(input: {
	status?: number;
	body?: string;
	message?: string;
	url?: string;
	headers?: Record<string, string>;
}): APICallError {
	return new APICallError({
		message: input.message ?? "request failed",
		url: input.url ?? RESPONSES_URL,
		requestBodyValues: {},
		statusCode: input.status,
		responseBody: input.body,
		responseHeaders: input.headers,
	});
}

const abortError = () =>
	Object.assign(new Error("This operation was aborted"), {
		name: "AbortError",
	});

const unsupported: Array<[string, unknown]> = [
	[
		"404 {detail: Not Found}",
		apiError({
			status: 404,
			body: '{"detail":"Not Found"}',
			message: "Not Found",
		}),
	],
	[
		"text 404",
		apiError({ status: 404, body: "404 page not found", message: "Not Found" }),
	],
	[
		"Azure route 404",
		apiError({
			status: 404,
			body: '{"error":{"code":"404","message":"Resource not found"}}',
			message: "Resource not found",
		}),
	],
	[
		"OpenAI Invalid URL 404",
		apiError({
			status: 404,
			body: '{"error":{"message":"Invalid URL (POST /v1/responses)","type":"invalid_request_error","param":null,"code":null}}',
			message: "Invalid URL (POST /v1/responses)",
		}),
	],
	["405", apiError({ status: 405, body: "Method Not Allowed" })],
	["501", apiError({ status: 501, body: '{"error":"Not Implemented"}' })],
	[
		"400 Unrecognized request URL",
		apiError({
			status: 400,
			body: '{"error":{"message":"Unrecognized request URL (POST: /v1/responses).","type":"invalid_request_error","param":null}}',
			message: "Unrecognized request URL (POST: /v1/responses).",
		}),
	],
	[
		"Azure OperationNotSupported 404",
		apiError({
			status: 404,
			body: '{"error":{"code":"OperationNotSupported","message":"The responses operation does not work with the specified model, gpt-35-turbo. Please choose different model and try again."}}',
		}),
	],
	[
		"Azure OperationNotSupported 400",
		apiError({
			status: 400,
			body: '{"error":{"code":"OperationNotSupported","message":"The responses operation does not work with the specified model, gpt-35-turbo."}}',
		}),
	],
	[
		"422 unknown endpoint",
		apiError({
			status: 422,
			body: '{"error":"unknown endpoint /v1/responses"}',
		}),
	],
	[
		"a /responses URL that streamed Chat Completions chunks",
		apiError({
			message:
				"Received a Chat Completions stream while using the OpenAI Responses API. The default OpenAI provider model uses the Responses API.",
			headers: { "content-type": "text/event-stream" },
		}),
	],
];

const supported: Array<[string, unknown]> = [
	[
		"OpenAI model_not_found 404",
		apiError({
			status: 404,
			body: '{"error":{"message":"The model `gpt-6-lunar` does not exist or you do not have access to it.","type":"invalid_request_error","param":null,"code":"model_not_found"}}',
		}),
	],
	[
		"Azure DeploymentNotFound 404",
		apiError({
			status: 404,
			body: '{"error":{"code":"DeploymentNotFound","message":"The API deployment for this resource does not exist."}}',
		}),
	],
	[
		"400 parameter error",
		apiError({
			status: 400,
			body: '{"error":{"message":"Unsupported parameter: \'temperature\' is not supported with this model.","type":"invalid_request_error","param":"temperature","code":"unsupported_parameter"}}',
		}),
	],
	[
		"400 invalid tool schema",
		apiError({
			status: 400,
			body: '{"error":{"message":"Invalid schema for function \'read_file\'","param":"tools[0].parameters"}}',
		}),
	],
	[
		"401",
		apiError({ status: 401, body: '{"error":{"code":"invalid_api_key"}}' }),
	],
	[
		"403",
		apiError({ status: 403, body: '{"error":{"code":"PermissionDenied"}}' }),
	],
	[
		"429",
		apiError({ status: 429, body: '{"error":{"code":"rate_limit_exceeded"}}' }),
	],
	["500", apiError({ status: 500, body: "Internal Server Error" })],
	["503", apiError({ status: 503, body: "Service Unavailable" })],
	["abort", abortError()],
	[
		"404 on a Chat Completions URL",
		apiError({ status: 404, url: CHAT_URL, body: '{"detail":"Not Found"}' }),
	],
	[
		"an error inside a running Responses event stream",
		apiError({
			status: 404,
			body: '{"type":"error","code":"not_found","message":"File not found"}',
			headers: { "content-type": "text/event-stream" },
		}),
	],
	[
		"a 404 for an unknown replayed item",
		apiError({
			status: 404,
			body: '{"error":{"message":"Item with id \'rs_abc123\' not found. Items are not persisted when `store` is set to false.","type":"invalid_request_error","param":"input"}}',
		}),
	],
	["a plain error", new Error("Not Found")],
];

describe("isResponsesUnsupportedError", () => {
	it.each(unsupported)("falls back on %s", (_label, error) => {
		expect(isResponsesUnsupportedError(error)).toBe(true);
	});

	it.each(supported)("does not fall back on %s", (_label, error) => {
		expect(isResponsesUnsupportedError(error)).toBe(false);
	});
});

describe("isReasoningReplayRejection", () => {
	it.each([
		[
			"undecryptable encrypted content",
			apiError({
				status: 400,
				body: '{"error":{"message":"The encrypted content for item rs_abc could not be verified.","param":"input"}}',
			}),
		],
		[
			"an unknown item id",
			apiError({
				status: 404,
				body: '{"error":{"message":"Item with id \'rs_abc123\' not found.","param":"input"}}',
			}),
		],
		[
			"a reasoning item without its following item",
			apiError({
				status: 400,
				body: '{"error":{"message":"Item \'rs_abc\' of type \'reasoning\' was provided without its required following item.","param":"input"}}',
			}),
		],
	])("recognizes %s", (_label, error) => {
		expect(isReasoningReplayRejection(error)).toBe(true);
	});

	it.each([
		["a parameter error", supported[2]?.[1]],
		["a route 404", unsupported[0]?.[1]],
		[
			"a 500 naming encrypted content",
			apiError({ status: 500, body: "encrypted_content backend failed" }),
		],
		["an abort", abortError()],
	])("ignores %s", (_label, error) => {
		expect(isReasoningReplayRejection(error)).toBe(false);
	});
});

// ---------------------------------------------------------------------------

const textParts = (text: string): LanguageModelV4StreamPart[] => [
	{ type: "stream-start", warnings: [] },
	{ type: "response-metadata", id: "r1", modelId: "gpt-6-luna" },
	{ type: "text-start", id: "t" },
	{ type: "text-delta", id: "t", delta: text },
	{ type: "text-end", id: "t" },
	{
		type: "finish",
		finishReason: { unified: "stop", raw: "stop" },
		usage: {
			inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
			outputTokens: { total: 1, text: 1, reasoning: 0 },
		},
	} as LanguageModelV4StreamPart,
];

function streamOf(
	parts: LanguageModelV4StreamPart[],
	onCancel?: () => void,
): ReadableStream<LanguageModelV4StreamPart> {
	return new ReadableStream({
		start(controller) {
			for (const part of parts) controller.enqueue(part);
			controller.close();
		},
		cancel: onCancel,
	});
}

async function collect(
	stream: ReadableStream<LanguageModelV4StreamPart>,
): Promise<LanguageModelV4StreamPart[]> {
	const out: LanguageModelV4StreamPart[] = [];
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return out;
		out.push(value);
	}
}

const textOf = (parts: LanguageModelV4StreamPart[]) =>
	parts
		.filter((part) => part.type === "text-delta")
		.map((part) => (part as { delta: string }).delta)
		.join("");

type StreamBehavior =
	| { parts: LanguageModelV4StreamPart[]; onCancel?: () => void }
	| { throws: unknown };

/** A model that records its calls and answers with the next behavior. */
function fakeModel(
	name: string,
	behaviors: StreamBehavior[] | ((call: number) => StreamBehavior),
) {
	const calls: LanguageModelV4CallOptions[] = [];
	const next = (): StreamBehavior => {
		const index = calls.length - 1;
		return typeof behaviors === "function"
			? behaviors(index)
			: (behaviors[Math.min(index, behaviors.length - 1)] as StreamBehavior);
	};
	const model: LanguageModelV4 = {
		specificationVersion: "v4",
		provider: `${name}.provider`,
		modelId: "gpt-6-luna",
		supportedUrls: { [`${name}/*`]: [/^https:/] },
		doStream: async (options) => {
			calls.push(options);
			const behavior = next();
			if ("throws" in behavior) throw behavior.throws;
			return {
				stream: streamOf(behavior.parts, behavior.onCancel),
			} as LanguageModelV4StreamResult;
		},
		doGenerate: async (options) => {
			calls.push(options);
			const behavior = next();
			if ("throws" in behavior) throw behavior.throws;
			return {
				content: [{ type: "text", text: textOf(behavior.parts) }],
				finishReason: { unified: "stop", raw: "stop" },
				usage: {
					inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
					outputTokens: { total: 1, text: 1, reasoning: 0 },
				},
				warnings: [],
			} as never;
		},
	};
	return { model, calls };
}

const responsesReasoning = {
	type: "reasoning" as const,
	text: "Looked at the file.",
	providerOptions: {
		openai: { itemId: "rs_1", reasoningEncryptedContent: "enc-1" },
		azure: { itemId: "rs_1", reasoningEncryptedContent: "enc-1" },
	},
};
const otherReasoning = {
	type: "reasoning" as const,
	text: "Chat-side thinking.",
	providerOptions: { anthropic: { signature: "sig" } },
};

const promptWithReasoning = (): LanguageModelV4Prompt => [
	{ role: "user", content: [{ type: "text", text: "read a.ts" }] },
	{
		role: "assistant",
		content: [
			responsesReasoning,
			{
				type: "tool-call",
				toolCallId: "c1",
				toolName: "read_file",
				input: { path: "a.ts" },
			},
		],
	},
	{
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: "c1",
				toolName: "read_file",
				output: { type: "text", value: "x" },
			},
		],
	},
	{
		role: "assistant",
		content: [otherReasoning, { type: "text", text: "ok" }],
	},
	{ role: "user", content: [{ type: "text", text: "continue" }] },
];

const callOptions = (
	prompt: LanguageModelV4Prompt = [
		{ role: "user", content: [{ type: "text", text: "hi" }] },
	],
): LanguageModelV4CallOptions => ({ prompt });

function router(input: {
	chat: LanguageModelV4;
	responses: LanguageModelV4;
	apiProtocol?: ResponsesApiProtocol;
	now?: () => number;
	memoryKey?: string;
}) {
	const notices = new ProviderNoticeQueue();
	const logger = { debug: vi.fn(), log: vi.fn() };
	const model = createResponsesRouterModel({
		chat: input.chat,
		responses: input.responses,
		memoryKey: input.memoryKey ?? KEY,
		modelId: "gpt-6-luna",
		endpointHost: "res.openai.azure.com",
		apiProtocol: input.apiProtocol ?? "auto",
		notices,
		logger,
		label: "openai-compatible",
		now: input.now,
	});
	return { model, notices, logger };
}

const notFound = () =>
	apiError({
		status: 404,
		body: '{"detail":"Not Found"}',
		message: "Not Found",
	});

describe("createResponsesRouterModel", () => {
	beforeEach(() => resetProtocolDecisions());

	it("presents the chat model's provider, model id and supported URLs", () => {
		const chat = fakeModel("chat", [{ parts: textParts("chat") }]);
		const responses = fakeModel("responses", [{ parts: textParts("r") }]);
		const { model } = router({ chat: chat.model, responses: responses.model });
		expect(model.provider).toBe("chat.provider");
		expect(model.modelId).toBe("gpt-6-luna");
		expect(model.supportedUrls).toBe(chat.model.supportedUrls);
	});

	it("serves the call through the Responses API when it works", async () => {
		const chat = fakeModel("chat", [{ parts: textParts("chat") }]);
		const responses = fakeModel("responses", [
			{ parts: textParts("responses") },
		]);
		const { model, notices } = router({
			chat: chat.model,
			responses: responses.model,
		});

		const { stream } = await model.doStream(callOptions());

		expect(textOf(await collect(stream))).toBe("responses");
		expect(chat.calls).toHaveLength(0);
		expect(notices.take()).toEqual([]);
		expect(readProtocolDecision(KEY)).toBeUndefined();
	});

	it("re-sends through Chat Completions when /responses is missing, without Responses reasoning, and remembers it", async () => {
		const chat = fakeModel("chat", [{ parts: textParts("chat") }]);
		const responses = fakeModel("responses", [{ throws: notFound() }]);
		const { model, notices, logger } = router({
			chat: chat.model,
			responses: responses.model,
		});

		const { stream } = await model.doStream(callOptions(promptWithReasoning()));

		expect(textOf(await collect(stream))).toBe("chat");
		expect(responses.calls).toHaveLength(1);
		expect(responses.calls[0]?.prompt).toEqual(promptWithReasoning());
		expect(chat.calls).toHaveLength(1);
		// Only the Responses-origin reasoning is dropped for the chat leg.
		const chatPrompt = chat.calls[0]?.prompt ?? [];
		expect(JSON.stringify(chatPrompt)).not.toContain("rs_1");
		expect(chatPrompt[1]?.content).toEqual([
			expect.objectContaining({ type: "tool-call", toolCallId: "c1" }),
		]);
		expect(chatPrompt[3]?.content).toEqual([
			otherReasoning,
			{ type: "text", text: "ok" },
		]);
		expect(notices.take()).toEqual([
			{
				kind: "responses_unavailable",
				message:
					"res.openai.azure.com doesn't support the Responses API for gpt-6-luna, so Cline is using Chat Completions instead.",
				metadata: {
					kind: "responses_unavailable",
					modelId: "gpt-6-luna",
					endpointHost: "res.openai.azure.com",
					apiProtocol: "auto",
					status: 404,
				},
			},
		]);
		expect(readProtocolDecision(KEY)).toMatchObject({
			protocol: "chat",
			status: 404,
		});
		expect(logger.log).toHaveBeenCalledWith(
			expect.stringContaining("does not serve the Responses API"),
		);
	});

	it("goes straight to Chat Completions for a remembered endpoint and model, and tells the user again", async () => {
		recordProtocolDecision(KEY, 404);
		const chat = fakeModel("chat", [{ parts: textParts("chat") }]);
		const responses = fakeModel("responses", [{ parts: textParts("r") }]);
		const { model, notices } = router({
			chat: chat.model,
			responses: responses.model,
		});

		const { stream } = await model.doStream(callOptions());

		expect(textOf(await collect(stream))).toBe("chat");
		expect(responses.calls).toHaveLength(0);
		expect(notices.take().map((notice) => notice.kind)).toEqual([
			"responses_unavailable",
		]);

		// Other models and endpoints are not affected.
		const other = router({
			chat: chat.model,
			responses: responses.model,
			memoryKey: protocolDecisionKey(
				"https://res.openai.azure.com/openai/v1/",
				"gpt-6-sol",
			),
		});
		await collect((await other.model.doStream(callOptions())).stream);
		expect(responses.calls).toHaveLength(1);
	});

	it("words the notice for an explicit Responses choice with the HTTP status", async () => {
		const chat = fakeModel("chat", [{ parts: textParts("chat") }]);
		const responses = fakeModel("responses", [
			{ throws: apiError({ status: 405, body: "Method Not Allowed" }) },
		]);
		const { model, notices } = router({
			chat: chat.model,
			responses: responses.model,
			apiProtocol: "openai-responses",
		});

		await collect((await model.doStream(callOptions())).stream);

		const [notice] = notices.take();
		expect(notice?.message).toBe(
			"The Responses API is selected for gpt-6-luna, but res.openai.azure.com doesn't support it (HTTP 405), so Cline is using Chat Completions instead. You can change this under API in the OpenAI Compatible settings.",
		);
		expect(notice?.metadata).toMatchObject({
			apiProtocol: "openai-responses",
			status: 405,
		});

		// The remembered path keeps the status in its wording.
		const again = router({
			chat: chat.model,
			responses: responses.model,
			apiProtocol: "openai-responses",
		});
		await collect((await again.model.doStream(callOptions())).stream);
		expect(again.notices.take()[0]?.message).toContain("(HTTP 405)");
	});

	it.each(
		supported,
	)("propagates %s without falling back", async (_label, error) => {
		const chat = fakeModel("chat", [{ parts: textParts("chat") }]);
		const responses = fakeModel("responses", [{ throws: error }]);
		const { model, notices } = router({
			chat: chat.model,
			responses: responses.model,
		});

		await expect(model.doStream(callOptions())).rejects.toBe(error);
		expect(chat.calls).toHaveLength(0);
		expect(notices.take()).toEqual([]);
		expect(readProtocolDecision(KEY)).toBeUndefined();
	});

	it("remembers nothing and withdraws the notice when the chat leg fails too", async () => {
		const chatError = apiError({ status: 401, url: CHAT_URL });
		const chat = fakeModel("chat", [{ throws: chatError }]);
		const responses = fakeModel("responses", [{ throws: notFound() }]);
		const { model, notices } = router({
			chat: chat.model,
			responses: responses.model,
		});

		await expect(model.doStream(callOptions())).rejects.toBe(chatError);
		expect(notices.take()).toEqual([]);
		expect(readProtocolDecision(KEY)).toBeUndefined();
	});

	it("falls back when the stream's first part is an unsupported-endpoint error", async () => {
		const onCancel = vi.fn();
		const mismatch = apiError({
			message:
				"Received a Chat Completions stream while using the OpenAI Responses API.",
		});
		const chat = fakeModel("chat", [{ parts: textParts("chat") }]);
		const responses = fakeModel("responses", [
			{
				parts: [
					{ type: "stream-start", warnings: [] },
					{ type: "error", error: mismatch },
					...textParts("never").slice(2),
				],
				onCancel,
			},
		]);
		const { model, notices } = router({
			chat: chat.model,
			responses: responses.model,
		});

		const { stream } = await model.doStream(callOptions());

		expect(textOf(await collect(stream))).toBe("chat");
		expect(onCancel).toHaveBeenCalled();
		expect(notices.take().map((notice) => notice.kind)).toEqual([
			"responses_unavailable",
		]);
		expect(readProtocolDecision(KEY)?.status).toBeUndefined();
	});

	it("does not fall back once the Responses stream produced content", async () => {
		const chat = fakeModel("chat", [{ parts: textParts("chat") }]);
		const parts: LanguageModelV4StreamPart[] = [
			{ type: "stream-start", warnings: [] },
			{ type: "text-start", id: "t" },
			{ type: "text-delta", id: "t", delta: "partial" },
			{ type: "error", error: notFound() },
		];
		const responses = fakeModel("responses", [{ parts }]);
		const { model, notices } = router({
			chat: chat.model,
			responses: responses.model,
		});

		const { stream } = await model.doStream(callOptions());

		expect(await collect(stream)).toEqual(parts);
		expect(chat.calls).toHaveLength(0);
		expect(notices.take()).toEqual([]);
	});

	it("passes an unrelated early error part through with the leading parts intact", async () => {
		const chat = fakeModel("chat", [{ parts: textParts("chat") }]);
		const parts: LanguageModelV4StreamPart[] = [
			{ type: "stream-start", warnings: [] },
			{ type: "response-metadata", id: "r1" },
			{ type: "error", error: { type: "error", code: "server_error" } },
		];
		const responses = fakeModel("responses", [{ parts }]);
		const { model } = router({ chat: chat.model, responses: responses.model });

		const { stream } = await model.doStream(callOptions());

		expect(await collect(stream)).toEqual(parts);
		expect(chat.calls).toHaveLength(0);
	});

	it("keeps the leading parts when the Responses stream breaks before any output", async () => {
		const chat = fakeModel("chat", [{ parts: textParts("chat") }]);
		const broken = new Error("socket closed");
		let pulls = 0;
		const responses: LanguageModelV4 = {
			...fakeModel("responses", []).model,
			doStream: async () => ({
				stream: new ReadableStream<LanguageModelV4StreamPart>({
					pull(controller) {
						pulls += 1;
						if (pulls === 1) {
							controller.enqueue({ type: "stream-start", warnings: [] });
						} else {
							controller.error(broken);
						}
					},
				}),
			}),
		};
		const { model } = router({ chat: chat.model, responses });

		const { stream } = await model.doStream(callOptions());
		const reader = stream.getReader();

		expect((await reader.read()).value).toEqual({
			type: "stream-start",
			warnings: [],
		});
		await expect(reader.read()).rejects.toBe(broken);
		expect(chat.calls).toHaveLength(0);
	});

	it("re-sends once without reasoning when the endpoint rejects the replayed reasoning", async () => {
		const rejection = apiError({
			status: 400,
			body: '{"error":{"message":"The encrypted content for item rs_1 could not be verified.","param":"input"}}',
		});
		const chat = fakeModel("chat", [{ parts: textParts("chat") }]);
		const responses = fakeModel("responses", [
			{ throws: rejection },
			{ parts: textParts("responses") },
		]);
		const { model, notices } = router({
			chat: chat.model,
			responses: responses.model,
		});

		const { stream } = await model.doStream(callOptions(promptWithReasoning()));

		expect(textOf(await collect(stream))).toBe("responses");
		expect(responses.calls).toHaveLength(2);
		const resent = JSON.stringify(responses.calls[1]?.prompt);
		expect(resent).not.toContain('"type":"reasoning"');
		expect(resent).toContain("read_file");
		expect(chat.calls).toHaveLength(0);
		expect(notices.take()).toEqual([
			{
				kind: "reasoning_replay_dropped",
				message:
					"res.openai.azure.com rejected the model's earlier reasoning, so Cline resent the request without it.",
				metadata: {
					kind: "reasoning_replay_dropped",
					modelId: "gpt-6-luna",
					endpointHost: "res.openai.azure.com",
					apiProtocol: "auto",
					status: 400,
				},
			},
		]);
		expect(readProtocolDecision(KEY)).toBeUndefined();
	});

	it("drops rejected items up front on later calls instead of being refused again", async () => {
		const rejection = apiError({
			status: 400,
			body: '{"error":{"message":"The encrypted content for item rs_1 could not be verified.","param":"input"}}',
		});
		const responses = fakeModel("responses", [
			{ throws: rejection },
			{ parts: textParts("first") },
			{ parts: textParts("second") },
		]);
		const chat = fakeModel("chat", [{ parts: textParts("chat") }]);
		const first = router({ chat: chat.model, responses: responses.model });
		await collect(
			(await first.model.doStream(callOptions(promptWithReasoning()))).stream,
		);

		const second = router({ chat: chat.model, responses: responses.model });
		const { stream } = await second.model.doStream(
			callOptions(promptWithReasoning()),
		);

		expect(textOf(await collect(stream))).toBe("second");
		// Refused once, re-sent, then the next call went out without rs_1 at once.
		expect(responses.calls).toHaveLength(3);
		expect(JSON.stringify(responses.calls[2]?.prompt)).not.toContain("rs_1");
		expect(second.notices.take()).toEqual([]);
	});

	it("treats a replay rejection raised inside the stream like an HTTP one", async () => {
		const streamError = {
			message:
				"Item 'rs_1' of type 'reasoning' was provided without its required following item.",
			code: "invalid_request_error",
		};
		const responses = fakeModel("responses", [
			{
				parts: [
					{ type: "stream-start", warnings: [] },
					{ type: "error", error: streamError },
				],
			},
			{ parts: textParts("responses") },
		]);
		const chat = fakeModel("chat", [{ parts: textParts("chat") }]);
		const { model } = router({ chat: chat.model, responses: responses.model });

		const { stream } = await model.doStream(callOptions(promptWithReasoning()));

		expect(textOf(await collect(stream))).toBe("responses");
		expect(responses.calls).toHaveLength(2);
		expect(JSON.stringify(responses.calls[1]?.prompt)).not.toContain("rs_1");
	});

	it("re-sends without a reasoning summary when the organization may not get one, and remembers it", async () => {
		const refusal = apiError({
			status: 400,
			body: '{"error":{"message":"Your organization must be verified to generate reasoning summaries.","param":"reasoning.summary","code":"unsupported_value"}}',
		});
		expect(isReasoningSummaryRefusal(refusal)).toBe(true);
		const responses = fakeModel("responses", [
			{ throws: refusal },
			{ parts: textParts("first") },
			{ parts: textParts("second") },
		]);
		const chat = fakeModel("chat", [{ parts: textParts("chat") }]);
		const first = router({ chat: chat.model, responses: responses.model });

		const { stream } = await first.model.doStream(callOptions());

		expect(textOf(await collect(stream))).toBe("first");
		expect(
			responses.calls[0]?.providerOptions?.openai?.reasoningSummary,
		).toBeUndefined();
		expect(responses.calls[1]?.providerOptions?.openai).toMatchObject({
			reasoningSummary: null,
		});
		expect(chat.calls).toHaveLength(0);

		const second = router({ chat: chat.model, responses: responses.model });
		await collect((await second.model.doStream(callOptions())).stream);
		expect(responses.calls).toHaveLength(3);
		expect(responses.calls[2]?.providerOptions?.openai).toMatchObject({
			reasoningSummary: null,
		});
	});

	it("falls back on a key without the Responses permission in Auto only", async () => {
		const missingScope = () =>
			apiError({
				status: 401,
				body: '{"error":{"message":"You have insufficient permissions for this operation. Missing scopes: api.responses.write."}}',
			});
		expect(isResponsesPermissionRefusal(missingScope())).toBe(true);
		expect(
			isResponsesPermissionRefusal(
				apiError({
					status: 401,
					body: '{"error":{"message":"Incorrect API key provided"}}',
				}),
			),
		).toBe(false);

		const chat = fakeModel("chat", [{ parts: textParts("chat") }]);
		const auto = router({
			chat: chat.model,
			responses: fakeModel("responses", [{ throws: missingScope() }]).model,
		});
		expect(
			textOf(await collect((await auto.model.doStream(callOptions())).stream)),
		).toBe("chat");

		resetProtocolDecisions();
		const explicit = router({
			chat: chat.model,
			responses: fakeModel("responses", [{ throws: missingScope() }]).model,
			apiProtocol: "openai-responses",
		});
		await expect(explicit.model.doStream(callOptions())).rejects.toBeInstanceOf(
			APICallError,
		);
	});

	it("does not re-send a reasoning rejection when the prompt has no reasoning", async () => {
		const rejection = apiError({
			status: 404,
			body: '{"error":{"message":"Item with id \'rs_9\' not found."}}',
		});
		const chat = fakeModel("chat", [{ parts: textParts("chat") }]);
		const responses = fakeModel("responses", [{ throws: rejection }]);
		const { model, notices } = router({
			chat: chat.model,
			responses: responses.model,
		});

		await expect(model.doStream(callOptions())).rejects.toBe(rejection);
		expect(responses.calls).toHaveLength(1);
		expect(chat.calls).toHaveLength(0);
		expect(notices.take()).toEqual([]);
	});

	it("routes generate calls the same way", async () => {
		const chat = fakeModel("chat", [{ parts: textParts("chat") }]);
		const responses = fakeModel("responses", [{ throws: notFound() }]);
		const { model, notices } = router({
			chat: chat.model,
			responses: responses.model,
		});

		const result = await model.doGenerate(callOptions());

		expect(result.content).toEqual([{ type: "text", text: "chat" }]);
		expect(notices.take().map((notice) => notice.kind)).toEqual([
			"responses_unavailable",
		]);
		expect(readProtocolDecision(KEY)?.protocol).toBe("chat");
	});

	it("re-probes the Responses API after the decision expires", async () => {
		let clock = 1_000;
		const chat = fakeModel("chat", [{ parts: textParts("chat") }]);
		const responses = fakeModel("responses", [
			{ throws: notFound() },
			{ parts: textParts("responses") },
		]);
		const first = router({
			chat: chat.model,
			responses: responses.model,
			now: () => clock,
		});
		await collect((await first.model.doStream(callOptions())).stream);
		expect(readProtocolDecision(KEY, clock)).toBeDefined();

		clock += PROTOCOL_DECISION_TTL_MS + 1;
		const later = router({
			chat: chat.model,
			responses: responses.model,
			now: () => clock,
		});
		const { stream } = await later.model.doStream(callOptions());

		expect(textOf(await collect(stream))).toBe("responses");
		expect(responses.calls).toHaveLength(2);
		expect(later.notices.take()).toEqual([]);
	});
});

describe("responsesUnavailableNotice", () => {
	const subject = {
		modelId: "gpt-6-luna",
		endpointHost: "res.openai.azure.com",
	};

	it("points Azure deployment URLs at the v1 base URL", () => {
		const notice = responsesUnavailableNotice(
			{ ...subject, apiProtocol: "openai-responses", azureDeploymentUrl: true },
			404,
		);
		expect(notice.message).toContain("Azure deployment URLs");
		expect(notice.message).toContain(
			"set the base URL to https://res.openai.azure.com/openai/v1",
		);
		expect(notice.metadata).not.toHaveProperty("azureDeploymentUrl");
	});

	it("keeps the settings hint for other explicit choices", () => {
		const notice = responsesUnavailableNotice(
			{ ...subject, apiProtocol: "openai-responses" },
			404,
		);
		expect(notice.message).toContain(
			"You can change this under API in the OpenAI Compatible settings.",
		);
	});
});

describe("createResponsesRouteCheckFetch", () => {
	const streamed = { method: "POST", body: JSON.stringify({ stream: true }) };

	it("turns a 200 JSON error for /responses into a 404 (LM Studio)", async () => {
		const base = vi.fn(
			async () =>
				new Response(
					'{"error":"Unexpected endpoint or method. (POST /v1/responses)"}',
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		const response = await createResponsesRouteCheckFetch(base as never)(
			"http://localhost:1234/v1/responses",
			streamed,
		);
		expect(response.status).toBe(404);
		expect(await response.text()).toContain("Unexpected endpoint");
	});

	it("passes event streams, other URLs and non-streamed requests through", async () => {
		const sse = new Response("data: {}\n\n", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
		const fetchSse = createResponsesRouteCheckFetch((async () => sse) as never);
		expect(await fetchSse("http://localhost:1234/v1/responses", streamed)).toBe(
			sse,
		);

		const jsonError = () =>
			new Response('{"error":"x"}', {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		const fetchJson = createResponsesRouteCheckFetch((async () =>
			jsonError()) as never);
		expect(
			(await fetchJson("http://localhost:1234/v1/chat/completions", streamed))
				.status,
		).toBe(200);
		expect(
			(
				await fetchJson("http://localhost:1234/v1/responses", {
					method: "POST",
					body: JSON.stringify({ stream: false }),
				})
			).status,
		).toBe(200);
	});
});

describe("protocol decision memory", () => {
	beforeEach(() => resetProtocolDecisions());

	it("keys decisions by endpoint origin, base path and model", () => {
		expect(
			protocolDecisionKey(
				"https://res.openai.azure.com/openai/v1/",
				"gpt-6-luna",
			),
		).toBe(KEY);
		expect(protocolDecisionKey("not a url/", "m")).toBe("not a url|m");
	});

	it("evicts the oldest decision beyond 512 entries", () => {
		for (let index = 0; index <= 512; index += 1) {
			recordProtocolDecision(`key-${index}`, 404, 1_000);
		}
		expect(readProtocolDecision("key-0", 1_000)).toBeUndefined();
		expect(readProtocolDecision("key-1", 1_000)).toBeDefined();
		expect(readProtocolDecision("key-512", 1_000)).toBeDefined();
	});
});

describe("reasoning strip helpers", () => {
	it("removes only Responses reasoning, and keeps the prompt object when nothing matches", () => {
		const prompt = promptWithReasoning();
		const stripped = stripResponsesReasoning(prompt);
		expect(JSON.stringify(stripped)).not.toContain("rs_1");
		expect(JSON.stringify(stripped)).toContain("Chat-side thinking.");
		expect(stripResponsesReasoning(stripped)).toBe(stripped);
	});

	it("drops an assistant message left empty", () => {
		const prompt: LanguageModelV4Prompt = [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "assistant", content: [responsesReasoning] },
			{ role: "user", content: [{ type: "text", text: "again" }] },
		];
		expect(stripResponsesReasoning(prompt).map((m) => m.role)).toEqual([
			"user",
			"user",
		]);
	});

	it("removes every reasoning part for a replay re-send", () => {
		const stripped = stripAllReasoning(promptWithReasoning());
		expect(JSON.stringify(stripped)).not.toContain('"type":"reasoning"');
	});

	it("strips Responses reasoning as chat middleware", async () => {
		const transform = (params: LanguageModelV4CallOptions) =>
			stripResponsesReasoningMiddleware.transformParams?.({
				type: "stream",
				params,
				model: {} as LanguageModelV4,
			});
		const transformed = await transform(callOptions(promptWithReasoning()));
		expect(JSON.stringify(transformed?.prompt)).not.toContain("rs_1");
		const untouched = callOptions();
		expect(await transform(untouched)).toBe(untouched);
	});
});
