import type { AgentMessage, Message } from "@cline/shared"
import { describe, expect, it } from "vitest"
import {
	closeDanglingToolCalls,
	DEFAULT_INLINE_WINDOW,
	headroomOk,
	INLINE_HEADROOM_RESERVE,
	INLINE_NOTE_MAX_TOKENS,
	lastActorPromptTokens,
	runInlineNoteTurn,
	toToolDefinitions,
} from "./inline"
import { INLINE_NOTE_INSTRUCTION } from "./prompts"
import { correctionMessage, type NoteWriterHandler, type WriterStreamChunk } from "./writer"

const VALID_NOTE =
	"FILES: src/a.ts\nSTATUS: completed | TESTS: bun test [last exit 0]\nDID: added retry | WHERE: src/a.ts:1 (retry)"

const conversation: Message[] = [
	{ role: "user", content: [{ type: "text", text: "Add a retry" }] },
	{ role: "assistant", content: [{ type: "tool_use", id: "c1", name: "write_to_file", input: { path: "src/a.ts" } }] },
	{ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", name: "write_to_file", content: "ok" }] },
	{ role: "assistant", content: [{ type: "text", text: "Done." }] },
]

function scriptedHandler(replies: Array<string | Error | { error: string }>) {
	const calls: Array<{ systemPrompt: string; messages: Message[]; tools?: unknown }> = []
	const handler: NoteWriterHandler = {
		getModel: () => ({ id: "actor", providerId: "anthropic", info: { contextWindow: 200_000 } }),
		createMessage(systemPrompt, messages, tools) {
			calls.push({ systemPrompt, messages, tools })
			const reply = replies[calls.length - 1]
			async function* stream(): AsyncGenerator<WriterStreamChunk> {
				if (reply instanceof Error) {
					throw reply
				}
				if (typeof reply === "object") {
					yield { type: "done", success: false, error: reply.error }
					return
				}
				yield { type: "text", text: reply ?? "" }
				yield { type: "done", success: true }
			}
			return stream()
		},
	}
	return { handler, calls }
}

describe("headroomOk", () => {
	it("mirrors the harness estimate and reserve", () => {
		// est = prev + trunc(ceil(tail / 3.2) * 1.15), in the same floating-point arithmetic as the harness.
		const est = 1000 + Math.trunc(Math.ceil(320 / 3.2) * 1.15)
		expect(headroomOk(1000, 320, DEFAULT_INLINE_WINDOW)).toEqual({ ok: true, estimatedPromptTokens: est })
		expect(headroomOk(1000, 0, DEFAULT_INLINE_WINDOW).estimatedPromptTokens).toBe(1000)
		expect(headroomOk(1000, 320, est + INLINE_NOTE_MAX_TOKENS + INLINE_HEADROOM_RESERVE)).toMatchObject({ ok: true })
		expect(headroomOk(1000, 320, est + INLINE_NOTE_MAX_TOKENS + INLINE_HEADROOM_RESERVE - 1)).toMatchObject({ ok: false })
		expect(headroomOk(Number.NaN, 0, 5000).estimatedPromptTokens).toBe(0)
	})
})

describe("lastActorPromptTokens", () => {
	it("sums the last assistant turn's prompt tokens including cache reads and writes", () => {
		const messages = [
			{ id: "1", role: "user", content: [], createdAt: 1 },
			{
				id: "2",
				role: "assistant",
				content: [],
				createdAt: 2,
				metrics: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
			},
			{
				id: "3",
				role: "assistant",
				content: [],
				createdAt: 3,
				metrics: { inputTokens: 100, outputTokens: 1, cacheReadTokens: 2000, cacheWriteTokens: 30 },
			},
			{ id: "4", role: "user", content: [], createdAt: 4 },
		] as AgentMessage[]
		expect(lastActorPromptTokens(messages)).toBe(2130)
		expect(lastActorPromptTokens([messages[0]])).toBe(0)
	})
})

describe("closeDanglingToolCalls / toToolDefinitions", () => {
	it("answers a trailing tool call so the provider accepts the conversation", () => {
		const closed = closeDanglingToolCalls(conversation.slice(0, 2))
		expect(closed).toHaveLength(3)
		expect(closed[2]).toEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "c1",
					name: "write_to_file",
					content: "The task has ended; this call was not executed.",
				},
			],
		})
		expect(closeDanglingToolCalls(conversation)).toHaveLength(4)
	})

	it("converts tool definitions and drops an empty list", () => {
		expect(
			toToolDefinitions([
				{ name: "t", description: "d", inputSchema: { type: "object" }, lifecycle: { completesRun: true } },
			]),
		).toEqual([{ name: "t", description: "d", inputSchema: { type: "object" } }])
		expect(toToolDefinitions([])).toBeUndefined()
		expect(toToolDefinitions(undefined)).toBeUndefined()
	})
})

