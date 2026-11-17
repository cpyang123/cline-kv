import type {
	AgentMessage,
	AgentModel,
	AgentModelEvent,
	AgentModelRequest,
	ReasoningPartMetadata,
} from "@cline/shared";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "./index";

/**
 * Provider reasoning items (OpenAI Responses) in the runtime: one reasoning
 * part per item with merged replay metadata, no UI deltas for metadata-only
 * events, and model notices announced once as status notices.
 */

class ScriptedModel implements AgentModel {
	public readonly requests: AgentModelRequest[] = [];

	constructor(private readonly steps: Array<() => AgentModelEvent[]>) {}

	async stream(
		request: AgentModelRequest,
	): Promise<AsyncIterable<AgentModelEvent>> {
		this.requests.push(request);
		const step = this.steps.shift();
		if (!step) throw new Error("No scripted model step available");
		const events = step();
		return (async function* () {
			yield* events;
		})();
	}
}

const origin = { providerId: "openai-compatible", modelId: "gpt-6-luna" };

function itemDelta(
	itemId: string,
	text: string,
	encryptedContent?: string,
): AgentModelEvent {
	return {
		type: "reasoning-delta",
		text,
		itemId,
		metadata: {
			openaiResponses: {
				itemId,
				...(encryptedContent ? { encryptedContent } : {}),
				...origin,
			},
		} satisfies ReasoningPartMetadata,
	};
}

function assistantContent(messages: readonly AgentMessage[]) {
	return messages.find((message) => message.role === "assistant")?.content;
}

