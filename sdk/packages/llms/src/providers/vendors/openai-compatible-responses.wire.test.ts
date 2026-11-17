// Wire-contract tests for the built-in OpenAI Compatible provider's protocol
// routing, exercised through the *real* `@ai-sdk/openai` Responses adapter and
// `@ai-sdk/openai-compatible` chat adapter with a stubbed fetch that answers
// per URL. They pin:
//
//   1. Auto mode sends OpenAI reasoning-era models on OpenAI/Azure OpenAI hosts
//      to `/responses`, stateless (store:false + encrypted reasoning), with the
//      reasoning effort and non-strict tools;
//   2. an endpoint without `/responses` is served through `/chat/completions`
//      in the same call, the kv.6 reasoning fallback still applies there, the
//      user is told (provider notices), and the endpoint + model is remembered;
//   3. everything else stays on Chat Completions: an explicit chat choice,
//      other hosts, Azure deployment base URLs, keyless configs, models that
//      are not reasoning-era, and other OpenAI-compatible providers;
//   4. no key from the environment ever reaches the wire through the
//      Responses adapter's own env fallback.
import type {
	LanguageModelV4,
	LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import type {
	AgentModelEvent,
	AgentToolDefinition,
	GatewayProviderContext,
	GatewayResolvedProviderConfig,
	GatewayStreamRequest,
} from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_PROVIDER_MANIFESTS_BY_ID } from "../builtins";
import { createGateway } from "../gateway";
import { composeAiSdkProviderOptions } from "../routing/provider-options";
import { createOpenAICompatibleProviderModule } from "./openai-compatible";
import { resetReasoningToolsFallbacks } from "./reasoning-tools-fallback";
import { resetProtocolDecisions } from "./responses-router";

const AZURE_BASE_URL = "https://res.openai.azure.com/openai/v1";
const MODEL_ID = "gpt-6-luna";
const REFUSAL_MESSAGE =
	"Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.";

const READ_FILE: AgentToolDefinition = {
	name: "read_file",
	description: "Read a file",
	inputSchema: {
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
	},
};

function sse(events: Record<string, unknown>[]): string {
	return events
		.map(
			(event) =>
				`event: ${event.type ?? "message"}\ndata: ${JSON.stringify(event)}\n\n`,
		)
		.join("");
}

function responsesText(model: string, text: string): Response {
	return new Response(
		sse([
			{
				type: "response.created",
				response: { id: "resp-1", created_at: 1, model },
			},
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg-1", role: "assistant", content: [] },
			},
			{
				type: "response.output_text.delta",
				item_id: "msg-1",
				output_index: 0,
				content_index: 0,
				delta: text,
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "message",
					id: "msg-1",
					role: "assistant",
					content: [{ type: "output_text", text, annotations: [] }],
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp-1",
					created_at: 1,
					model,
					status: "completed",
					incomplete_details: null,
					usage: {
						input_tokens: 10,
						output_tokens: 1,
						input_tokens_details: { cached_tokens: 0 },
						output_tokens_details: { reasoning_tokens: 4 },
					},
				},
			},
		]),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

