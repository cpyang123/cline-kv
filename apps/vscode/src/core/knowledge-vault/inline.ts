import type { AgentMessage, AgentToolDefinition, Message, ToolDefinition } from "@cline/shared"
import { parseInlineNote, TWO_BLOCK_TAGS } from "./note"
import { INLINE_NOTE_INSTRUCTION } from "./prompts"
import { correctionMessage, type NoteWriterHandler, type WriterStreamChunk } from "./writer"

/**
 * The in-session note turn of the v5inline arm (harness/inline_note.py).
 *
 * After the task is over, the actor is asked, on its own conversation, to write
 * the note as one more turn: the same system prompt, the same messages, the same
 * tools, plus the note instruction as the last user message. Because the prefix
 * is the actor's previous request, the provider's prompt cache absorbs most of
 * it; the new work is one assistant turn. A preflight skips the turn when the
 * context window has no room for it, and two invalid outputs (one corrective
 * retry) hand the note over to the separate writer.
 */

/** Output budget of the note turn (RSM_INLINE_MAXTOK). */
export const INLINE_NOTE_MAX_TOKENS = 900
/** Safety margin kept below the window (the harness's constant 256). */
export const INLINE_HEADROOM_RESERVE = 256
/** Window assumed when the model does not advertise one (RSM_INLINE_WINDOW default). */
export const DEFAULT_INLINE_WINDOW = 98_304

export type InlineNoteReason = "ok" | "no_headroom" | "http_error" | "invalid_twice" | "exception"

export interface InlineNoteResult {
	/** The parsed note when `mode` is `inline`, else empty. */
	note: string
	mode: "inline" | "fallback"
	reason: InlineNoteReason
	/** Note turns actually sent (0, 1 or 2). */
	turns: number
	/** 1 when the corrective retry produced the note. */
	retries: number
	estimatedPromptTokens: number
	error?: string
}

/**
 * PREFLIGHT (harness `headroom_ok`): est = previous actor prompt tokens +
 * ceil(chars(last assistant + last observation + instruction) / 3.2) * 1.15;
 * the turn goes ahead only if est + max tokens + reserve fit the window.
 */
export function headroomOk(
	prevPromptTokens: number,
	tailChars: number,
	window: number = DEFAULT_INLINE_WINDOW,
	maxTokens: number = INLINE_NOTE_MAX_TOKENS,
): { ok: boolean; estimatedPromptTokens: number } {
	const estimatedPromptTokens = Math.trunc(prevPromptTokens || 0) + Math.trunc(Math.ceil(tailChars / 3.2) * 1.15)
	return { ok: estimatedPromptTokens + maxTokens + INLINE_HEADROOM_RESERVE <= window, estimatedPromptTokens }
}

/** Prompt tokens of the actor's last model call, cache reads and writes included. */
export function lastActorPromptTokens(messages: readonly AgentMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]
		if (message?.role === "assistant" && message.metrics) {
			const { inputTokens, cacheReadTokens, cacheWriteTokens } = message.metrics
			return (inputTokens || 0) + (cacheReadTokens || 0) + (cacheWriteTokens || 0)
		}
	}
	return 0
}

function contentChars(message: Message): number {
	if (typeof message.content === "string") {
		return message.content.length
	}
	try {
		return JSON.stringify(message.content).length
	} catch {
		return 0
	}
}

/**
 * A provider rejects a conversation whose last assistant turn still has
 * tool calls without results. A run that ended on its completion tool can look
 * like that; close such calls with a neutral result so the note turn is valid.
 */
export function closeDanglingToolCalls(conversation: readonly Message[]): Message[] {
	const messages = conversation.map((message) => ({ ...message }))
	const last = messages[messages.length - 1]
	if (!last || last.role !== "assistant" || typeof last.content === "string") {
		return messages
	}
	const dangling = last.content.filter((block) => block.type === "tool_use")
	if (dangling.length === 0) {
		return messages
	}
	messages.push({
		role: "user",
		content: dangling.map((block) => ({
			type: "tool_result" as const,
			tool_use_id: block.id,
			name: block.name,
			content: "The task has ended; this call was not executed.",
		})),
	})
	return messages
}

export function toToolDefinitions(tools: readonly AgentToolDefinition[] | undefined): ToolDefinition[] | undefined {
	if (!tools || tools.length === 0) {
		return undefined
	}
	return tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
}

export interface InlineNoteTurnInput {
	handler: NoteWriterHandler
	/** The session's system prompt, captured from its last model request. */
	systemPrompt: string
	/** The session's conversation in provider form (see `agentMessagesToMessages`). */
	conversation: readonly Message[]
	/** The session's tool definitions; sent again so the prefix matches the actor's requests. */
	tools?: readonly AgentToolDefinition[]
	prevPromptTokens: number
	contextWindow?: number
	instruction?: string
	tags?: readonly string[]
	noteCap?: number
	signal?: AbortSignal
}

async function collectText(
	stream: AsyncIterable<WriterStreamChunk>,
	signal?: AbortSignal,
): Promise<{ text: string; error?: string }> {
	let text = ""
	let error: string | undefined
	for await (const chunk of stream) {
		signal?.throwIfAborted()
		if (chunk.type === "text" && typeof chunk.text === "string") {
			text += chunk.text
		} else if (chunk.type === "done" && chunk.success === false) {
			error = chunk.error ?? "the provider stream ended with an error"
		}
	}
	return { text, error }
}

export async function runInlineNoteTurn(input: InlineNoteTurnInput): Promise<InlineNoteResult> {
	const instruction = input.instruction ?? INLINE_NOTE_INSTRUCTION
	const tags = input.tags ?? TWO_BLOCK_TAGS
	const conversation = closeDanglingToolCalls(input.conversation)
	const tailChars = conversation.slice(-2).reduce((sum, message) => sum + contentChars(message), 0) + instruction.length
	const headroom = headroomOk(input.prevPromptTokens, tailChars, input.contextWindow ?? DEFAULT_INLINE_WINDOW)
	const result: InlineNoteResult = {
		note: "",
		mode: "fallback",
		reason: "no_headroom",
		turns: 0,
		retries: 0,
		estimatedPromptTokens: headroom.estimatedPromptTokens,
	}
	if (!headroom.ok) {
		return result
	}

	const tools = toToolDefinitions(input.tools)
	let messages: Message[] = [...conversation, { role: "user", content: instruction }]
	let raw = ""
	try {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const { text, error } = await collectText(
				input.handler.createMessage(input.systemPrompt, messages, tools),
				input.signal,
			)
			result.turns += 1
			if (error && !text.trim()) {
				return { ...result, reason: "http_error", error }
			}
			raw = text
			const parsed = parseInlineNote(raw, tags, input.noteCap)
			if (parsed.ok) {
				return { ...result, note: parsed.note, mode: "inline", reason: "ok", retries: attempt }
			}
			// CALL#2: the corrective retry names the violation, as the separate writer does.
			messages = [
				...conversation,
				{ role: "user", content: instruction },
				{ role: "assistant", content: raw.slice(0, 500) },
				{ role: "user", content: correctionMessage(tags[0] ?? "FILES:") },
			]
		}
		return { ...result, reason: "invalid_twice", retries: 1 }
	} catch (error) {
		// The note turn must never take the task down with it.
		return { ...result, reason: "exception", error: error instanceof Error ? error.message : String(error) }
	}
}
