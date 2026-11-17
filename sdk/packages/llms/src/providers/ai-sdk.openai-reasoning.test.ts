import { createOpenAI } from "@ai-sdk/openai";
import type {
	JSONValue,
	LanguageModelV4,
	LanguageModelV4CallOptions,
	LanguageModelV4StreamPart,
	SharedV4ProviderMetadata,
} from "@ai-sdk/provider";
import type {
	AgentMessage,
	AgentMessagePart,
	AgentModelEvent,
	AgentToolDefinition,
	GatewayProviderContext,
	GatewayStreamRequest,
	ReasoningPartMetadata,
} from "@cline/shared";
import { wrapLanguageModel } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleProvider } from "./ai-sdk";
import type { ProviderFactoryResult } from "./vendors/types";

/**
 * OpenAI Responses reasoning round trip through the gateway: reasoning item
 * metadata captured from the stream (`emitAiSdkEvents`) and replayed on the
 * next request (`toAiSdkMessages`). The vendor module is replaced so each
 * test controls the model: a scripted LanguageModelV4, or the real
 * @ai-sdk/openai Responses model over a stubbed fetch.
 */

const vendor = vi.hoisted(() => ({
	create: undefined as
		| undefined
		| ((config: { fetch?: typeof fetch }) => ProviderFactoryResult),
}));

vi.mock("./vendors/openai-compatible", () => ({
	createOpenAICompatibleProviderModule: (config: { fetch?: typeof fetch }) => {
		if (!vendor.create) throw new Error("test vendor not configured");
		return vendor.create(config);
	},
}));

const PROVIDER_ID = "openai-compatible";
const MODEL_ID = "gpt-6-luna";

const READ_FILES_TOOL: AgentToolDefinition = {
	name: "read_files",
	description: "Read files",
	inputSchema: {
		type: "object",
		properties: { files: { type: "array", items: { type: "string" } } },
		required: ["files"],
	},
};

const usage = {
	inputTokens: {
		total: 1,
		noCache: undefined,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: 1, text: undefined, reasoning: undefined },
} as never;

function context(
	providerId = PROVIDER_ID,
	baseUrl?: string,
	metadata: Record<string, unknown> = { openaiResponses: "auto" },
): GatewayProviderContext {
	const model = { id: MODEL_ID, providerId, name: MODEL_ID };
	return {
		provider: {
			id: providerId,
			name: providerId,
			defaultModelId: MODEL_ID,
			models: [model],
			metadata,
		},
		model,
		config: { providerId, ...(baseUrl ? { baseUrl } : {}) },
	} as unknown as GatewayProviderContext;
}

function userMessage(text: string): AgentMessage {
	return {
		id: `user_${text}`,
		role: "user",
		content: [{ type: "text", text }],
		createdAt: Date.now(),
	};
}

function request(
	messages: AgentMessage[],
	overrides: Partial<GatewayStreamRequest> = {},
): GatewayStreamRequest {
	return {
		providerId: PROVIDER_ID,
		modelId: MODEL_ID,
		messages,
		tools: [READ_FILES_TOOL],
		...overrides,
	};
}

async function collect(
	iterable: AsyncIterable<AgentModelEvent>,
): Promise<AgentModelEvent[]> {
	const events: AgentModelEvent[] = [];
	for await (const event of iterable) events.push(event);
	return events;
}

async function stream(
	req: GatewayStreamRequest,
	ctx: GatewayProviderContext = context(),
): Promise<AgentModelEvent[]> {
	const provider = await createOpenAICompatibleProvider({
		providerId: ctx.provider.id,
	});
	return collect(await provider.stream(req, ctx));
}

/** A model that records each call and streams the given parts. */
function scriptedModel(
	parts: LanguageModelV4StreamPart[],
	calls: LanguageModelV4CallOptions[] = [],
): LanguageModelV4 {
	return {
		specificationVersion: "v4",
		provider: "test",
		modelId: MODEL_ID,
		supportedUrls: {},
		doGenerate: async () => {
			throw new Error("doGenerate is not used by the streaming path");
		},
		doStream: async (options) => {
			calls.push(options);
			return {
				stream: new ReadableStream<LanguageModelV4StreamPart>({
					start(controller) {
						for (const part of parts) controller.enqueue(part);
						controller.close();
					},
				}),
			};
		},
	};
}

