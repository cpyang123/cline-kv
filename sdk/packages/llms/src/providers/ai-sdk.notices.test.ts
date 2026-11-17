import type {
	LanguageModelV4,
	LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type {
	AgentModelEvent,
	GatewayProviderContext,
	GatewayStreamRequest,
} from "@cline/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleProvider } from "./ai-sdk";
import { createGatewayApiHandler } from "./compat";
import type { ApiStreamChunk } from "./types";
import type { ProviderFactoryResult, ProviderNotice } from "./vendors/types";

/**
 * Vendor notices (`ProviderFactoryResult.takeNotices`) reaching the caller
 * as `notice` model events: ahead of the content that follows them, and
 * never lost when the request fails.
 */

const vendor = vi.hoisted(() => ({
	create: undefined as undefined | (() => ProviderFactoryResult),
}));

vi.mock("./vendors/openai-compatible", () => ({
	createOpenAICompatibleProviderModule: () => {
		if (!vendor.create) throw new Error("test vendor not configured");
		return vendor.create();
	},
}));

const usage = {
	inputTokens: {
		total: 1,
		noCache: undefined,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: 1, text: undefined, reasoning: undefined },
} as never;

const textParts: LanguageModelV4StreamPart[] = [
	{ type: "stream-start", warnings: [] },
	{ type: "text-start", id: "t" },
	{ type: "text-delta", id: "t", delta: "hello" },
	{ type: "text-end", id: "t" },
	{ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
];

const fallbackNotice: ProviderNotice = {
	kind: "responses_unavailable",
	message:
		"example.test doesn't support the Responses API for gpt-6-luna, so Cline is using Chat Completions instead.",
	metadata: {
		kind: "responses_unavailable",
		modelId: "gpt-6-luna",
		endpointHost: "example.test",
		apiProtocol: "auto",
	},
};

const reasoningNotice: ProviderNotice = {
	kind: "reasoning_disabled_for_tools",
	message:
		"gpt-6-luna doesn't accept tools with reasoning on Chat Completions, so Cline is sending its tool requests with reasoning turned off.",
};

/**
 * A vendor whose model queues notices the way the protocol router does:
 * inside `doStream`, optionally again while its stream runs, then succeeds
 * or fails.
 */
function useVendor(options: {
	inDoStream?: ProviderNotice[];
	beforeFinish?: ProviderNotice[];
	parts?: LanguageModelV4StreamPart[];
	fail?: Error;
	takeNotices?: () => ProviderNotice[];
}) {
	const queue: ProviderNotice[] = [];
	const model: LanguageModelV4 = {
		specificationVersion: "v4",
		provider: "test",
		modelId: "gpt-6-luna",
		supportedUrls: {},
		doGenerate: async () => {
			throw new Error("doGenerate is not used by the streaming path");
		},
		doStream: async () => {
			queue.push(...(options.inDoStream ?? []));
			if (options.fail) throw options.fail;
			const parts = options.parts ?? textParts;
			return {
				stream: new ReadableStream<LanguageModelV4StreamPart>({
					start(controller) {
						for (const part of parts) {
							if (part.type === "finish") {
								queue.push(...(options.beforeFinish ?? []));
							}
							controller.enqueue(part);
						}
						controller.close();
					},
				}),
			};
		},
	};
	vendor.create = () => ({
		operations: { language: () => model },
		retryEmptyResponses: false,
		takeNotices: options.takeNotices ?? (() => queue.splice(0)),
	});
}

function context(): GatewayProviderContext {
	const model = { id: "gpt-6-luna", providerId: "openai-compatible" };
	return {
		provider: {
			id: "openai-compatible",
			name: "OpenAI Compatible",
			models: [model],
		},
		model,
		config: { providerId: "openai-compatible" },
	} as unknown as GatewayProviderContext;
}

const request: GatewayStreamRequest = {
	providerId: "openai-compatible",
	modelId: "gpt-6-luna",
	messages: [
		{
			id: "user_1",
			role: "user",
			content: [{ type: "text", text: "hi" }],
			createdAt: 1,
		},
	],
};

async function stream(): Promise<AgentModelEvent[]> {
	const provider = await createOpenAICompatibleProvider({
		providerId: "openai-compatible",
	});
	const events: AgentModelEvent[] = [];
	for await (const event of await provider.stream(request, context())) {
		events.push(event);
	}
	return events;
}

const types = (events: AgentModelEvent[]) => events.map((event) => event.type);

describe("provider notices", () => {
	beforeEach(() => {
		vendor.create = undefined;
	});

	it("emits notices queued by the model call before its content", async () => {
		useVendor({ inDoStream: [fallbackNotice, reasoningNotice] });
		const events = await stream();

		expect(types(events)).toEqual([
			"notice",
			"notice",
			"text-delta",
			"usage",
			"finish",
		]);
		expect(events[0]).toEqual({ type: "notice", ...fallbackNotice });
		expect(events[1]).toEqual({
			type: "notice",
			kind: "reasoning_disabled_for_tools",
			message: reasoningNotice.message,
		});
	});

	it("emits notices queued while the stream runs before the finish", async () => {
		useVendor({ beforeFinish: [fallbackNotice] });
		const events = await stream();

		// Where it lands among the parts depends on stream buffering; it is
		// delivered exactly once, ahead of the usage and finish.
		expect(types(events).filter((type) => type === "notice")).toHaveLength(1);
		expect(types(events).slice(-2)).toEqual(["usage", "finish"]);
	});

	it("keeps notices from a request that failed", async () => {
		useVendor({
			inDoStream: [fallbackNotice],
			fail: new Error("chat fallback failed too"),
		});
		const events = await stream();

		expect(types(events)).toEqual(["notice", "finish"]);
		expect(events.at(-1)).toMatchObject({
			type: "finish",
			reason: "error",
			error: expect.stringContaining("chat fallback failed too"),
		});
	});

	it("keeps notices when building the model fails", async () => {
		const queue = [fallbackNotice];
		vendor.create = () => ({
			operations: {
				language: () => {
					throw new Error("cannot build model");
				},
			},
			takeNotices: () => queue.splice(0),
		});
		const events = await stream();

		expect(types(events)).toEqual(["notice", "finish"]);
		expect(events.at(-1)).toMatchObject({ reason: "error" });
	});

	it("never fails a request because notices could not be read", async () => {
		useVendor({
			takeNotices: () => {
				throw new Error("broken notice queue");
			},
		});
		const events = await stream();

		expect(types(events)).toEqual(["text-delta", "usage", "finish"]);
		expect(events.at(-1)).toMatchObject({ reason: "stop" });
	});

	it("works with vendors that queue no notices", async () => {
		vendor.create = () => ({
			operations: {
				language: () =>
					({
						specificationVersion: "v4",
						provider: "test",
						modelId: "gpt-6-luna",
						supportedUrls: {},
						doGenerate: async () => {
							throw new Error("unused");
						},
						doStream: async () => ({
							stream: new ReadableStream<LanguageModelV4StreamPart>({
								start(controller) {
									for (const part of textParts) controller.enqueue(part);
									controller.close();
								},
							}),
						}),
					}) satisfies LanguageModelV4,
			},
			retryEmptyResponses: false,
		});
		const events = await stream();

		expect(types(events)).toEqual(["text-delta", "usage", "finish"]);
	});
});

describe("legacy ApiStream conversion", () => {
	beforeEach(() => {
		vendor.create = undefined;
	});

	it("drops notices and metadata-only reasoning deltas", async () => {
		useVendor({
			inDoStream: [fallbackNotice],
			parts: [
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
					providerMetadata: {
						openai: { itemId: "rs_1", reasoningEncryptedContent: "enc-1" },
					},
				},
				...textParts.slice(1),
			],
		});
		const handler = createGatewayApiHandler({
			providerId: "openai-compatible",
			modelId: "gpt-6-luna",
			apiKey: "test-key",
			baseUrl: "https://example.test/v1",
		});

		const chunks: ApiStreamChunk[] = [];
		for await (const chunk of handler.createMessage("", [
			{ role: "user", content: "hi" },
		])) {
			chunks.push(chunk);
		}

		expect(
			chunks
				.filter((chunk) => chunk.type === "reasoning" || chunk.type === "text")
				.map((chunk) =>
					chunk.type === "reasoning" ? chunk.reasoning : chunk.text,
				),
		).toEqual(["Thinking", "hello"]);
	});
});
