import type { KnowledgeVaultTemplate } from "@shared/knowledge-vault"
import { FUSED_WRITER_PROMPT, TWO_BLOCK_WRITER_PROMPT } from "./prompts"

/**
 * A note template: the writer's system prompt plus the structural contract the
 * writer's output must satisfy (allowed line starts, the hint used in the
 * corrective retry, and the hard character cap applied after validation).
 */
export interface NoteTemplateSpec {
	id: KnowledgeVaultTemplate
	systemPrompt: string
	/** Allowed line starts. The first line must begin with one of them. */
	tags: readonly string[]
	/** Tag named in the corrective retry when the first attempt was invalid. */
	firstTagHint: string
	/**
	 * Hard cap on the stored note (RSM_NOTE_CAP in the harness). Writers do not
	 * reliably honour the prompt's character budget, so this cap is what
	 * actually enforces it (see `cutNote` for how it cuts).
	 */
	noteCap: number
}

export const FUSED_TAGS = ["DID:", "CONTEXT:", "LESSON:"] as const
export const TWO_BLOCK_TAGS = ["FILES:", "STATUS:", "VERIFY:", "DID:", "CONTEXT:"] as const
export const DEFAULT_NOTE_CAP = 1500

export const NOTE_TEMPLATES: Record<KnowledgeVaultTemplate, NoteTemplateSpec> = {
	fused: {
		id: "fused",
		systemPrompt: FUSED_WRITER_PROMPT,
		tags: FUSED_TAGS,
		firstTagHint: "DID:",
		noteCap: DEFAULT_NOTE_CAP,
	},
	"two-block": {
		id: "two-block",
		systemPrompt: TWO_BLOCK_WRITER_PROMPT,
		tags: TWO_BLOCK_TAGS,
		firstTagHint: "FILES:",
		noteCap: DEFAULT_NOTE_CAP,
	},
}

/**
 * Normalise raw writer output: drop a thinking prefix, surrounding backticks and
 * blank lines, and a leading code-fence marker.
 */
export function normalizeWriterOutput(raw: string): string {
	const afterThinking = raw.split("</think>").pop() ?? ""
	let text = afterThinking
		.trim()
		.replace(/^[`\n ]+/, "")
		.replace(/[`\n ]+$/, "")
	if (text.startsWith("```")) {
		text = text.slice(3)
	}
	return text.trim()
}

/**
 * Structural validation (the v2 rule of the harness validator): the output must
 * start with an allowed tag and must not contain a code fence, which is how a
 * writer that "continued the transcript" instead of distilling it reveals
 * itself. Mentioning a tool name is allowed.
 */
export function isValidNote(text: string, tags: readonly string[]): boolean {
	const trimmed = text.trim()
	if (!trimmed) {
		return false
	}
	if (!tags.some((tag) => trimmed.startsWith(tag))) {
		return false
	}
	return !trimmed.includes("```")
}

/**
 * Validator revision (the harness's RSM_VALID_V2). The reported v5 runs left it
 * unset: a note over the cap is truncated plainly. The later v2 rule cuts at the
 * last complete line instead (the demo runs with it). Kept as one switch so both
 * paths, separate and in-session, agree.
 */
export const NOTE_VALIDATOR_V2 = false

/** Cut a note to `cap` characters: plainly, or at the last complete line under the v2 rule. */
export function cutNote(text: string, cap: number, lineBoundary: boolean = NOTE_VALIDATOR_V2): string {
	if (text.length <= cap) {
		return text
	}
	const head = text.slice(0, cap)
	if (!lineBoundary) {
		return head
	}
	const lastBreak = head.lastIndexOf("\n")
	return lastBreak > 0 ? head.slice(0, lastBreak).trimEnd() : head
}

/** Non-empty lines of a note. */
export function noteLines(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
}

/** Line type of a note line (`DID`, `CONTEXT`, …) or undefined for an untagged line. */
export function noteLineTag(line: string): string | undefined {
	const match = /^([A-Z]+):/.exec(line.trim())
	return match?.[1]
}

const FENCE_BLOCK = /```[\s\S]*?(?:```|$)/g
const THOUGHT_LINE = /^\s*THOUGHT\s*:.*$/gm

/**
 * Lenient parse of an in-session note (v5inline `strip_action_residue`): drop a
 * thinking section, every code-fence block (a command the actor tried to run
 * anyway), THOUGHT lines, and any line that does not start with a note tag; then
 * cut at the cap. More forgiving than the separate writer's validator on
 * purpose: the actor writes with its whole session in context and is prone to
 * trailing habits, not to inventing content.
 */
export function stripActionResidue(raw: string, tags: readonly string[], cap: number = DEFAULT_NOTE_CAP): string {
	const afterThinking = (raw ?? "").split("</think>").pop() ?? ""
	const stripped = afterThinking.replace(FENCE_BLOCK, "").replace(THOUGHT_LINE, "")
	const kept = stripped
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => tags.some((tag) => line.trimStart().startsWith(tag)))
	return cutNote(kept.join("\n").trim(), cap)
}

/** Parse the actor's in-session note; `ok` applies the same validator as the separate writer. */
export function parseInlineNote(
	raw: string,
	tags: readonly string[],
	cap: number = DEFAULT_NOTE_CAP,
): { note: string; ok: boolean } {
	const note = stripActionResidue(raw, tags, cap)
	return { note, ok: isValidNote(note, tags) }
}