function useScriptedModel(
	parts: LanguageModelV4StreamPart[],
): LanguageModelV4CallOptions[] {
	const calls: LanguageModelV4CallOptions[] = [];
	vendor.create = () => ({
		operations: { language: () => scriptedModel(parts, calls) },
		retryEmptyResponses: false,
	});
	return calls;
}

const reasoningEvents = (events: AgentModelEvent[]) =>
	events.filter(
		(event): event is Extract<AgentModelEvent, { type: "reasoning-delta" }> =>
			event.type === "reasoning-delta",
	);

const finishParts: LanguageModelV4StreamPart[] = [
	{
		type: "tool-call",
		toolCallId: "call_1",
		toolName: "read_files",
		input: '{"files":["a.ts"]}',
	},
	{
		type: "finish",
		finishReason: { unified: "tool-calls", raw: undefined },
		usage,
	},
];

/** How @ai-sdk/openai 4.0.91 streams reasoning items with `store: false`. */
function statelessReasoningParts(
	namespace: "openai" | "azure",
): LanguageModelV4StreamPart[] {
	const meta = (
		value: Record<string, JSONValue>,
	): SharedV4ProviderMetadata => ({
		[namespace]: value,
	});
	return [
		{ type: "stream-start", warnings: [] },
		// Item with two summary parts; encrypted content only at the end.
		{
			type: "reasoning-start",
			id: "rs_1:0",
			providerMetadata: meta({
				itemId: "rs_1",
				reasoningEncryptedContent: null,
			}),
		},
		{
			type: "reasoning-delta",
			id: "rs_1:0",
			delta: "Plan A",
			providerMetadata: meta({ itemId: "rs_1" }),
		},
		{
			type: "reasoning-end",
			id: "rs_1:0",
			providerMetadata: meta({ itemId: "rs_1" }),
		},
		{
			type: "reasoning-start",
			id: "rs_1:1",
			providerMetadata: meta({
				itemId: "rs_1",
				reasoningEncryptedContent: null,
			}),
		},
		{
			type: "reasoning-delta",
			id: "rs_1:1",
			delta: "Plan B",
			providerMetadata: meta({ itemId: "rs_1" }),
		},
		{
			type: "reasoning-end",
			id: "rs_1:1",
			providerMetadata: meta({
				itemId: "rs_1",
				reasoningEncryptedContent: "enc-1",
			}),
		},
		// Item without summary text.
		{
			type: "reasoning-start",
			id: "rs_2:0",
			providerMetadata: meta({
				itemId: "rs_2",
				reasoningEncryptedContent: null,
			}),
		},
		{
			type: "reasoning-end",
			id: "rs_2:0",
			providerMetadata: meta({
				itemId: "rs_2",
				reasoningEncryptedContent: "enc-2",
			}),
		},
		...finishParts,
	];
}

