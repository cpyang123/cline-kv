import {
	APICallError,
	type LanguageModelV4,
	type LanguageModelV4CallOptions,
	type LanguageModelV4FunctionTool,
	type LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createAdaptiveToolTransportMiddleware,
	DECISION_TTL_MS,
	isNativeToolRefusal,
	readToolTransportDecision,
	resetToolTransportDecisions,
} from "./adaptive-tool-transport";

const readFile: LanguageModelV4FunctionTool = {
	type: "function",
	name: "read_file",
	inputSchema: {
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
	},
};

const finish: LanguageModelV4StreamPart = {
	type: "finish",
	finishReason: { unified: "stop", raw: "stop" },
	usage: {
		inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 1, text: 1, reasoning: 0 },
		raw: undefined,
	} as never,
};

function streamOf(
	parts: LanguageModelV4StreamPart[],
): ReadableStream<LanguageModelV4StreamPart> {
	return new ReadableStream({
		start(controller) {
			for (const part of parts) controller.enqueue(part);
			controller.close();
		},
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

const refusal = () =>
	new APICallError({
		message: "No model offer satisfies the effective policy",
		url: "https://api-test.goodvision.tech/v1/chat/completions",
		requestBodyValues: {},
		statusCode: 422,
		responseBody:
			'{"error":{"code":"no_candidate","message":"No model offer satisfies the effective policy"}}',
	});

const nativeParts = (): LanguageModelV4StreamPart[] => [
	{ type: "tool-input-start", id: "c1", toolName: "read_file" },
	{ type: "tool-input-delta", id: "c1", delta: '{"path":"a.ts"}' },
	{ type: "tool-input-end", id: "c1" },
	{
		type: "tool-call",
		toolCallId: "c1",
		toolName: "read_file",
		input: '{"path":"a.ts"}',
	},
	finish,
];

const promptParts = (): LanguageModelV4StreamPart[] => [
	{ type: "text-start", id: "t" },
	{
		type: "text-delta",
		id: "t",
		delta:
			'<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>',
	},
	{ type: "text-end", id: "t" },
	finish,
];

/**
 * A model whose `doStream` refuses tool-bearing requests when `refuseTools`
 * is set, answers prompt-protocol text otherwise, and records every call.
 */
function fakeModel(options: { refuseTools: boolean }) {
	const calls: LanguageModelV4CallOptions[] = [];
	const model = {
		specificationVersion: "v4",
		provider: "test",
		modelId: "auto",
		supportedUrls: {},
		doGenerate: () => Promise.reject(new Error("n/a")),
		doStream: async (params: LanguageModelV4CallOptions) => {
			calls.push(params);
			const hasTools = (params.tools ?? []).length > 0;
			if (hasTools && options.refuseTools) {
				throw refusal();
			}
			return { stream: streamOf(hasTools ? nativeParts() : promptParts()) };
		},
	} as unknown as LanguageModelV4 & { doStream: LanguageModelV4["doStream"] };
	return { model, calls };
}

/** Drive the middleware the way `wrapLanguageModel` does. */
async function run(
	middleware: ReturnType<typeof createAdaptiveToolTransportMiddleware>,
	model: LanguageModelV4,
	params: LanguageModelV4CallOptions,
) {
	const transformed = await middleware.transformParams!({
		type: "stream",
		params,
		model,
	});
	const result = await middleware.wrapStream!({
		doStream: () => model.doStream(transformed),
		doGenerate: () => Promise.reject(new Error("n/a")),
		params: transformed,
		model,
	});
	return { transformed, parts: await collect(result.stream) };
}

const toolRequest = (): LanguageModelV4CallOptions => ({
	prompt: [{ role: "user", content: [{ type: "text", text: "read a.ts" }] }],
	tools: [readFile],
});

describe("isNativeToolRefusal", () => {
	it("recognises GoodVision's 422 no_candidate and nothing else", () => {
		expect(isNativeToolRefusal(refusal())).toBe(true);
		expect(
			isNativeToolRefusal(
				new APICallError({
					message: "bad request",
					url: "u",
					requestBodyValues: {},
					statusCode: 422,
					responseBody: '{"error":{"code":"invalid_schema"}}',
				}),
			),
		).toBe(false);
		expect(
			isNativeToolRefusal(
				new APICallError({
					message: "No model offer satisfies the effective policy",
					url: "u",
					requestBodyValues: {},
					statusCode: 502,
				}),
			),
		).toBe(false);
		expect(isNativeToolRefusal(new Error("no_candidate"))).toBe(false);
	});
});

describe("createAdaptiveToolTransportMiddleware", () => {
	beforeEach(() => resetToolTransportDecisions());

	it("keeps native tools when the router accepts them and remembers that", async () => {
		const { model, calls } = fakeModel({ refuseTools: false });
		const onDecision = vi.fn();
		const middleware = createAdaptiveToolTransportMiddleware({
			key: "task-1",
			onDecision,
		});
		const first = await run(middleware, model, toolRequest());
		expect(first.transformed.tools).toHaveLength(1);
		expect(first.parts.map((p) => p.type)).toContain("tool-call");
		expect(calls).toHaveLength(1);
		expect(readToolTransportDecision("task-1")).toMatchObject({
			transport: "native",
			reason: "native_accepted",
		});
		expect(onDecision).toHaveBeenCalledTimes(1);

		const second = await run(middleware, model, toolRequest());
		expect(second.transformed.tools).toHaveLength(1);
		expect(calls).toHaveLength(2);
		expect(onDecision).toHaveBeenCalledTimes(1);
	});

	it("re-sends a refused request through the prompt protocol and stays there for the session", async () => {
		const { model, calls } = fakeModel({ refuseTools: true });
		const onDecision = vi.fn();
		const middleware = createAdaptiveToolTransportMiddleware({
			key: "task-2",
			onDecision,
		});
		const first = await run(middleware, model, toolRequest());
		// Native attempt, then the emulated one: no tools, tool section in the system prompt.
		expect(calls).toHaveLength(2);
		expect(calls[0].tools).toHaveLength(1);
		expect(calls[1].tools).toBeUndefined();
		expect(JSON.stringify(calls[1].prompt)).toContain("read_file");
		const call = first.parts.find((p) => p.type === "tool-call");
		expect(call).toMatchObject({
			toolName: "read_file",
			input: '{"path":"a.ts"}',
		});
		expect(onDecision).toHaveBeenCalledWith(
			expect.objectContaining({ transport: "prompt", reason: "tools_refused" }),
		);

		// The next request goes straight to the prompt protocol: one call, no tools.
		const second = await run(middleware, model, toolRequest());
		expect(calls).toHaveLength(3);
		expect(second.transformed.tools).toBeUndefined();
		expect(second.parts.some((p) => p.type === "tool-call")).toBe(true);
		expect(onDecision).toHaveBeenCalledTimes(1);
	});

	it("propagates other errors and decides nothing on them", async () => {
		const model = {
			specificationVersion: "v4",
			provider: "test",
			modelId: "auto",
			supportedUrls: {},
			doStream: async () => {
				throw new APICallError({
					message: "overloaded",
					url: "u",
					requestBodyValues: {},
					statusCode: 503,
				});
			},
		} as unknown as LanguageModelV4;
		const middleware = createAdaptiveToolTransportMiddleware({ key: "task-3" });
		await expect(run(middleware, model, toolRequest())).rejects.toThrow(
			"overloaded",
		);
		expect(readToolTransportDecision("task-3")).toBeUndefined();
	});

	it("does not probe on requests without tools, and isolates sessions by key", async () => {
		const { model, calls } = fakeModel({ refuseTools: true });
		const middleware = createAdaptiveToolTransportMiddleware({ key: "task-4" });
		await run(middleware, model, {
			prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
		});
		expect(calls).toHaveLength(1);
		expect(readToolTransportDecision("task-4")).toBeUndefined();

		await run(middleware, model, toolRequest());
		expect(readToolTransportDecision("task-4")?.transport).toBe("prompt");
		expect(readToolTransportDecision("task-5")).toBeUndefined();
	});

	it("forgets a decision after the TTL so a policy change is picked up", async () => {
		let clock = 1_000;
		const { model, calls } = fakeModel({ refuseTools: true });
		const middleware = createAdaptiveToolTransportMiddleware({
			key: "task-6",
			now: () => clock,
		});
		await run(middleware, model, toolRequest());
		expect(calls).toHaveLength(2);
		clock += DECISION_TTL_MS + 1;
		expect(readToolTransportDecision("task-6", clock)).toBeUndefined();
		await run(middleware, model, toolRequest());
		// Probed again: native attempt plus the fallback.
		expect(calls).toHaveLength(4);
	});
});
