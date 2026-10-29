import type { AgentMessage, AgentMessagePart } from "@cline/shared"

/**
 * Builds the "work-session transcript" the writer distills, from the runtime's
 * message snapshot. Mirrors the harness's `_material` (ASSISTANT / OBSERVATION
 * blocks with per-message, total and final caps, and a trailing section about
 * what changed) so the writer prompts see input of the shape they were tuned on.
 */

export interface MaterialCaps {
	/** Per-message cap (RSM_RAW_MSG_CAP). */
	msgCap: number
	/** Cap on the transcript before the trailing files section (RSM_RAW_TOTAL_CAP). */
	totalCap: number
	/** Cap on the whole material (RSM_RAW_FINAL_CAP). */
	finalCap: number
	/** Cap on the trailing files section (DIFF_CAP). */
	filesCap: number
}

export const DEFAULT_MATERIAL_CAPS: MaterialCaps = {
	msgCap: 1200,
	totalCap: 19_000,
	finalCap: 23_000,
	filesCap: 4_000,
}

const HOOK_CONTEXT_BLOCK = /<hook_context\b[^>]*>[\s\S]*?<\/hook_context>/g
const MEMORY_CONTEXT_BLOCK = /<memory_context>[\s\S]*?<\/memory_context>/g
/** The extension wraps each prompt in a `<user_input mode="…">` envelope; it is not part of the task. */
const USER_INPUT_ENVELOPE = /<\/?user_input\b[^>]*>/g

/** Remove injected hook / memory blocks (so a note never distills earlier notes) and prompt envelopes. */
export function stripInjectedContext(text: string): string {
	return text.replace(HOOK_CONTEXT_BLOCK, "").replace(MEMORY_CONTEXT_BLOCK, "").replace(USER_INPUT_ENVELOPE, "").trim()
}

function isSystemDisplayMessage(message: AgentMessage): boolean {
	return message.metadata?.displayRole === "system"
}

type TextPart = Extract<AgentMessagePart, { type: "text" }>
type ToolCallPart = Extract<AgentMessagePart, { type: "tool-call" }>
type ToolResultPart = Extract<AgentMessagePart, { type: "tool-result" }>

function textParts(parts: readonly AgentMessagePart[]): TextPart[] {
	return parts.filter((part): part is TextPart => part.type === "text")
}

function toolCallParts(parts: readonly AgentMessagePart[]): ToolCallPart[] {
	return parts.filter((part): part is ToolCallPart => part.type === "tool-call")
}

function toolResultParts(parts: readonly AgentMessagePart[]): ToolResultPart[] {
	return parts.filter((part): part is ToolResultPart => part.type === "tool-result")
}

export function textOf(parts: readonly AgentMessagePart[]): string {
	return textParts(parts)
		.map((part) => part.text)
		.join("\n")
}

/** The task statement: the first user message that is not an injected block. */
export function firstUserPrompt(messages: readonly AgentMessage[]): string {
	for (const message of messages) {
		if (message.role !== "user" || isSystemDisplayMessage(message)) {
			continue
		}
		const text = stripInjectedContext(textOf(message.content))
		if (text) {
			return text
		}
	}
	return ""
}

export function hasAssistantMessage(messages: readonly AgentMessage[]): boolean {
	return messages.some((message) => message.role === "assistant")
}

export function hasToolCall(messages: readonly AgentMessage[]): boolean {
	return messages.some((message) => message.role === "assistant" && toolCallParts(message.content).length > 0)
}

function truncate(text: string, cap: number): string {
	return text.length > cap ? `${text.slice(0, cap)}…` : text
}

/** JSON of a tool input with long string values shortened. */
export function summarizeToolInput(input: unknown, cap: number): string {
	const valueCap = Math.max(80, Math.floor(cap / 4))
	const shorten = (value: unknown): unknown => {
		if (typeof value === "string") {
			return truncate(value, valueCap)
		}
		if (Array.isArray(value)) {
			return value.slice(0, 20).map(shorten)
		}
		if (value && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, shorten(entry)]),
			)
		}
		return value
	}
	try {
		return truncate(JSON.stringify(shorten(input)) ?? "", cap)
	} catch {
		return truncate(String(input), cap)
	}
}

/** Text of a tool result, whatever shape the tool returned it in. */
export function stringifyToolOutput(output: unknown): string {
	if (output == null) {
		return ""
	}
	if (typeof output === "string") {
		return output
	}
	if (Array.isArray(output)) {
		return output
			.map((part) => {
				if (typeof part === "string") {
					return part
				}
				if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
					return (part as { text: string }).text
				}
				return safeJson(part)
			})
			.join("\n")
	}
	if (typeof output === "object") {
		const record = output as Record<string, unknown>
		for (const key of ["text", "output", "content", "result"]) {
			if (typeof record[key] === "string") {
				return record[key] as string
			}
		}
		return safeJson(output)
	}
	return String(output)
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value)
	} catch {
		return String(value)
	}
}

