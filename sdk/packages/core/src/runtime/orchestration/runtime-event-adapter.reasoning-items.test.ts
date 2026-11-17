import type { AgentMessage, AgentRuntimeStateSnapshot } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { RuntimeEventAdapter } from "./runtime-event-adapter";

/**
 * Host projection of OpenAI Responses reasoning items and model notices:
 * text-free items stay out of the UI, notice metadata reaches the host.
 */

const snapshot = {
	agentId: "agent_test",
	runId: "run_test",
	status: "running",
	iteration: 1,
	messages: [],
	pendingToolCalls: [],
	usage: {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalCost: 0,
	},
} as AgentRuntimeStateSnapshot;

const item = (itemId: string) => ({
	openaiResponses: {
		itemId,
		encryptedContent: "enc",
		providerId: "openai-compatible",
		modelId: "gpt-6-luna",
	},
});

function assistant(content: AgentMessage["content"]): AgentMessage {
	return { id: "msg", role: "assistant", content, createdAt: 1 };
}

describe("RuntimeEventAdapter: OpenAI Responses reasoning items", () => {
	it("renders no reasoning for an item without summary text", () => {
		const out = new RuntimeEventAdapter().translate({
			type: "assistant-message",
			snapshot,
			iteration: 1,
			message: assistant([
				{ type: "reasoning", text: "", metadata: item("rs_1") },
				{ type: "tool-call", toolCallId: "c", toolName: "t", input: {} },
			]),
			finishReason: "tool-calls",
		});
		expect(out).toEqual([]);
	});

	it("renders only the items with summary text", () => {
		const out = new RuntimeEventAdapter().translate({
			type: "assistant-message",
			snapshot,
			iteration: 1,
			message: assistant([
				{ type: "reasoning", text: "Plan", metadata: item("rs_1") },
				{ type: "reasoning", text: "", metadata: item("rs_2") },
				{ type: "text", text: "done" },
			]),
			finishReason: "stop",
		});
		expect(out).toContainEqual({
			type: "content_end",
			contentType: "reasoning",
			reasoning: "Plan",
		});
	});

	it("separates reasoning items with a blank line, other parts as before", () => {
		const translate = (content: AgentMessage["content"]) =>
			new RuntimeEventAdapter().translate({
				type: "assistant-message",
				snapshot,
				iteration: 1,
				message: assistant([...content, { type: "text", text: "done" }]),
				finishReason: "stop",
			});
		expect(
			translate([
				{
					type: "reasoning",
					text: "Checked the file.",
					metadata: item("rs_1"),
				},
				{ type: "reasoning", text: "Now edit it.", metadata: item("rs_2") },
			]),
		).toContainEqual({
			type: "content_end",
			contentType: "reasoning",
			reasoning: "Checked the file.\n\nNow edit it.",
		});
		expect(
			translate([
				{ type: "reasoning", text: "Think" },
				{ type: "reasoning", text: "ing" },
			]),
		).toContainEqual({
			type: "content_end",
			contentType: "reasoning",
			reasoning: "Thinking",
		});
	});

	it("still renders redacted reasoning", () => {
		const out = new RuntimeEventAdapter().translate({
			type: "assistant-message",
			snapshot,
			iteration: 1,
			message: assistant([
				{
					type: "reasoning",
					text: "",
					redacted: true,
					metadata: { data: "x" },
				},
			]),
			finishReason: "stop",
		});
		expect(out).toEqual([
			{ type: "content_end", contentType: "reasoning", reasoning: "" },
		]);
	});

	it("forwards model notice metadata on status notices", () => {
		const metadata = {
			kind: "responses_unavailable",
			modelId: "gpt-6-luna",
			endpointHost: "example.openai.azure.com",
			apiProtocol: "auto",
		};
		const out = new RuntimeEventAdapter().translate({
			type: "status-notice",
			snapshot,
			message: "fallback",
			metadata,
		});
		expect(out).toEqual([
			{
				type: "notice",
				noticeType: "status",
				displayRole: "status",
				message: "fallback",
				reason: undefined,
				metadata,
			},
		]);
	});
});
