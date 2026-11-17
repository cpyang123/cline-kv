import type { AgentModelEvent, AgentToolDefinition } from "@cline/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGateway } from "../gateway";
import {
	createReasoningToolsFallbackFetch,
	isReasoningWithToolsRefusal,
	resetReasoningToolsFallbacks,
} from "./reasoning-tools-fallback";

// The refusal as Azure OpenAI returned it for gpt-6-luna (2026-11).
const REFUSAL_MESSAGE =
	"Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.";

const URL_CHAT = "https://chronosense.example/openai/v1/chat/completions";

function refusal(): Response {
	return new Response(
		JSON.stringify({
			error: {
				message: REFUSAL_MESSAGE,
				type: "invalid_request_error",
				param: "reasoning_effort",
				code: null,
			},
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}

function ok(): Response {
	return new Response("ok", { status: 200 });
}

function toolBody(
	model: string,
	effort: string | undefined,
	tools: unknown[] = [{ type: "function", function: { name: "read_file" } }],
): string {
	return JSON.stringify({
		model,
		messages: [{ role: "user", content: "hi" }],
		...(tools.length > 0 ? { tools } : {}),
		...(effort !== undefined ? { reasoning_effort: effort } : {}),
	});
}

/** A base fetch that refuses tool requests carrying a non-"none" effort. */
function refusingBase() {
	const sentEfforts: Array<string | undefined> = [];
	const base = vi.fn(async (_input: unknown, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body ?? "{}"));
		sentEfforts.push(body.reasoning_effort);
		return body.tools?.length && body.reasoning_effort !== "none"
			? refusal()
			: ok();
	});
	return { base, sentEfforts };
}

afterEach(() => {
	resetReasoningToolsFallbacks();
});

describe("isReasoningWithToolsRefusal", () => {
	it("recognizes the refusal and nothing else", () => {
		expect(isReasoningWithToolsRefusal(REFUSAL_MESSAGE)).toBe(true);
		expect(
			isReasoningWithToolsRefusal(
				"Unsupported value: 'reasoning_effort' does not support 'xhigh' with this model.",
			),
		).toBe(false);
		expect(isReasoningWithToolsRefusal("Invalid tool schema")).toBe(false);
	});
});

describe("createReasoningToolsFallbackFetch", () => {
	it("does not remember a refusal for a router alias such as auto", async () => {
		const { base, sentEfforts } = refusingBase();
		const fallbackFetch = createReasoningToolsFallbackFetch(base as never);

		await fallbackFetch(URL_CHAT, {
			method: "POST",
			body: toolBody("auto", "low"),
		});
		await fallbackFetch(URL_CHAT, {
			method: "POST",
			body: toolBody("auto", "low"),
		});

		// Each request is probed with its own effort first.
		expect(sentEfforts).toEqual(["low", "none", "low", "none"]);
	});

	it("forgets a remembered model whose requests now refuse none, and sends the original", async () => {
		let refuseNone = false;
		const sentEfforts: Array<string | undefined> = [];
		const base = vi.fn(async (_input: unknown, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body ?? "{}"));
			sentEfforts.push(body.reasoning_effort);
			if (body.reasoning_effort === "none") {
				return refuseNone
					? new Response(
							'{"error":{"message":"Unsupported value: \'reasoning_effort\' does not support \'none\' with this model.","param":"reasoning_effort"}}',
							{ status: 400 },
						)
					: ok();
			}
			return refuseNone ? ok() : refusal();
		});
		const fallbackFetch = createReasoningToolsFallbackFetch(base as never);
		await fallbackFetch(URL_CHAT, {
			method: "POST",
			body: toolBody("gpt-6-luna", "low"),
		});

		refuseNone = true;
		sentEfforts.length = 0;
		const response = await fallbackFetch(URL_CHAT, {
			method: "POST",
			body: toolBody("gpt-6-luna", "low"),
		});
		expect(response.status).toBe(200);
		expect(sentEfforts).toEqual(["none", "low"]);

		sentEfforts.length = 0;
		await fallbackFetch(URL_CHAT, {
			method: "POST",
			body: toolBody("gpt-6-luna", "low"),
		});
		expect(sentEfforts).toEqual(["low"]);
	});

	it("leaves bodies with their own reasoning object alone (OpenRouter style)", async () => {
		const { base } = refusingBase();
		const fallbackFetch = createReasoningToolsFallbackFetch(base as never);
		const body = JSON.stringify({
			model: "gpt-6-luna",
			messages: [{ role: "user", content: "hi" }],
			tools: [{ type: "function", function: { name: "read_file" } }],
			reasoning: { effort: "low" },
		});

		await fallbackFetch(URL_CHAT, { method: "POST", body });

		expect(base).toHaveBeenCalledTimes(1);
	});

	it("re-sends a refused tool request once with reasoning_effort none", async () => {
		const { base, sentEfforts } = refusingBase();
		const onApplied = vi.fn();
		const fallbackFetch = createReasoningToolsFallbackFetch(base as never, {
			onApplied,
		});

		const response = await fallbackFetch(URL_CHAT, {
			method: "POST",
			body: toolBody("gpt-6-luna", "medium"),
		});

		expect(response.status).toBe(200);
		expect(sentEfforts).toEqual(["medium", "none"]);
		expect(onApplied).toHaveBeenCalledWith({
			model: "gpt-6-luna",
			requestedEffort: "medium",
			remembered: false,
		});
	});

	it("sends later tool requests for that model with none up front, reporting each one", async () => {
		const { base, sentEfforts } = refusingBase();
		const onApplied = vi.fn();
		const fallbackFetch = createReasoningToolsFallbackFetch(base as never, {
			onApplied,
		});

		await fallbackFetch(URL_CHAT, {
			method: "POST",
			body: toolBody("gpt-6-luna", "low"),
		});
		sentEfforts.length = 0;
		// A new wrapper (a new provider module, as each request builds) still
		// knows the model refuses.
		const nextFetch = createReasoningToolsFallbackFetch(base as never, {
			onApplied,
		});
		const response = await nextFetch(`${URL_CHAT}?api-version=preview`, {
			method: "POST",
			body: toolBody("gpt-6-luna", "high"),
		});

		expect(response.status).toBe(200);
		expect(sentEfforts).toEqual(["none"]);
		// Every degraded request is reported, so each one can tell the user.
		expect(onApplied.mock.calls.map(([info]) => info)).toEqual([
			{ model: "gpt-6-luna", requestedEffort: "low", remembered: false },
			{ model: "gpt-6-luna", requestedEffort: "high", remembered: true },
		]);
	});

	it("keeps the effort on requests without tools, even for a remembered model", async () => {
		const { base, sentEfforts } = refusingBase();
		const fallbackFetch = createReasoningToolsFallbackFetch(base as never);
		await fallbackFetch(URL_CHAT, {
			method: "POST",
			body: toolBody("gpt-6-luna", "medium"),
		});
		sentEfforts.length = 0;

		await fallbackFetch(URL_CHAT, {
			method: "POST",
			body: toolBody("gpt-6-luna", "medium", []),
		});

		expect(sentEfforts).toEqual(["medium"]);
	});

	it("does not carry a remembered model to other models or endpoints", async () => {
		const { base, sentEfforts } = refusingBase();
		const fallbackFetch = createReasoningToolsFallbackFetch(base as never);
		await fallbackFetch(URL_CHAT, {
			method: "POST",
			body: toolBody("gpt-6-luna", "medium"),
		});
		sentEfforts.length = 0;

		await fallbackFetch(URL_CHAT, {
			method: "POST",
			body: toolBody("gpt-6-sol", "medium"),
		});
		await fallbackFetch("https://other.example/v1/chat/completions", {
			method: "POST",
			body: toolBody("gpt-6-luna", "medium"),
		});

		// Each is probed with its own effort first.
		expect(sentEfforts).toEqual(["medium", "none", "medium", "none"]);
	});

	it("returns other 400s unchanged with a readable body", async () => {
		const base = vi.fn(
			async () =>
				new Response('{"error":{"message":"Invalid tool schema"}}', {
					status: 400,
				}),
		);
		const fallbackFetch = createReasoningToolsFallbackFetch(base as never);

		const response = await fallbackFetch(URL_CHAT, {
			method: "POST",
			body: toolBody("gpt-6-luna", "medium"),
		});

		expect(response.status).toBe(400);
		expect(await response.text()).toContain("Invalid tool schema");
		expect(base).toHaveBeenCalledTimes(1);
	});

	it("passes through requests that already send none", async () => {
		const { base, sentEfforts } = refusingBase();
		const fallbackFetch = createReasoningToolsFallbackFetch(base as never);

		await fallbackFetch(URL_CHAT, {
			method: "POST",
			body: toolBody("gpt-6-luna", "none"),
		});

		expect(sentEfforts).toEqual(["none"]);
		expect(base).toHaveBeenCalledTimes(1);
	});

	it("falls back for a tool request that sends no effort (the endpoint default is refused)", async () => {
		const sentEfforts: Array<string | undefined> = [];
		// The endpoint applies the model's default effort when none is sent,
		// so it refuses the tool request just the same (cline/cline#15055).
		const base = vi.fn(async (_input: unknown, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body ?? "{}"));
			sentEfforts.push(body.reasoning_effort);
			return body.reasoning_effort === "none" ? ok() : refusal();
		});
		const onApplied = vi.fn();
		const fallbackFetch = createReasoningToolsFallbackFetch(base as never, {
			onApplied,
		});

		const response = await fallbackFetch(URL_CHAT, {
			method: "POST",
			body: toolBody("gpt-6-luna", undefined),
		});
		await fallbackFetch(URL_CHAT, {
			method: "POST",
			body: toolBody("gpt-6-luna", undefined),
		});

		expect(response.status).toBe(200);
		expect(sentEfforts).toEqual([undefined, "none", "none"]);
		expect(onApplied).toHaveBeenCalledWith({
			model: "gpt-6-luna",
			requestedEffort: "default",
			remembered: false,
		});
	});

	it("only touches Chat Completions requests", async () => {
		// A Responses API body also carries tools and no `reasoning_effort`;
		// injecting one there would corrupt the request.
		const base = vi.fn(async () => refusal());
		const onApplied = vi.fn();
		const fallbackFetch = createReasoningToolsFallbackFetch(base as never, {
			onApplied,
		});
		const responsesBody = JSON.stringify({
			model: "gpt-6-luna",
			input: [],
			tools: [{ type: "function", name: "read_file" }],
		});

		const response = await fallbackFetch(
			"https://chronosense.example/openai/v1/responses",
			{ method: "POST", body: responsesBody },
		);

		expect(response.status).toBe(400);
		expect(base).toHaveBeenCalledTimes(1);
		expect(base.mock.calls[0]).toEqual([
			"https://chronosense.example/openai/v1/responses",
			{ method: "POST", body: responsesBody },
		]);
		expect(onApplied).not.toHaveBeenCalled();
	});

	it("recognizes Chat Completions URLs given as a URL, a Request, or with a trailing slash", async () => {
		const { base, sentEfforts } = refusingBase();
		const fallbackFetch = createReasoningToolsFallbackFetch(base as never);

		await fallbackFetch(new URL(URL_CHAT), {
			method: "POST",
			body: toolBody("gpt-6-luna", "medium"),
		});
		await fallbackFetch(new Request(`${URL_CHAT}/`, { method: "POST" }), {
			method: "POST",
			body: toolBody("gpt-6-luna", "medium"),
		});

		expect(sentEfforts).toEqual(["medium", "none", "medium", "none"]);
	});
});

