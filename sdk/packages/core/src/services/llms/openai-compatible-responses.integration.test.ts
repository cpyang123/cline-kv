// Cross-layer coverage for GPT-6 on Azure OpenAI through the built-in OpenAI
// Compatible provider: providers.json settings (toProviderConfig) -> core
// handler factory -> the real @cline/llms gateway, router and AI SDK adapters
// -> the real AgentRuntime -> the core message codec, with fetch stubbed at
// the network boundary. Each test uses its own Azure resource host because
// the router's protocol decisions and the kv.6 reasoning fallback are
// remembered per endpoint + model for the whole process.
import { AgentRuntime } from "@cline/agents";
import type { AgentMessage, AgentRuntimeEvent, AgentTool } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import {
	agentMessagesToMessagesWithMetadata,
	messagesToAgentMessages,
} from "../../runtime/config/agent-message-codec";
import { createAgentModelFromConfig } from "./handler-factory";
import { toProviderConfig } from "./provider-settings";

const MODEL_ID = "gpt-6-luna";
const REFUSAL_MESSAGE =
	"Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.";

let hostCounter = 0;
function azureBaseUrl(): string {
	hostCounter += 1;
	return `https://kv-it-${hostCounter}-${Date.now()}.openai.azure.com/openai/v1`;
}

// ---------------------------------------------------------------------------
// Wire fixtures

function sse(events: Record<string, unknown>[]): string {
	return events
		.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
		.join("");
}

function sseResponse(body: string): Response {
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

const responseUsage = {
	input_tokens: 10,
	output_tokens: 5,
	input_tokens_details: { cached_tokens: 0 },
	output_tokens_details: { reasoning_tokens: 4 },
};

/** A Responses turn: one reasoning item (summary + encrypted content), then a call. */
function responsesReasoningAndCall(): Response {
	return sseResponse(
		sse([
			{
				type: "response.created",
				response: { id: "resp_1", created_at: 1, model: MODEL_ID },
			},
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "rs_1", encrypted_content: null },
			},
			{
				type: "response.reasoning_summary_part.added",
				item_id: "rs_1",
				output_index: 0,
				summary_index: 0,
			},
			{
				type: "response.reasoning_summary_text.delta",
				item_id: "rs_1",
				output_index: 0,
				summary_index: 0,
				delta: "Echo the greeting first.",
			},
			{
				type: "response.reasoning_summary_part.done",
				item_id: "rs_1",
				output_index: 0,
				summary_index: 0,
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "reasoning", id: "rs_1", encrypted_content: "enc-1" },
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: {
					type: "function_call",
					id: "fc_1",
					call_id: "call_1",
					name: "echo",
					arguments: "",
				},
			},
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_1",
				output_index: 1,
				delta: '{"text":"hi"}',
			},
			{
				type: "response.output_item.done",
				output_index: 1,
				item: {
					type: "function_call",
					id: "fc_1",
					call_id: "call_1",
					name: "echo",
					arguments: '{"text":"hi"}',
					status: "completed",
				},
			},
			{
				type: "response.completed",
				response: { incomplete_details: null, usage: responseUsage },
			},
		]),
	);
}

function responsesText(text: string): Response {
	return sseResponse(
		sse([
			{
				type: "response.created",
				response: { id: "resp_2", created_at: 2, model: MODEL_ID },
			},
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg_1" },
			},
			{
				type: "response.output_text.delta",
				item_id: "msg_1",
				output_index: 0,
				delta: text,
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "message", id: "msg_1" },
			},
			{
				type: "response.completed",
				response: { incomplete_details: null, usage: responseUsage },
			},
		]),
	);
}

function chatChunks(chunks: Record<string, unknown>[]): Response {
	return sseResponse(
		`${chunks
			.map(
				(chunk) =>
					`data: ${JSON.stringify({
						id: "chatcmpl-1",
						object: "chat.completion.chunk",
						created: 1,
						model: MODEL_ID,
						...chunk,
					})}\n\n`,
			)
			.join("")}data: [DONE]\n\n`,
	);
}