describe("OpenAI Responses reasoning capture", () => {
	beforeEach(() => {
		vendor.create = undefined;
	});

	it.each([
		"openai",
		"azure",
	] as const)("captures item ids and encrypted content from %s metadata", async (namespace) => {
		useScriptedModel(statelessReasoningParts(namespace));
		const events = await stream(request([userMessage("read a.ts")]));

		const origin = { providerId: PROVIDER_ID, modelId: MODEL_ID };
		expect(reasoningEvents(events)).toEqual([
			{
				type: "reasoning-delta",
				text: "Plan A",
				itemId: "rs_1",
				metadata: { openaiResponses: { itemId: "rs_1", ...origin } },
			},
			{
				type: "reasoning-delta",
				text: "\n\nPlan B",
				itemId: "rs_1",
				metadata: { openaiResponses: { itemId: "rs_1", ...origin } },
			},
			{
				type: "reasoning-delta",
				text: "",
				itemId: "rs_1",
				metadata: {
					openaiResponses: {
						itemId: "rs_1",
						encryptedContent: "enc-1",
						...origin,
					},
				},
			},
			{
				type: "reasoning-delta",
				text: "",
				itemId: "rs_2",
				metadata: {
					openaiResponses: {
						itemId: "rs_2",
						encryptedContent: "enc-2",
						...origin,
					},
				},
			},
		]);
		// Reasoning comes before the tool call it led to.
		const toolIndex = events.findIndex(
			(event) => event.type === "tool-call-delta",
		);
		const lastReasoningIndex = events.reduce(
			(last, event, index) => (event.type === "reasoning-delta" ? index : last),
			-1,
		);
		expect(toolIndex).toBeGreaterThan(lastReasoningIndex);
	});

	it("records an item that ended without summary text or encrypted content (store: true)", async () => {
		useScriptedModel([
			{ type: "stream-start", warnings: [] },
			{
				type: "reasoning-start",
				id: "rs_1:0",
				providerMetadata: {
					openai: { itemId: "rs_1", reasoningEncryptedContent: null },
				},
			},
			{
				type: "reasoning-delta",
				id: "rs_1:0",
				delta: "Thinking",
				providerMetadata: { openai: { itemId: "rs_1" } },
			},
			{
				type: "reasoning-end",
				id: "rs_1:0",
				providerMetadata: { openai: { itemId: "rs_1" } },
			},
			{
				type: "reasoning-start",
				id: "rs_2:0",
				providerMetadata: {
					openai: { itemId: "rs_2", reasoningEncryptedContent: null },
				},
			},
			{
				type: "reasoning-end",
				id: "rs_2:0",
				providerMetadata: {
					openai: { itemId: "rs_2", reasoningEncryptedContent: null },
				},
			},
			...finishParts,
		]);
		const events = await stream(request([userMessage("go")]));

		expect(
			reasoningEvents(events).map((event) => [
				event.itemId,
				event.text,
				(event.metadata as ReasoningPartMetadata).openaiResponses
					?.encryptedContent,
			]),
		).toEqual([
			// A text item with nothing new at its end gets no extra event.
			["rs_1", "Thinking", undefined],
			["rs_2", "", undefined],
		]);
	});

	it("streams reasoning text as before for providers without the Responses router", async () => {
		useScriptedModel(statelessReasoningParts("openai"));
		const events = await stream(
			request([userMessage("read a.ts")]),
			context(PROVIDER_ID, undefined, {}),
		);

		expect(reasoningEvents(events)).toEqual([
			{ type: "reasoning-delta", text: "Plan A" },
			{ type: "reasoning-delta", text: "Plan B" },
		]);
	});

	it("leaves non-OpenAI reasoning as before", async () => {
		useScriptedModel([
			{ type: "stream-start", warnings: [] },
			{ type: "reasoning-start", id: "r0" },
			{
				type: "reasoning-delta",
				id: "r0",
				delta: "Thinking",
				providerMetadata: { google: { thoughtSignature: "sig" } },
			},
			{ type: "reasoning-delta", id: "r0", delta: "" },
			{ type: "reasoning-end", id: "r0" },
			...finishParts,
		]);
		const events = await stream(request([userMessage("go")]));

		expect(reasoningEvents(events)).toEqual([
			{
				type: "reasoning-delta",
				text: "Thinking",
				metadata: { thoughtSignature: "sig" },
			},
		]);
	});
});

function assistantWithReasoning(parts: AgentMessagePart[]): AgentMessage {
	return {
		id: "assistant_1",
		role: "assistant",
		content: [
			...parts,
			{
				type: "tool-call",
				toolCallId: "call_1",
				toolName: "read_files",
				input: { files: ["a.ts"] },
			},
		],
		createdAt: Date.now(),
	};
}

const toolResult: AgentMessage = {
	id: "tool_1",
	role: "tool",
	content: [
		{
			type: "tool-result",
			toolCallId: "call_1",
			toolName: "read_files",
			output: "contents",
		},
	],
	createdAt: Date.now(),
};

function openaiPart(
	itemId: string,
	text: string,
	origin: { providerId?: string; modelId?: string; endpoint?: string } = {
		providerId: PROVIDER_ID,
		modelId: MODEL_ID,
	},
	encryptedContent?: string,
): AgentMessagePart {
	return {
		type: "reasoning",
		text,
		metadata: {
			openaiResponses: {
				itemId,
				...(encryptedContent ? { encryptedContent } : {}),
				...origin,
			},
		} satisfies ReasoningPartMetadata,
	};
}