const READ_FILE_TOOL: AgentToolDefinition = {
	name: "read_file",
	description: "Read a file",
	inputSchema: {
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
	},
};

function sseText(model: string, text: string): Response {
	const events = [
		`data: ${JSON.stringify({
			id: "chatcmpl-test",
			created: 0,
			model,
			choices: [{ index: 0, delta: { role: "assistant", content: text } }],
		})}`,
		`data: ${JSON.stringify({
			id: "chatcmpl-test",
			created: 0,
			model,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		})}`,
		"data: [DONE]",
		"",
	].join("\n\n");
	return new Response(events, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("OpenAI Compatible turn against a model that refuses tools with reasoning", () => {
	it.each([
		["an explicit effort", { effort: "medium" as const }, "medium"],
		["no effort (the endpoint default)", undefined, undefined],
	])("completes the turn instead of surfacing the refusal, with %s", async (_label, reasoning, firstEffort) => {
		const sent: Array<Record<string, unknown>> = [];
		const fetchStub = (async (_input, init) => {
			const body = JSON.parse(String(init?.body ?? "{}"));
			sent.push(body);
			return Array.isArray(body.tools) && body.reasoning_effort !== "none"
				? refusal()
				: sseText(body.model, "OK");
		}) as typeof fetch;
		const gateway = createGateway({
			providerConfigs: [
				{
					providerId: "openai-compatible",
					apiKey: "test-key",
					baseUrl: "https://chronosense.example/openai/v1",
					fetch: fetchStub,
				},
			],
		});

		const events: AgentModelEvent[] = [];
		for await (const event of await gateway.stream({
			providerId: "openai-compatible",
			modelId: "gpt-6-luna",
			reasoning,
			maxTokens: 64,
			tools: [READ_FILE_TOOL],
			messages: [
				{
					id: "m1",
					role: "user",
					content: [{ type: "text", text: "hi" }],
					createdAt: 0,
				},
			],
		})) {
			events.push(event);
		}

		expect(sent.map((body) => body.reasoning_effort)).toEqual([
			firstEffort,
			"none",
		]);
		expect(sent[1]?.tools).toEqual(sent[0]?.tools);
		const text = events
			.filter((event) => event.type === "text-delta")
			.map((event) => (event as { text?: string }).text ?? "")
			.join("");
		expect(text).toBe("OK");
		const finish = events.find((event) => event.type === "finish") as
			| { reason?: string; error?: string }
			| undefined;
		expect(finish?.reason).not.toBe("error");
		expect(finish?.error).toBeUndefined();
	});
});