function chatText(model: string, text: string): Response {
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

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** Azure's answer for a route it does not serve. */
const routeNotFound = () =>
	json(404, { error: { code: "404", message: "Resource not found" } });

/** GPT-6 Luna on Chat Completions: tools only with reasoning_effort "none". */
function lunaChat(body: Record<string, unknown>): Response {
	return Array.isArray(body.tools) && body.reasoning_effort !== "none"
		? json(400, {
				error: {
					message: REFUSAL_MESSAGE,
					type: "invalid_request_error",
					param: "reasoning_effort",
					code: null,
				},
			})
		: chatText(String(body.model), "OK");
}

interface WireCall {
	url: string;
	path: string;
	body: Record<string, unknown>;
	headers: Headers;
}

/** A fetch stub that answers `/responses` and `/chat/completions` separately. */
function endpoint(handlers: {
	responses?: (body: Record<string, unknown>) => Response;
	chat?: (body: Record<string, unknown>) => Response;
}) {
	const calls: WireCall[] = [];
	const fetchStub = (async (input, init) => {
		const url = String(input instanceof Request ? input.url : input);
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<
			string,
			unknown
		>;
		const path = new URL(url).pathname;
		calls.push({ url, path, body, headers: new Headers(init?.headers) });
		if (path.endsWith("/responses")) {
			return (handlers.responses ?? routeNotFound)(body);
		}
		if (path.endsWith("/chat/completions")) {
			return (handlers.chat ?? lunaChat)(body);
		}
		return routeNotFound();
	}) as typeof fetch;
	return {
		fetchStub,
		calls,
		paths: () => calls.map((call) => call.path.replace(/^.*\/v1/, "")),
	};
}

async function streamTurn(input: {
	providerId?: string;
	modelId?: string;
	apiKey?: string;
	baseUrl?: string;
	options?: Record<string, unknown>;
	fetch: typeof fetch;
	reasoning?: GatewayStreamRequest["reasoning"];
}): Promise<AgentModelEvent[]> {
	const providerId = input.providerId ?? "openai-compatible";
	const gateway = createGateway({
		providerConfigs: [
			{
				providerId,
				...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
				baseUrl: input.baseUrl ?? AZURE_BASE_URL,
				fetch: input.fetch,
				...(input.options ? { options: input.options } : {}),
			},
		],
	});
	const events: AgentModelEvent[] = [];
	for await (const event of await gateway.stream({
		providerId,
		modelId: input.modelId ?? MODEL_ID,
		reasoning: input.reasoning ?? { effort: "medium" },
		maxTokens: 256,
		tools: [READ_FILE],
		messages: [
			{
				id: "m1",
				role: "user",
				content: [{ type: "text", text: "read a.ts" }],
				createdAt: 0,
			},
		],
	})) {
		events.push(event);
	}
	return events;
}

const textOf = (events: AgentModelEvent[]) =>
	events
		.filter((event) => event.type === "text-delta")
		.map((event) => (event as { text?: string }).text ?? "")
		.join("");

const finishOf = (events: AgentModelEvent[]) =>
	events.find((event) => event.type === "finish") as
		| { reason?: string; error?: string }
		| undefined;

beforeEach(() => {
	// Keep the environment out of key resolution unless a test sets it.
	vi.stubEnv("OPENAI_API_KEY", "");
});

afterEach(() => {
	vi.unstubAllEnvs();
	resetProtocolDecisions();
	resetReasoningToolsFallbacks();
});

describe("OpenAI Compatible protocol routing on the wire", () => {
	it("sends GPT-6 Luna on Azure OpenAI to /responses, stateless, with reasoning and non-strict tools", async () => {
		const wire = endpoint({
			responses: (body) => responsesText(String(body.model), "OK"),
		});

		const events = await streamTurn({
			apiKey: "azure-key",
			fetch: wire.fetchStub,
		});

		expect(wire.paths()).toEqual(["/responses"]);
		const [call] = wire.calls;
		expect(call?.url).toBe(`${AZURE_BASE_URL}/responses`);
		expect(call?.headers.get("authorization")).toBe("Bearer azure-key");
		expect(call?.body).toMatchObject({
			model: MODEL_ID,
			stream: true,
			store: false,
			include: ["reasoning.encrypted_content"],
			reasoning: { effort: "medium" },
			tools: [
				expect.objectContaining({
					type: "function",
					name: "read_file",
					strict: false,
				}),
			],
		});
		expect(call?.body).not.toHaveProperty("truncation");
		expect(call?.body).not.toHaveProperty("reasoning_effort");
		expect(textOf(events)).toBe("OK");
		expect(finishOf(events)?.reason).not.toBe("error");
	});

	it("falls back to /chat/completions when /responses is missing, keeps the kv.6 reasoning fallback, and remembers the endpoint", async () => {
		const wire = endpoint({});

		const events = await streamTurn({
			apiKey: "azure-key",
			fetch: wire.fetchStub,
		});

		expect(wire.paths()).toEqual([
			"/responses",
			"/chat/completions",
			"/chat/completions",
		]);
		expect(
			wire.calls.slice(1).map((call) => call.body.reasoning_effort),
		).toEqual(["medium", "none"]);
		// Responses-only options never leak into chat bodies.
		for (const call of wire.calls.slice(1)) {
			expect(call.body).not.toHaveProperty("store");
			expect(call.body).not.toHaveProperty("include");
		}
		expect(textOf(events)).toBe("OK");
		expect(finishOf(events)?.reason).not.toBe("error");

		// The next request (a new provider module) goes straight to chat, with
		// reasoning off up front.
		wire.calls.length = 0;
		const next = await streamTurn({
			apiKey: "azure-key",
			fetch: wire.fetchStub,
		});
		expect(wire.paths()).toEqual(["/chat/completions"]);
		expect(wire.calls[0]?.body.reasoning_effort).toBe("none");
		expect(textOf(next)).toBe("OK");
	});

	it("never touches /responses with an explicit Chat Completions choice", async () => {
		const wire = endpoint({
			responses: (body) => responsesText(String(body.model), "wrong"),
		});

		const events = await streamTurn({
			apiKey: "azure-key",
			options: { apiProtocol: "openai-chat" },
			fetch: wire.fetchStub,
		});

		expect(wire.paths()).toEqual(["/chat/completions", "/chat/completions"]);
		expect(wire.calls[0]?.body).not.toHaveProperty("store");
		expect(textOf(events)).toBe("OK");
	});

	it.each([
		[
			"a host that is not OpenAI or Azure OpenAI",
			{ baseUrl: "https://llm.example.com/v1" },
		],
		[
			"an Azure deployment base URL",
			{ baseUrl: "https://res.openai.azure.com/openai/deployments/luna" },
		],
		["a keyless config", { apiKey: undefined }],
		["a model that is not reasoning-era", { modelId: "gpt-4o" }],
		["a chat variant", { modelId: "gpt-5-chat-latest" }],
		["another OpenAI-compatible provider", { providerId: "goodvision" }],
	] as const)("stays on Chat Completions for %s", async (_label, overrides) => {
		const wire = endpoint({
			responses: (body) => responsesText(String(body.model), "wrong"),
			chat: (body) => chatText(String(body.model), "OK"),
		});

		const events = await streamTurn({
			apiKey: "azure-key",
			...overrides,
			fetch: wire.fetchStub,
		});

		expect(
			wire.paths().every((path) => path.endsWith("/chat/completions")),
		).toBe(true);
		expect(textOf(events)).toBe("OK");
	});

	it("uses /responses on any host when the user chose it, falling back on 404", async () => {
		const wire = endpoint({
			chat: (body) => chatText(String(body.model), "OK"),
		});

		const events = await streamTurn({
			apiKey: "proxy-key",
			baseUrl: "https://llm.example.com/v1",
			modelId: "qwen3-coder",
			options: { apiProtocol: "openai-responses" },
			fetch: wire.fetchStub,
		});

		expect(wire.paths()).toEqual(["/responses", "/chat/completions"]);
		expect(wire.calls[0]?.url).toBe("https://llm.example.com/v1/responses");
		expect(textOf(events)).toBe("OK");
	});

	it("tries /responses again when the user picks Responses after an Auto fallback", async () => {
		const baseUrl = "https://switch.openai.azure.com/openai/v1";
		const wire = endpoint({
			chat: (body) => chatText(String(body.model), "OK"),
		});

		await streamTurn({ apiKey: "azure-key", baseUrl, fetch: wire.fetchStub });
		expect(wire.paths()).toEqual(["/responses", "/chat/completions"]);

		// The Auto fallback is remembered for Auto only.
		wire.calls.length = 0;
		await streamTurn({
			apiKey: "azure-key",
			baseUrl,
			options: { apiProtocol: "openai-responses" },
			fetch: wire.fetchStub,
		});
		expect(wire.paths()).toEqual(["/responses", "/chat/completions"]);

		// Its own fallback is then remembered too.
		wire.calls.length = 0;
		await streamTurn({
			apiKey: "azure-key",
			baseUrl,
			options: { apiProtocol: "openai-responses" },
			fetch: wire.fetchStub,
		});
		expect(wire.paths()).toEqual(["/chat/completions"]);
	});
});

// ---------------------------------------------------------------------------
// Module level: the notices a request queued, as the gateway drains them.

function builtinContext(
	config: GatewayResolvedProviderConfig,
	providerId = "openai-compatible",
): GatewayProviderContext {
	const provider = BUILTIN_PROVIDER_MANIFESTS_BY_ID[providerId];
	if (!provider) throw new Error(`no builtin ${providerId}`);
	return {
		provider,
		model: { id: MODEL_ID, name: MODEL_ID, providerId },
		config,
	};
}

const READ_FILE_TOOL: LanguageModelV4FunctionTool = {
	type: "function",
	name: READ_FILE.name,
	description: READ_FILE.description,
	inputSchema:
		READ_FILE.inputSchema as LanguageModelV4FunctionTool["inputSchema"],
};

/** One tool-bearing turn through a fresh module, as one gateway stream does. */
async function moduleTurn(config: GatewayResolvedProviderConfig) {
	const context = builtinContext(config, config.providerId);
	const module = await createOpenAICompatibleProviderModule(config, context);
	const request: GatewayStreamRequest = {
		providerId: config.providerId,
		modelId: MODEL_ID,
		messages: [],
		tools: [READ_FILE],
		reasoning: { effort: "medium" },
	};
	const model = module.operations.language(MODEL_ID) as LanguageModelV4;
	const { stream } = await model.doStream({
		prompt: [{ role: "user", content: [{ type: "text", text: "read a.ts" }] }],
		tools: [READ_FILE_TOOL],
		reasoning: "medium",
		providerOptions: composeAiSdkProviderOptions(
			request,
			context,
			"openai-compatible",
		) as never,
	});
	const reader = stream.getReader();
	while (!(await reader.read()).done) {
		/* drain */
	}
	return module.takeNotices?.() ?? [];
}

describe("OpenAI Compatible protocol notices", () => {
	it("queues the fallback and the reasoning downgrade, on every request that has them", async () => {
		const wire = endpoint({});
		const config: GatewayResolvedProviderConfig = {
			providerId: "openai-compatible",
			apiKey: "azure-key",
			baseUrl: AZURE_BASE_URL,
			fetch: wire.fetchStub,
		};

		const first = await moduleTurn(config);

		expect(wire.paths()).toEqual([
			"/responses",
			"/chat/completions",
			"/chat/completions",
		]);
		expect(first).toEqual([
			{
				kind: "responses_unavailable",
				message:
					"res.openai.azure.com doesn't support the Responses API for gpt-6-luna, so Cline is using Chat Completions instead.",
				metadata: {
					kind: "responses_unavailable",
					modelId: MODEL_ID,
					endpointHost: "res.openai.azure.com",
					apiProtocol: "auto",
					status: 404,
				},
			},
			{
				kind: "reasoning_disabled_for_tools",
				message:
					"gpt-6-luna doesn't accept tools with reasoning on Chat Completions, so Cline is sending its tool requests with reasoning turned off.",
				metadata: {
					kind: "reasoning_disabled_for_tools",
					modelId: MODEL_ID,
					endpointHost: "res.openai.azure.com",
					apiProtocol: "auto",
				},
			},
		]);

		wire.calls.length = 0;
		const second = await moduleTurn(config);
		expect(wire.paths()).toEqual(["/chat/completions"]);
		expect(second.map((notice) => notice.kind)).toEqual([
			"responses_unavailable",
			"reasoning_disabled_for_tools",
		]);
	});

	it("queues nothing when the Responses API serves the request", async () => {
		const wire = endpoint({
			responses: (body) => responsesText(String(body.model), "OK"),
		});

		const notices = await moduleTurn({
			providerId: "openai-compatible",
			apiKey: "azure-key",
			baseUrl: AZURE_BASE_URL,
			fetch: wire.fetchStub,
		});

		expect(wire.paths()).toEqual(["/responses"]);
		expect(notices).toEqual([]);
	});

	it("tells GoodVision users about the reasoning downgrade without a protocol", async () => {
		const wire = endpoint({});

		const notices = await moduleTurn({
			providerId: "goodvision",
			apiKey: "gv-key",
			baseUrl: AZURE_BASE_URL,
			fetch: wire.fetchStub,
		});

		expect(wire.paths()).toEqual(["/chat/completions", "/chat/completions"]);
		expect(notices).toEqual([
			expect.objectContaining({
				kind: "reasoning_disabled_for_tools",
				metadata: {
					kind: "reasoning_disabled_for_tools",
					modelId: MODEL_ID,
					endpointHost: "res.openai.azure.com",
				},
			}),
		]);
	});
});

describe("OpenAI Compatible Responses requests and environment keys", () => {
	it("does not send OPENAI_API_KEY or use OPENAI_BASE_URL for a keyless explicit Responses choice", async () => {
		vi.stubEnv("OPENAI_API_KEY", "sk-env-secret");
		vi.stubEnv("OPENAI_BASE_URL", "https://env.example/v1");
		const wire = endpoint({
			responses: (body) => responsesText(String(body.model), "OK"),
		});

		const notices = await moduleTurn({
			providerId: "openai-compatible",
			baseUrl: "http://localhost:8000/v1",
			options: { apiProtocol: "openai-responses" },
			fetch: wire.fetchStub,
		});

		expect(wire.calls.map((call) => call.url)).toEqual([
			"http://localhost:8000/v1/responses",
		]);
		// Keyless, like its Chat Completions requests: no Authorization at all.
		expect(wire.calls[0]?.headers.has("authorization")).toBe(false);
		expect(JSON.stringify([...(wire.calls[0]?.headers ?? [])])).not.toContain(
			"sk-env-secret",
		);
		expect(notices).toEqual([]);
	});

	it("keeps a keyless Auto config on Chat Completions without any env key", async () => {
		vi.stubEnv("OPENAI_API_KEY", "sk-env-secret");
		const wire = endpoint({
			chat: (body) => chatText(String(body.model), "OK"),
		});

		await moduleTurn({
			providerId: "openai-compatible",
			baseUrl: AZURE_BASE_URL,
			fetch: wire.fetchStub,
		});

		expect(wire.paths()).toEqual(["/chat/completions"]);
		for (const call of wire.calls) {
			expect(JSON.stringify([...call.headers])).not.toContain("sk-env-secret");
		}
	});

	it("keeps a user-supplied Authorization header on a keyless Responses request", async () => {
		const wire = endpoint({
			responses: (body) => responsesText(String(body.model), "OK"),
		});

		await moduleTurn({
			providerId: "openai-compatible",
			baseUrl: "http://localhost:8000/v1",
			headers: { Authorization: "Bearer custom-token" },
			options: { apiProtocol: "openai-responses" },
			fetch: wire.fetchStub,
		});

		expect(wire.calls[0]?.headers.get("authorization")).toBe(
			"Bearer custom-token",
		);
	});
});