describe("AgentRuntime reasoning items", () => {
	it("keeps one part per item and never loses its encrypted content", async () => {
		const model = new ScriptedModel([
			() => [
				itemDelta("rs_1", "Plan A"),
				itemDelta("rs_1", "\n\nPlan B"),
				itemDelta("rs_1", "", "enc-1"),
				itemDelta("rs_2", "", "enc-2"),
				// A later event for the item without the encrypted content.
				itemDelta("rs_1", ""),
				{ type: "text-delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const runtime = new AgentRuntime({ model });

		const result = await runtime.run("Hi");

		expect(result.status).toBe("completed");
		expect(assistantContent(result.messages)).toEqual([
			{
				type: "reasoning",
				text: "Plan A\n\nPlan B",
				metadata: {
					openaiResponses: {
						itemId: "rs_1",
						encryptedContent: "enc-1",
						...origin,
					},
				},
			},
			{
				type: "reasoning",
				text: "",
				metadata: {
					openaiResponses: {
						itemId: "rs_2",
						encryptedContent: "enc-2",
						...origin,
					},
				},
			},
			{ type: "text", text: "done" },
		]);
	});

	it("starts a new part when the item changes, even between consecutive deltas", async () => {
		const model = new ScriptedModel([
			() => [
				itemDelta("rs_1", "First"),
				itemDelta("rs_2", "Second"),
				{ type: "text-delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const runtime = new AgentRuntime({ model });

		const result = await runtime.run("Hi");

		expect(
			assistantContent(result.messages)?.map((part) =>
				part.type === "reasoning" ? part.text : part.type,
			),
		).toEqual(["First", "Second", "text"]);
	});

	it("emits no reasoning deltas for metadata-only events", async () => {
		const model = new ScriptedModel([
			() => [
				itemDelta("rs_1", "Plan"),
				itemDelta("rs_1", "", "enc-1"),
				itemDelta("rs_2", "", "enc-2"),
				{ type: "text-delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const runtime = new AgentRuntime({ model });
		const deltas: Array<{ text: string; accumulatedText: string }> = [];
		runtime.subscribe((event) => {
			if (event.type === "assistant-reasoning-delta") {
				deltas.push({
					text: event.text,
					accumulatedText: event.accumulatedText,
				});
			}
		});

		await runtime.run("Hi");

		expect(deltas).toEqual([{ text: "Plan", accumulatedText: "Plan" }]);
	});

	it("still merges plain reasoning deltas into one part, keeping earlier metadata", async () => {
		const model = new ScriptedModel([
			() => [
				{
					type: "reasoning-delta",
					text: "Think",
					metadata: { thoughtSignature: "sig" },
				},
				{
					type: "reasoning-delta",
					text: "ing",
					metadata: { details: undefined },
				},
				{ type: "text-delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const runtime = new AgentRuntime({ model });

		const result = await runtime.run("Hi");

		expect(assistantContent(result.messages)?.[0]).toEqual({
			type: "reasoning",
			text: "Thinking",
			metadata: { thoughtSignature: "sig" },
		});
	});

	it("treats a turn of metadata-only reasoning as an empty response", async () => {
		const model = new ScriptedModel([
			() => [
				itemDelta("rs_1", "", "enc-1"),
				{ type: "finish", reason: "stop" },
			],
		]);
		const runtime = new AgentRuntime({ model });

		const result = await runtime.run("Hi");

		expect(result.status).toBe("failed");
		expect(result.error?.message).toBe("Model returned empty response");
	});

	it("replays the merged part on the next request", async () => {
		const model = new ScriptedModel([
			() => [
				itemDelta("rs_1", "Plan"),
				itemDelta("rs_1", "", "enc-1"),
				{
					type: "tool-call-delta",
					toolCallId: "call_1",
					toolName: "echo",
					inputText: '{"text":"x"}',
				},
				{ type: "finish", reason: "tool-calls" },
			],
			() => [
				{ type: "text-delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const runtime = new AgentRuntime({
			model,
			tools: [
				{
					name: "echo",
					description: "Echo",
					inputSchema: { type: "object" },
					async execute(input) {
						return input;
					},
				},
			],
		});

		await runtime.run("Hi");

		const replayed = model.requests[1]?.messages.find(
			(message) => message.role === "assistant",
		);
		expect(replayed?.content[0]).toEqual({
			type: "reasoning",
			text: "Plan",
			metadata: {
				openaiResponses: {
					itemId: "rs_1",
					encryptedContent: "enc-1",
					...origin,
				},
			},
		});
	});
});

describe("AgentRuntime model notices", () => {
	const notice = (
		kind: "responses_unavailable" | "reasoning_disabled_for_tools",
		modelId: string,
	): AgentModelEvent => ({
		type: "notice",
		kind,
		message: `${kind} for ${modelId}`,
		metadata: {
			kind,
			modelId,
			endpointHost: "example.openai.azure.com",
			apiProtocol: "auto",
		},
	});

	it("announces each kind once per model, across runs", async () => {
		const turn =
			(...notices: AgentModelEvent[]) =>
			(): AgentModelEvent[] => [
				...notices,
				{ type: "text-delta", text: "ok" },
				{ type: "finish", reason: "stop" },
			];
		const model = new ScriptedModel([
			turn(
				notice("responses_unavailable", "gpt-6-luna"),
				notice("reasoning_disabled_for_tools", "gpt-6-luna"),
				notice("responses_unavailable", "gpt-6-luna"),
			),
			turn(
				notice("responses_unavailable", "gpt-6-luna"),
				notice("responses_unavailable", "gpt-6-sol"),
			),
		]);
		const runtime = new AgentRuntime({ model });
		const notices: Array<{ message: string; metadata?: unknown }> = [];
		runtime.subscribe((event) => {
			if (event.type === "status-notice") {
				notices.push({ message: event.message, metadata: event.metadata });
			}
		});

		await runtime.run("first");
		await runtime.run("second");

		expect(notices).toEqual([
			{
				message: "responses_unavailable for gpt-6-luna",
				metadata: {
					kind: "responses_unavailable",
					modelId: "gpt-6-luna",
					endpointHost: "example.openai.azure.com",
					apiProtocol: "auto",
				},
			},
			{
				message: "reasoning_disabled_for_tools for gpt-6-luna",
				metadata: expect.objectContaining({
					kind: "reasoning_disabled_for_tools",
				}),
			},
			{
				message: "responses_unavailable for gpt-6-sol",
				metadata: expect.objectContaining({ modelId: "gpt-6-sol" }),
			},
		]);
	});

	it("uses the event kind even when metadata carries none", async () => {
		const model = new ScriptedModel([
			() => [
				{
					type: "notice",
					kind: "reasoning_replay_dropped",
					message: "replay dropped",
				},
				{ type: "text-delta", text: "ok" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const runtime = new AgentRuntime({ model });
		const metadata: unknown[] = [];
		runtime.subscribe((event) => {
			if (event.type === "status-notice") metadata.push(event.metadata);
		});

		const result = await runtime.run("Hi");

		expect(result.status).toBe("completed");
		expect(metadata).toEqual([{ kind: "reasoning_replay_dropped" }]);
	});
});