const textOnlyParts: LanguageModelV4StreamPart[] = [
	{ type: "stream-start", warnings: [] },
	{ type: "text-start", id: "t" },
	{ type: "text-delta", id: "t", delta: "done" },
	{ type: "text-end", id: "t" },
	{ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
];

function assistantPromptParts(call: LanguageModelV4CallOptions | undefined) {
	const assistant = call?.prompt.filter(
		(message) => message.role === "assistant",
	);
	return assistant?.flatMap((message) =>
		Array.isArray(message.content) ? message.content : [],
	);
}

describe("OpenAI Responses reasoning replay", () => {
	beforeEach(() => {
		vendor.create = undefined;
	});

	it("replays matching items under both openai and azure, next to legacy parts", async () => {
		const calls = useScriptedModel(textOnlyParts);
		await stream(
			request([
				userMessage("read a.ts"),
				assistantWithReasoning([
					openaiPart("rs_1", "Plan A", undefined, "enc-1"),
					openaiPart("rs_2", "", undefined, "enc-2"),
					{
						type: "reasoning",
						text: "Signed thought",
						metadata: { signature: "anthropic-sig" },
					},
				]),
				toolResult,
			]),
		);

		const replay1 = { itemId: "rs_1", reasoningEncryptedContent: "enc-1" };
		const replay2 = { itemId: "rs_2", reasoningEncryptedContent: "enc-2" };
		expect(assistantPromptParts(calls[0])).toEqual([
			{
				type: "reasoning",
				text: "Plan A",
				providerOptions: { openai: replay1, azure: replay1 },
			},
			{
				type: "reasoning",
				text: "",
				providerOptions: { openai: replay2, azure: replay2 },
			},
			{
				type: "reasoning",
				text: "Signed thought",
				providerOptions: { anthropic: { signature: "anthropic-sig" } },
			},
			expect.objectContaining({ type: "tool-call", toolCallId: "call_1" }),
		]);
	});

	it("drops an item captured without encrypted content (it would need server-side storage)", async () => {
		const calls = useScriptedModel(textOnlyParts);
		await stream(
			request([
				userMessage("read a.ts"),
				assistantWithReasoning([
					openaiPart("rs_1", "Plan A"),
					openaiPart("rs_2", "Plan B", undefined, "enc-2"),
				]),
				toolResult,
			]),
		);

		const replay = { itemId: "rs_2", reasoningEncryptedContent: "enc-2" };
		expect(assistantPromptParts(calls[0])).toEqual([
			{
				type: "reasoning",
				text: "Plan B",
				providerOptions: { openai: replay, azure: replay },
			},
			expect.objectContaining({ type: "tool-call", toolCallId: "call_1" }),
		]);
	});

	it.each([
		["another model", { providerId: PROVIDER_ID, modelId: "gpt-6-sol" }],
		["another provider", { providerId: "openai-native", modelId: MODEL_ID }],
		["an unknown origin", {}],
		[
			"another endpoint",
			{
				providerId: PROVIDER_ID,
				modelId: MODEL_ID,
				endpoint: "https://other.openai.azure.com/openai/v1",
			},
		],
	])("drops items from %s and keeps legacy parts", async (_label, origin) => {
		const calls = useScriptedModel(textOnlyParts);
		await stream(
			request([
				userMessage("read a.ts"),
				assistantWithReasoning([
					openaiPart("rs_1", "Plan A", origin, "enc-1"),
					{
						type: "reasoning",
						text: "Signed thought",
						metadata: { signature: "anthropic-sig" },
					},
				]),
				toolResult,
			]),
		);

		expect(assistantPromptParts(calls[0])).toEqual([
			{
				type: "reasoning",
				text: "Signed thought",
				providerOptions: { anthropic: { signature: "anthropic-sig" } },
			},
			expect.objectContaining({ type: "tool-call", toolCallId: "call_1" }),
		]);
	});

	it("replays nothing for providers without the Responses router (codex, openai-native)", async () => {
		const calls = useScriptedModel(textOnlyParts);
		await stream(
			request([
				userMessage("read a.ts"),
				assistantWithReasoning([
					openaiPart("rs_1", "Plan A", undefined, "enc-1"),
				]),
				toolResult,
			]),
			context(PROVIDER_ID, undefined, {}),
		);
		expect(assistantPromptParts(calls[0])).toEqual([
			expect.objectContaining({ type: "tool-call", toolCallId: "call_1" }),
		]);
	});

	it("drops an item with no output after it (a turn that ended while reasoning)", async () => {
		const calls = useScriptedModel(textOnlyParts);
		const reasoningOnly: AgentMessage = {
			id: "assistant_cut",
			role: "assistant",
			content: [openaiPart("rs_cut", "Still thinking", undefined, "enc-cut")],
			createdAt: 1,
		};
		await stream(
			request([
				userMessage("read a.ts"),
				reasoningOnly,
				userMessage("continue"),
			]),
		);
		expect(
			calls[0]?.prompt.some(
				(message) =>
					message.role === "assistant" &&
					Array.isArray(message.content) &&
					message.content.some((part) => part.type === "reasoning"),
			),
		).toBe(false);
	});

	it("replays items to the endpoint that produced them, and only there", async () => {
		const endpoint = "https://contoso.openai.azure.com/openai/v1";
		const history = request([
			userMessage("read a.ts"),
			assistantWithReasoning([
				openaiPart(
					"rs_1",
					"Plan A",
					{ providerId: PROVIDER_ID, modelId: MODEL_ID, endpoint },
					"enc-1",
				),
			]),
			toolResult,
		]);

		const same = useScriptedModel(textOnlyParts);
		await stream(history, context(PROVIDER_ID, `${endpoint}/`));
		const replay = { itemId: "rs_1", reasoningEncryptedContent: "enc-1" };
		expect(assistantPromptParts(same[0])?.[0]).toEqual({
			type: "reasoning",
			text: "Plan A",
			providerOptions: { openai: replay, azure: replay },
		});

		const moved = useScriptedModel(textOnlyParts);
		await stream(history, context(PROVIDER_ID, "https://api.openai.com/v1"));
		expect(assistantPromptParts(moved[0])).toEqual([
			expect.objectContaining({ type: "tool-call", toolCallId: "call_1" }),
		]);
	});

	it("omits an assistant turn left empty by dropped items", async () => {
		const calls = useScriptedModel(textOnlyParts);
		await stream(
			request([
				userMessage("first"),
				{
					id: "assistant_reasoning_only",
					role: "assistant",
					content: [
						openaiPart("rs_1", "Plan A", {
							providerId: PROVIDER_ID,
							modelId: "gpt-6-sol",
						}),
					],
					createdAt: Date.now(),
				},
				userMessage("second"),
			]),
		);

		expect(
			calls[0]?.prompt.filter((message) => message.role === "assistant"),
		).toEqual([]);
	});

	it("folds a metadata-only part into the previous part of the same item", async () => {
		const calls = useScriptedModel(textOnlyParts);
		await stream(
			request([
				userMessage("read a.ts"),
				assistantWithReasoning([
					openaiPart("rs_1", "Plan A"),
					openaiPart("rs_1", "", undefined, "enc-1"),
				]),
				toolResult,
			]),
		);

		const replay = { itemId: "rs_1", reasoningEncryptedContent: "enc-1" };
		expect(assistantPromptParts(calls[0])?.slice(0, 2)).toEqual([
			{
				type: "reasoning",
				text: "Plan A",
				providerOptions: { openai: replay, azure: replay },
			},
			expect.objectContaining({ type: "tool-call" }),
		]);
	});
});

// ---------------------------------------------------------------------------
// The real Responses adapter over a stubbed fetch: what the next request puts
// on the wire.

function sse(events: Record<string, unknown>[]): string {
	return events
		.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
		.join("");
}

const responseUsage = {
	input_tokens: 10,
	output_tokens: 5,
	input_tokens_details: { cached_tokens: 0 },
	output_tokens_details: { reasoning_tokens: 4 },
};

const reasoningTurnSse = sse([
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
		delta: "Plan A",
	},
	{
		type: "response.reasoning_summary_part.done",
		item_id: "rs_1",
		output_index: 0,
		summary_index: 0,
	},
	{
		type: "response.reasoning_summary_part.added",
		item_id: "rs_1",
		output_index: 0,
		summary_index: 1,
	},
	{
		type: "response.reasoning_summary_text.delta",
		item_id: "rs_1",
		output_index: 0,
		summary_index: 1,
		delta: "Plan B",
	},
	{
		type: "response.reasoning_summary_part.done",
		item_id: "rs_1",
		output_index: 0,
		summary_index: 1,
	},
	{
		type: "response.output_item.done",
		output_index: 0,
		item: { type: "reasoning", id: "rs_1", encrypted_content: "enc-1" },
	},
	{
		type: "response.output_item.added",
		output_index: 1,
		item: { type: "reasoning", id: "rs_2", encrypted_content: null },
	},
	{
		type: "response.output_item.done",
		output_index: 1,
		item: { type: "reasoning", id: "rs_2", encrypted_content: "enc-2" },
	},
	{
		type: "response.output_item.added",
		output_index: 2,
		item: {
			type: "function_call",
			id: "fc_1",
			call_id: "call_1",
			name: "read_files",
			arguments: "",
		},
	},
	{
		type: "response.function_call_arguments.delta",
		item_id: "fc_1",
		output_index: 2,
		delta: '{"files":["a.ts"]}',
	},
	{
		type: "response.output_item.done",
		output_index: 2,
		item: {
			type: "function_call",
			id: "fc_1",
			call_id: "call_1",
			name: "read_files",
			arguments: '{"files":["a.ts"]}',
			status: "completed",
		},
	},
	{
		type: "response.completed",
		response: { incomplete_details: null, usage: responseUsage },
	},
]);

