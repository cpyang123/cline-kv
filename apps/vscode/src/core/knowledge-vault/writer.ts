import type { Message, ToolDefinition } from "@cline/shared"
import type { NoteTemplateSpec } from "./note"
import { cutNote, isValidNote, normalizeWriterOutput } from "./note"

/** The slice of an `ApiHandler` the writer needs: a streamed completion. */
export interface WriterStreamChunk {
	type: string
	text?: string
	success?: boolean
	error?: string
}

export interface WriterMessage {
	role: "user" | "assistant"
	content: string
}

export interface NoteWriterHandler {
	createMessage(systemPrompt: string, messages: Message[], tools?: ToolDefinition[]): AsyncIterable<WriterStreamChunk>
	getModel(): { id: string; providerId?: string; info?: { contextWindow?: number } }
}

/** Cap on the material sent to the writer (RSM_DISTILL_CAP); the middle is cut. */
export const DEFAULT_DISTILL_CAP = 18_000

export function correctionMessage(firstTagHint: string): string {
	return (
		"INVALID OUTPUT. Do not continue the transcript or emit commands/code fences. " +
		`Output ONLY note lines, first line starting with '${firstTagHint}'.`
	)
}

/** Keep the head and the tail of a long transcript; the middle is the least informative. */
export function truncateMiddle(text: string, cap: number): string {
	if (text.length <= cap) {
		return text
	}
	const half = Math.floor(cap / 2)
	return `${text.slice(0, half)}\n...[middle truncated]...\n${text.slice(-half)}`
}

export interface DistillOptions {
	handler: NoteWriterHandler
	material: string
	template: NoteTemplateSpec
	distillCap?: number
	signal?: AbortSignal
}

export interface DistillResult {
	/** The validated, capped note; empty when the writer failed to produce one. */
	note: string
	attempts: number
	/** The writer's last normalised output, for diagnostics. */
	raw: string
	error?: string
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

/**
 * Distill a session transcript into a note. The output is validated
 * structurally; an invalid first attempt gets exactly one corrective retry that
 * names the violation (a structural guarantee, not a bet on the prompt), then the
 * note is cut to the template's cap at a line boundary.
 */
export async function distillNote(options: DistillOptions): Promise<DistillResult> {
	const { handler, template } = options
	const material = truncateMiddle(options.material, options.distillCap ?? DEFAULT_DISTILL_CAP)
	const messages: WriterMessage[] = [{ role: "user", content: material }]
	let raw = ""
	for (let attempt = 1; attempt <= 2; attempt += 1) {
		const { text, error } = await collectText(handler.createMessage(template.systemPrompt, messages), options.signal)
		if (error && !text.trim()) {
			return { note: "", attempts: attempt, raw: text, error }
		}
		raw = normalizeWriterOutput(text)
		if (isValidNote(raw, template.tags)) {
			return { note: cutNote(raw, template.noteCap), attempts: attempt, raw }
		}
		messages.splice(
			1,
			messages.length - 1,
			{ role: "assistant", content: raw.slice(0, 500) },
			{ role: "user", content: correctionMessage(template.firstTagHint) },
		)
	}
	return { note: "", attempts: 2, raw, error: "the writer's output did not validate after one retry" }
}
