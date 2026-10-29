import type { AgentMessage } from "@cline/shared"
import { describe, expect, it } from "vitest"
import {
	buildSessionMaterial,
	collectChangedFiles,
	firstUserPrompt,
	hasAssistantMessage,
	hasToolCall,
	stringifyToolOutput,
	stripInjectedContext,
	summarizeToolInput,
} from "./material"

let counter = 0
function message(role: AgentMessage["role"], content: AgentMessage["content"], metadata?: Record<string, unknown>): AgentMessage {
	counter += 1
	return { id: `m${counter}`, role, content, createdAt: counter, ...(metadata ? { metadata } : {}) }
}

const session: AgentMessage[] = [
	message("user", [{ type: "text", text: "Fix the login redirect" }]),
	message(
		"user",
		[
			{
				type: "text",
				text: '<hook_context source="RunStart">\n<memory_context>\nold notes\n</memory_context>\n</hook_context>',
			},
		],
		{
			displayRole: "system",
		},
	),
	message("assistant", [
		{ type: "text", text: "Let me look at the router." },
		{ type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "src/router.ts" } },
	]),
	message("user", [{ type: "tool-result", toolCallId: "c1", toolName: "read_file", output: "export const routes = []" }]),
	message("assistant", [
		{
			type: "tool-call",
			toolCallId: "c2",
			toolName: "write_to_file",
			input: { path: "src/router.ts", content: "x".repeat(2000) },
		},
		{
			type: "tool-call",
			toolCallId: "c3",
			toolName: "apply_patch",
			input: { patch: "*** Begin Patch\n*** Update File: src/auth.ts\n@@\n-a\n+b\n*** End Patch" },
		},
	]),
	message("user", [
		{ type: "tool-result", toolCallId: "c2", toolName: "write_to_file", output: { text: "saved" } },
		{ type: "tool-result", toolCallId: "c3", toolName: "apply_patch", output: "patched", isError: false },
	]),
	message("assistant", [{ type: "tool-call", toolCallId: "c4", toolName: "run_commands", input: { command: "bun test" } }]),
	message("user", [{ type: "tool-result", toolCallId: "c4", toolName: "run_commands", output: "1 fail", isError: true }]),
	message("user", [{ type: "text", text: "please also update the docs" }]),
]

describe("stripInjectedContext", () => {
	it("removes hook and memory context blocks", () => {
		expect(stripInjectedContext('<hook_context source="x">a</hook_context> task <memory_context>b</memory_context>')).toBe(
			"task",
		)
	})
})

describe("firstUserPrompt / predicates", () => {
	it("returns the task statement and skips injected system blocks", () => {
		expect(firstUserPrompt(session)).toBe("Fix the login redirect")
		expect(firstUserPrompt([session[1]])).toBe("")
	})

	it("detects assistant turns and tool calls", () => {
		expect(hasAssistantMessage(session)).toBe(true)
		expect(hasAssistantMessage([session[0]])).toBe(false)
		expect(hasToolCall(session)).toBe(true)
		expect(hasToolCall([session[0], message("assistant", [{ type: "text", text: "hi" }])])).toBe(false)
	})
})

describe("collectChangedFiles", () => {
	it("reads paths off edit tools, including patch headers, and ignores read-only tools", () => {
		expect(collectChangedFiles(session)).toEqual(["src/router.ts", "src/auth.ts"])
	})
})

describe("tool text helpers", () => {
	it("summarises long inputs and renders every result shape as text", () => {
		const summary = summarizeToolInput({ path: "a", content: "y".repeat(5000) }, 1200)
		expect(summary.length).toBeLessThanOrEqual(1201)
		expect(summary).toContain('"path":"a"')
		expect(stringifyToolOutput("plain")).toBe("plain")
		expect(stringifyToolOutput({ text: "t" })).toBe("t")
		expect(stringifyToolOutput([{ type: "text", text: "a" }, "b"])).toBe("a\nb")
		expect(stringifyToolOutput({ code: 1 })).toBe('{"code":1}')
		expect(stringifyToolOutput(undefined)).toBe("")
	})
})

describe("buildSessionMaterial", () => {
	it("lays the transcript out as TASK / ASSISTANT / OBSERVATION blocks with a files section", () => {
		const material = buildSessionMaterial(session)
		expect(material.startsWith("TASK:\nFix the login redirect")).toBe(true)
		expect(material).toContain('ASSISTANT:\nLet me look at the router.\nTOOL CALL: read_file {"path":"src/router.ts"}')
		expect(material).toContain("OBSERVATION (read_file):\nexport const routes = []")
		expect(material).toContain("OBSERVATION (run_commands, error):\n1 fail")
		expect(material).toContain("USER:\nplease also update the docs")
		expect(material).not.toContain("old notes")
		expect(material.endsWith("FILES CHANGED BY THIS SESSION (from its edit tools):\nsrc/router.ts\nsrc/auth.ts")).toBe(true)
	})

	it("caps each message and the whole material while keeping the files section", () => {
		const long = [
			session[0],
			message("assistant", [{ type: "text", text: "z".repeat(50_000) }]),
			message("assistant", [
				{ type: "tool-call", toolCallId: "c9", toolName: "write_to_file", input: { path: "big.ts", content: "q" } },
			]),
		]
		const material = buildSessionMaterial(long, { msgCap: 100, totalCap: 400, finalCap: 600, filesCap: 100 })
		expect(material.length).toBeLessThanOrEqual(600)
		expect(material).toContain("FILES CHANGED BY THIS SESSION (from its edit tools):\nbig.ts")
		expect(material.indexOf("z".repeat(101))).toBe(-1)
	})

	it("reports when no edit tool ran", () => {
		expect(buildSessionMaterial([session[0], session[2], session[3]])).toContain(
			"FILES CHANGED BY THIS SESSION: none recorded",
		)
	})
})