const chatUsage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

function chatToolCall(): Response {
	return chatChunks([
		{
			choices: [
				{
					index: 0,
					delta: {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: "call_1",
								type: "function",
								function: { name: "echo", arguments: '{"text":"hi"}' },
							},
						],
					},
					finish_reason: null,
				},
			],
		},
		{
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			usage: chatUsage,
		},
	]);
}

function chatText(text: string): Response {
	return chatChunks([
		{
			choices: [
				{
					index: 0,
					delta: { role: "assistant", content: text },
					finish_reason: null,
				},
			],
		},
		{
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: chatUsage,
		},
	]);
}

function chatRefusal(): Response {
	return Response.json(
		{
			error: {
				message: REFUSAL_MESSAGE,
				type: "invalid_request_error",
				param: "reasoning_effort",
				code: "unsupported_parameter",
			},
		},
		{ status: 400 },
	);
}

// ---------------------------------------------------------------------------
// Harness

interface WireCall {
	path: string;
	body: Record<string, unknown>;
	authorization: string | null;
}

/** A fetch that answers each request from the handler for its URL path. */
function createWire(
	handler: (path: string, body: Record<string, unknown>) => Response,
) {
	const calls: WireCall[] = [];
	const fetchMock = vi.fn(
		async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const url = new URL(
				typeof input === "string" || input instanceof URL
					? String(input)
					: input.url,
			);
			const body = JSON.parse(String(init?.body ?? "{}")) as Record<
				string,
				unknown
			>;
			calls.push({
				path: url.pathname,
				body,
				authorization: new Headers(init?.headers).get("authorization"),
			});
			return handler(url.pathname, body);
		},
	);
	return { calls, fetch: fetchMock as unknown as typeof fetch };
}

const echoTool = {
	name: "echo",
	description: "Echo input text",
	inputSchema: {
		type: "object",
		properties: { text: { type: "string" } },
		required: ["text"],
	},
	async execute(input: unknown) {
		return { echoed: (input as { text: string }).text };
	},
} satisfies AgentTool;

function createModel(input: {
	baseUrl: string;
	fetch: typeof fetch;
	protocol?: "openai-chat" | "openai-responses";
	logger: ReturnType<typeof createLogger>;
}) {
	// The providers.json entry the extension writes for the built-in provider.
	const providerConfig = toProviderConfig({
		provider: "openai-compatible",
		model: MODEL_ID,
		apiKey: "azure-test-key",
		baseUrl: input.baseUrl,
		...(input.protocol ? { protocol: input.protocol } : {}),
	});
	return createAgentModelFromConfig(
		{
			providerId: providerConfig.providerId,
			modelId: providerConfig.modelId,
			providerConfig: { ...providerConfig, fetch: input.fetch },
			systemPrompt: "You are a test agent.",
			tools: [echoTool],
		},
		{ ...input.logger, error: vi.fn<(message: string) => void>() },
	);
}

// What core's runtime config builder sends on every request for a session
// with reasoning effort "medium" (buildModelOptions).
const modelOptions = { reasoningEffort: "medium" };

function createLogger() {
	return {
		debug: vi.fn<(message: string, metadata?: unknown) => void>(),
		log: vi.fn<(message: string, metadata?: unknown) => void>(),
	};
}

/**
 * Everything the stack logged or warned, to look for adapter warnings. The AI
 * SDK reports call warnings through process.emitWarning (console.warn where
 * that is unavailable).
 */
function loggedText(
	logger: ReturnType<typeof createLogger>,
	...spies: Array<{ mock: { calls: unknown[][] } }>
): string {
	return JSON.stringify([
		logger.debug.mock.calls,
		logger.log.mock.calls,
		...spies.map((spy) => spy.mock.calls),
	]);
}

function statusNotices(events: AgentRuntimeEvent[]) {
	return events.flatMap((event) =>
		event.type === "status-notice"
			? [{ message: event.message, metadata: event.metadata }]
			: [],
	);
}