const textTurnSse = sse([
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
		delta: "done",
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
]);

/**
 * Assemble the assistant turn the way AgentRuntime does: one reasoning part
 * per item id, metadata merged so the encrypted content is never lost.
 */
function assembleAssistant(events: AgentModelEvent[]): AgentMessage {
	const content: AgentMessagePart[] = [];
	const items = new Map<
		string,
		Extract<AgentMessagePart, { type: "reasoning" }>
	>();
	for (const event of events) {
		if (event.type === "reasoning-delta" && event.itemId) {
			const existing = items.get(event.itemId);
			if (!existing) {
				const part = {
					type: "reasoning" as const,
					text: event.text,
					metadata: event.metadata,
				};
				items.set(event.itemId, part);
				content.push(part);
				continue;
			}
			existing.text += event.text;
			const previous = (existing.metadata as ReasoningPartMetadata)
				.openaiResponses;
			const next = (event.metadata as ReasoningPartMetadata).openaiResponses;
			existing.metadata = {
				openaiResponses: {
					...previous,
					...next,
					encryptedContent:
						next?.encryptedContent ?? previous?.encryptedContent,
				},
			};
		}
		if (event.type === "tool-call-delta" && event.toolCallId) {
			content.push({
				type: "tool-call",
				toolCallId: event.toolCallId,
				toolName: event.toolName ?? "tool",
				input: event.input ?? JSON.parse(event.inputText ?? "{}"),
			});
		}
	}
	return { id: "assistant_1", role: "assistant", content, createdAt: 1 };
}