describe("runInlineNoteTurn", () => {
	it("asks the actor on its own conversation and returns the parsed note", async () => {
		const { handler, calls } = scriptedHandler([`${VALID_NOTE}\n\`\`\`bash\nls\n\`\`\``])
		const result = await runInlineNoteTurn({
			handler,
			systemPrompt: "SYS",
			conversation,
			tools: [{ name: "read_file", description: "r", inputSchema: {} }],
			prevPromptTokens: 5000,
		})

		expect(result).toMatchObject({ mode: "inline", reason: "ok", turns: 1, retries: 0, note: VALID_NOTE })
		expect(calls).toHaveLength(1)
		expect(calls[0].systemPrompt).toBe("SYS")
		expect(calls[0].tools).toEqual([{ name: "read_file", description: "r", inputSchema: {} }])
		expect(calls[0].messages.slice(0, 4)).toEqual(conversation)
		expect(calls[0].messages[4]).toEqual({ role: "user", content: INLINE_NOTE_INSTRUCTION })
	})

	it("retries once with the correction and the actor's first output", async () => {
		const { handler, calls } = scriptedHandler(["I think we are done here.", VALID_NOTE])
		const result = await runInlineNoteTurn({ handler, systemPrompt: "SYS", conversation, prevPromptTokens: 0 })

		expect(result).toMatchObject({ mode: "inline", reason: "ok", turns: 2, retries: 1, note: VALID_NOTE })
		expect(calls[1].messages.slice(4)).toEqual([
			{ role: "user", content: INLINE_NOTE_INSTRUCTION },
			{ role: "assistant", content: "I think we are done here." },
			{ role: "user", content: correctionMessage("FILES:") },
		])
	})

	it("falls back after two invalid outputs, on a provider error, and on an exception", async () => {
		await expect(
			runInlineNoteTurn({
				handler: scriptedHandler(["nope", "still nope"]).handler,
				systemPrompt: "",
				conversation,
				prevPromptTokens: 0,
			}),
		).resolves.toMatchObject({ mode: "fallback", reason: "invalid_twice", turns: 2, retries: 1, note: "" })
		await expect(
			runInlineNoteTurn({
				handler: scriptedHandler([{ error: "boom" }]).handler,
				systemPrompt: "",
				conversation,
				prevPromptTokens: 0,
			}),
		).resolves.toMatchObject({ mode: "fallback", reason: "http_error", error: "boom", turns: 1 })
		await expect(
			runInlineNoteTurn({
				handler: scriptedHandler([new Error("socket")]).handler,
				systemPrompt: "",
				conversation,
				prevPromptTokens: 0,
			}),
		).resolves.toMatchObject({ mode: "fallback", reason: "exception", error: "socket" })
	})

	it("skips the turn without calling the model when the window has no headroom", async () => {
		const { handler, calls } = scriptedHandler([VALID_NOTE])
		const result = await runInlineNoteTurn({
			handler,
			systemPrompt: "",
			conversation,
			prevPromptTokens: 150_000,
			contextWindow: 128_000,
		})
		expect(result).toMatchObject({ mode: "fallback", reason: "no_headroom", turns: 0 })
		expect(result.estimatedPromptTokens).toBeGreaterThan(150_000)
		expect(calls).toHaveLength(0)
	})
})