/** Persist and reload a history the way core sessions do (codec + JSON). */
function roundTripThroughCodec(messages: readonly AgentMessage[]) {
	const stored = JSON.parse(
		JSON.stringify(agentMessagesToMessagesWithMetadata(messages)),
	);
	return messagesToAgentMessages(stored);
}

function inputItemTypes(body: Record<string, unknown>): string[] {
	return (body.input as Array<{ type?: string; role?: string }>).map(
		(item) => item.type ?? `message:${item.role}`,
	);
}

// ---------------------------------------------------------------------------

describe("GPT-6 on Azure OpenAI through the built-in OpenAI Compatible provider", () => {
	it("runs a tool turn on /responses and replays the encrypted reasoning item, also after a codec round trip", async () => {
		const baseUrl = azureBaseUrl();
		const responses = [
			responsesReasoningAndCall(),
			responsesText("done"),
			responsesText("again"),
		];
		const wire = createWire((path) => {
			if (path.endsWith("/responses")) {
				const next = responses.shift();
				if (next) return next;
			}
			return new Response("unexpected", { status: 500 });
		});
		const logger = createLogger();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const emitWarning = vi
			.spyOn(process, "emitWarning")
			.mockImplementation(() => {});
		try {
			const model = createModel({ baseUrl, fetch: wire.fetch, logger });
			const runtime = new AgentRuntime({
				model,
				tools: [echoTool],
				modelOptions,
			});
			const events: AgentRuntimeEvent[] = [];
			runtime.subscribe((event) => events.push(event));

			const result = await runtime.run("say hi");

			expect(result.status).toBe("completed");
			expect(result.outputText).toBe("done");
			expect(wire.calls.map((call) => call.path)).toEqual([
				"/openai/v1/responses",
				"/openai/v1/responses",
			]);
			const [first, second] = wire.calls;
			expect(first?.authorization).toBe("Bearer azure-test-key");
			expect(first?.body).toMatchObject({
				model: MODEL_ID,
				store: false,
				include: ["reasoning.encrypted_content"],
				reasoning: { effort: "medium" },
			});
			expect(first?.body.truncation).toBeUndefined();
			expect(first?.body.tools).toEqual([
				expect.objectContaining({
					type: "function",
					name: "echo",
					strict: false,
				}),
			]);

			// The follow-up after the tool result, built from the runtime's own
			// history: the reasoning item precedes the call and its output.
			const secondInput = second?.body.input as Array<Record<string, unknown>>;
			expect(inputItemTypes(second?.body ?? {})).toEqual([
				"message:user",
				"reasoning",
				"function_call",
				"function_call_output",
			]);
			expect(secondInput[1]).toEqual({
				type: "reasoning",
				id: "rs_1",
				encrypted_content: "enc-1",
				summary: [{ type: "summary_text", text: "Echo the greeting first." }],
			});
			expect(secondInput[2]).toMatchObject({
				type: "function_call",
				call_id: "call_1",
				name: "echo",
			});
			expect(secondInput[3]).toMatchObject({
				type: "function_call_output",
				call_id: "call_1",
			});
			expect(statusNotices(events)).toEqual([]);

			// A persisted and reloaded session sends the same item on the next turn.
			const reloaded = roundTripThroughCodec(result.messages);
			const resumed = new AgentRuntime({
				model,
				tools: [echoTool],
				modelOptions,
				initialMessages: reloaded,
			});
			const resumedResult = await resumed.continue("and again");
			expect(resumedResult.status).toBe("completed");
			const third = wire.calls[2];
			expect(third?.path).toBe("/openai/v1/responses");
			expect(inputItemTypes(third?.body ?? {})).toEqual([
				"message:user",
				"reasoning",
				"function_call",
				"function_call_output",
				"message:assistant",
				"message:user",
			]);
			expect((third?.body.input as unknown[])[1]).toEqual(secondInput[1]);

			expect(loggedText(logger, warn, emitWarning)).not.toContain(
				"Non-OpenAI reasoning parts",
			);
		} finally {
			warn.mockRestore();
			emitWarning.mockRestore();
		}
	});

	it("falls back to /chat/completions when /responses answers 404, with one status notice per kind", async () => {
		const baseUrl = azureBaseUrl();
		const wire = createWire((path, body) => {
			if (path.endsWith("/responses")) {
				return Response.json(
					{ error: { code: "404", message: "Resource not found" } },
					{ status: 404 },
				);
			}
			if (path.endsWith("/chat/completions")) {
				if (body.tools && body.reasoning_effort !== "none") {
					return chatRefusal();
				}
				const messages = body.messages as Array<{ role: string }>;
				return messages.some((message) => message.role === "tool")
					? chatText("done")
					: chatToolCall();
			}
			return new Response("unexpected", { status: 500 });
		});
		const logger = createLogger();
		const model = createModel({ baseUrl, fetch: wire.fetch, logger });
		const runtime = new AgentRuntime({
			model,
			tools: [echoTool],
			modelOptions,
		});
		const events: AgentRuntimeEvent[] = [];
		runtime.subscribe((event) => events.push(event));

		const result = await runtime.run("say hi");

		expect(result.status).toBe("completed");
		expect(result.outputText).toBe("done");
		expect(
			wire.calls.map((call) => [call.path, call.body.reasoning_effort ?? null]),
		).toEqual([
			// Turn 1: Responses unsupported, then the kv.6 refusal and re-send.
			["/openai/v1/responses", null],
			["/openai/v1/chat/completions", "medium"],
			["/openai/v1/chat/completions", "none"],
			// Turn 2: both decisions remembered.
			["/openai/v1/chat/completions", "none"],
		]);
		// No Responses-only options leak into Chat Completions bodies.
		for (const call of wire.calls.slice(1)) {
			expect(call.body.store).toBeUndefined();
			expect(call.body.include).toBeUndefined();
		}

		const host = new URL(baseUrl).host;
		expect(statusNotices(events)).toEqual([
			{
				message: `${host} doesn't support the Responses API for ${MODEL_ID}, so Cline is using Chat Completions instead.`,
				metadata: expect.objectContaining({
					kind: "responses_unavailable",
					modelId: MODEL_ID,
					endpointHost: host,
					apiProtocol: "auto",
				}),
			},
			{
				message: `${MODEL_ID} doesn't accept tools with reasoning on Chat Completions, so Cline is sending its tool requests with reasoning turned off.`,
				metadata: expect.objectContaining({
					kind: "reasoning_disabled_for_tools",
					modelId: MODEL_ID,
					endpointHost: host,
				}),
			},
		]);
	});

	it("keeps everything on /chat/completions for providers.json protocol openai-chat", async () => {
		const baseUrl = azureBaseUrl();
		const wire = createWire((path, body) => {
			if (path.endsWith("/chat/completions")) {
				if (body.tools && body.reasoning_effort !== "none") {
					return chatRefusal();
				}
				const messages = body.messages as Array<{ role: string }>;
				return messages.some((message) => message.role === "tool")
					? chatText("done")
					: chatToolCall();
			}
			return new Response("unexpected", { status: 500 });
		});
		const logger = createLogger();
		const model = createModel({
			baseUrl,
			fetch: wire.fetch,
			protocol: "openai-chat",
			logger,
		});
		const runtime = new AgentRuntime({
			model,
			tools: [echoTool],
			modelOptions,
		});
		const events: AgentRuntimeEvent[] = [];
		runtime.subscribe((event) => events.push(event));

		const result = await runtime.run("say hi");

		expect(result.status).toBe("completed");
		expect(wire.calls.length).toBeGreaterThan(0);
		expect(
			wire.calls.every((call) => call.path === "/openai/v1/chat/completions"),
		).toBe(true);
		// Only the kv.6 degradation is announced; Responses was never tried.
		expect(
			statusNotices(events).map(
				(notice) => (notice.metadata as { kind?: string }).kind,
			),
		).toEqual(["reasoning_disabled_for_tools"]);
	});
});