const EDIT_TOOL_PATTERN = /write|edit|replace|patch|create|delete|rename|move|insert|append/i
const PATH_KEYS = ["path", "file_path", "filePath", "target_file", "targetFile", "file", "new_path", "newPath"]
const PATCH_HEADER = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm
const UNIFIED_DIFF_HEADER = /^\+\+\+ (?:b\/)?(.+)$/gm

function collectPathsFromRecord(record: Record<string, unknown>, files: Set<string>): void {
	for (const key of PATH_KEYS) {
		const value = record[key]
		if (typeof value === "string" && value.trim()) {
			files.add(value.trim())
		}
	}
	for (const key of ["patch", "diff"]) {
		const value = record[key]
		if (typeof value !== "string") {
			continue
		}
		for (const pattern of [PATCH_HEADER, UNIFIED_DIFF_HEADER]) {
			pattern.lastIndex = 0
			let match: RegExpExecArray | null = pattern.exec(value)
			while (match) {
				const file = match[1]?.trim()
				if (file && file !== "/dev/null") {
					files.add(file)
				}
				match = pattern.exec(value)
			}
		}
	}
	for (const key of ["edits", "files", "changes"]) {
		const value = record[key]
		if (!Array.isArray(value)) {
			continue
		}
		for (const entry of value) {
			if (typeof entry === "string" && entry.trim()) {
				files.add(entry.trim())
			} else if (entry && typeof entry === "object") {
				collectPathsFromRecord(entry as Record<string, unknown>, files)
			}
		}
	}
}

/** Files this session changed, read off its edit-tool calls. */
export function collectChangedFiles(messages: readonly AgentMessage[]): string[] {
	const files = new Set<string>()
	for (const message of messages) {
		if (message.role !== "assistant") {
			continue
		}
		for (const call of toolCallParts(message.content)) {
			if (!EDIT_TOOL_PATTERN.test(call.toolName) || !call.input || typeof call.input !== "object") {
				continue
			}
			collectPathsFromRecord(call.input as Record<string, unknown>, files)
		}
	}
	return [...files]
}

/**
 * The transcript handed to the writer: the task, then each assistant turn with
 * its tool calls, each tool result as an OBSERVATION, later user messages, and a
 * trailing list of the files the session's edit tools touched.
 */
export function buildSessionMaterial(messages: readonly AgentMessage[], caps: MaterialCaps = DEFAULT_MATERIAL_CAPS): string {
	const parts: string[] = []
	const task = firstUserPrompt(messages)
	if (task) {
		parts.push(`TASK:\n${task.slice(0, caps.msgCap)}`)
	}

	let seenAssistant = false
	for (const message of messages) {
		if (isSystemDisplayMessage(message)) {
			continue
		}
		if (message.role === "assistant") {
			seenAssistant = true
			const text = textOf(message.content).trim()
			const calls = toolCallParts(message.content).map(
				(call) => `TOOL CALL: ${call.toolName} ${summarizeToolInput(call.input, caps.msgCap)}`,
			)
			const body = [text ? text.slice(0, caps.msgCap) : "", ...calls].filter(Boolean).join("\n")
			if (body) {
				parts.push(`ASSISTANT:\n${body}`)
			}
			continue
		}
		if (message.role !== "user" || !seenAssistant) {
			continue
		}
		for (const result of toolResultParts(message.content)) {
			const output = stringifyToolOutput(result.output).slice(0, caps.msgCap)
			parts.push(`OBSERVATION (${result.toolName}${result.isError ? ", error" : ""}):\n${output}`)
		}
		const text = stripInjectedContext(textOf(message.content))
		if (text) {
			parts.push(`USER:\n${text.slice(0, caps.msgCap)}`)
		}
	}

	const raw = parts.join("\n\n")
	// Leave room for the files section so the final cap never swallows it.
	const head = raw.slice(0, Math.min(caps.totalCap, Math.max(0, caps.finalCap - caps.filesCap - 16)))
	const files = collectChangedFiles(messages)
	const filesSection =
		files.length > 0
			? `FILES CHANGED BY THIS SESSION (from its edit tools):\n${files.join("\n")}`.slice(0, caps.filesCap)
			: "FILES CHANGED BY THIS SESSION: none recorded"
	return `${head}\n\n${filesSection}`.slice(0, caps.finalCap)
}