describe("OpenAI Responses reasoning on the wire", () => {
	beforeEach(() => {
		vendor.create = undefined;
	});

	it.each([
		["openai-compatible", "openai"],
		["azure-resp", "azure"],
	])("sends %s items back as stateless reasoning input (%s namespace)", async (providerId) => {
		const bodies: Array<Record<string, unknown>> = [];
		const responses = [reasoningTurnSse, textTurnSse];
		const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)));
			return new Response(responses[bodies.length - 1], {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});
		vendor.create = (config) => ({
			operations: {
				language: (modelId) =>
					wrapLanguageModel({
						model: createOpenAI({
							name: providerId,
							apiKey: "test-key",
							baseURL: "https://example.openai.azure.com/openai/v1",
							fetch: config.fetch,
						}).responses(modelId),
						// What the openai-compatible Responses rule sets.
						middleware: {
							specificationVersion: "v4",
							transformParams: async ({ params }) => ({
								...params,
								providerOptions: {
									...params.providerOptions,
									openai: {
										...params.providerOptions?.openai,
										store: false,
										include: ["reasoning.encrypted_content"],
									},
								},
							}),
						},
					}),
			},
			retryEmptyResponses: false,
		});
		const ctx = {
			...context(providerId),
			config: { providerId, fetch: fetchMock },
		} as unknown as GatewayProviderContext;
		const provider = await createOpenAICompatibleProvider({
			providerId,
			fetch: fetchMock as unknown as typeof fetch,
		});

		const first = await collect(
			await provider.stream(
				request([userMessage("read a.ts")], { providerId }),
				ctx,
			),
		);
		expect(first.find((event) => event.type === "finish")).toMatchObject({
			reason: "tool-calls",
		});

		await collect(
			await provider.stream(
				request(
					[userMessage("read a.ts"), assembleAssistant(first), toolResult],
					{ providerId },
				),
				ctx,
			),
		);

		expect(bodies).toHaveLength(2);
		expect(bodies[1]?.include).toEqual(["reasoning.encrypted_content"]);
		expect(bodies[1]?.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "read a.ts" }] },
			{
				type: "reasoning",
				id: "rs_1",
				encrypted_content: "enc-1",
				summary: [{ type: "summary_text", text: "Plan A\n\nPlan B" }],
			},
			// No summary_text entry for an item without summary text.
			{
				type: "reasoning",
				id: "rs_2",
				encrypted_content: "enc-2",
				summary: [],
			},
			{
				type: "function_call",
				call_id: "call_1",
				name: "read_files",
				arguments: '{"files":["a.ts"]}',
			},
			{ type: "function_call_output", call_id: "call_1", output: "contents" },
		]);
	});
});
