import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { AgentMessage, Message } from "@cline/shared"
import type { ClineMessage } from "@shared/ExtensionMessage"
import type { KnowledgeVaultTemplate, KnowledgeVaultWriteMode, KnowledgeVaultWriter } from "@shared/knowledge-vault"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildKnowledgeVaultHooks, KNOWLEDGE_VAULT_HOOK_NAME } from "./hooks"
import { FUSED_WRITER_PROMPT, INLINE_NOTE_INSTRUCTION, TWO_BLOCK_WRITER_PROMPT } from "./prompts"
import { KnowledgeVaultStore, MEM_WRAP_HEAD } from "./store"
import type { NoteWriterHandler, WriterStreamChunk } from "./writer"

let counter = 0
function message(role: AgentMessage["role"], content: AgentMessage["content"], extra: Partial<AgentMessage> = {}): AgentMessage {
	counter += 1
	return { id: `m${counter}`, role, content, createdAt: counter, ...extra }
}

const taskOnly: AgentMessage[] = [message("user", [{ type: "text", text: "Add a retry to the fetch helper" }])]
const fullSession: AgentMessage[] = [
	...taskOnly,
	message(
		"assistant",
		[{ type: "tool-call", toolCallId: "c1", toolName: "write_to_file", input: { path: "src/fetch.ts", content: "..." } }],
		{
			metrics: { inputTokens: 1200, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
		},
	),
	message("user", [{ type: "tool-result", toolCallId: "c1", toolName: "write_to_file", output: "ok" }]),
	message("assistant", [{ type: "text", text: "Done." }], {
		metrics: { inputTokens: 300, outputTokens: 5, cacheReadTokens: 1000, cacheWriteTokens: 0 },
	}),
]

const FUSED_NOTE =
	"DID: added retry | WHERE: src/fetch.ts:12 (fetchWithRetry) | VERIFY: none\nCONTEXT: helpers live in src/ | WHERE: src/fetch.ts"
const TWO_BLOCK_NOTE =
	"FILES: src/fetch.ts\nSTATUS: completed | TESTS: bun test [last exit 0]\nDID: added retry | WHERE: src/fetch.ts:12 (fetchWithRetry)"

interface RecordedCall {
	systemPrompt: string
	messages: Message[]
	tools?: unknown
}

/** A model that answers the scripted replies in order and records every request. */
function scriptedModel(replies: string[], contextWindow = 200_000) {
	const calls: RecordedCall[] = []
	const handler: NoteWriterHandler = {
		getModel: () => ({ id: "gpt-5.4-mini", providerId: "goodvision", info: { contextWindow } }),
		createMessage(systemPrompt, messages, tools) {
			calls.push({ systemPrompt, messages, tools })
			const text = replies[calls.length - 1] ?? ""
			async function* stream(): AsyncGenerator<WriterStreamChunk> {
				yield { type: "text", text }
				yield { type: "done", success: true }
			}
			return stream()
		},
	}
	return { handler, calls }
}

function snapshotOf(messages: AgentMessage[]) {
	return { conversationId: "conv-1", runId: "run-1", agentId: "agent-1", messages }
}

const SESSION_TOOLS = [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }]

describe("Knowledge Vault hooks", () => {
	let dir: string
	let store: KnowledgeVaultStore
	let emitted: ClineMessage[]
	let enabled: boolean

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "kv-hooks-"))
		store = KnowledgeVaultStore.forWorkspace(dir)
		emitted = []
		enabled = true
	})

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	function build(
		handler: NoteWriterHandler,
		options: {
			template?: KnowledgeVaultTemplate
			writer?: KnowledgeVaultWriter
			writeMode?: KnowledgeVaultWriteMode
			onNoteWritten?: Parameters<typeof buildKnowledgeVaultHooks>[0]["onNoteWritten"]
		} = {},
	) {
		return buildKnowledgeVaultHooks({
			isEnabled: () => enabled,
			getTemplate: () => options.template ?? "two-block",
			getWriter: () => options.writer ?? "task",
			getWriteMode: () => options.writeMode ?? "separate",
			store,
			createWriterHandler: async () => handler,
			emitHookMessage: (m) => emitted.push(m),
			onNoteWritten: options.onNoteWritten,
			now: () => Date.UTC(2026, 9, 29),
		})
	}

	function statusOf(m: ClineMessage) {
		return JSON.parse(m.text?.split("\n__HOOK_OUTPUT__\n")[0] ?? "") as { hookName: string; toolName: string; status: string }
	}

	async function completeRun(vault: ReturnType<typeof build>, messages = fullSession, captureRequest = true) {
		if (captureRequest) {
			await vault.hooks.beforeModel?.({
				snapshot: snapshotOf(messages),
				request: { systemPrompt: "SYSTEM PROMPT", messages, tools: SESSION_TOOLS },
			} as never)
		}
		await vault.hooks.afterRun?.({
			snapshot: snapshotOf(messages),
			result: { status: "completed", outputText: "Done." },
		} as never)
		await vault.waitForWrites()
	}

	it("injects nothing when the vault is empty or the session already has assistant turns", async () => {
		const { hooks } = build(scriptedModel([]).handler)
		await expect(hooks.beforeRun?.({ snapshot: snapshotOf(taskOnly) } as never)).resolves.toBeUndefined()

		await store.upsert({
			id: "n",
			ts: 1,
			taskId: "old",
			task: "Old task",
			note: "DID: old | WHERE: a:1 | VERIFY: none",
			template: "fused",
		})
		await expect(hooks.beforeRun?.({ snapshot: snapshotOf(fullSession) } as never)).resolves.toBeUndefined()
	})

	it("injects the workspace's notes as a memory_context block on a session's first run", async () => {
		await store.upsert({
			id: "n",
			ts: Date.UTC(2026, 9, 1),
			taskId: "old",
			task: "Old task",
			note: "DID: old | WHERE: a:1 | VERIFY: none",
			template: "fused",
		})
		const { hooks } = build(scriptedModel([]).handler)

		const result = await hooks.beforeRun?.({ snapshot: snapshotOf(taskOnly) } as never)
		expect(result?.appendContext).toBe(
			`${MEM_WRAP_HEAD}[2026-10-01 Old task]\nDID: old | WHERE: a:1 | VERIFY: none\n</memory_context>`,
		)
		expect(emitted).toHaveLength(1)
		expect(statusOf(emitted[0])).toEqual({
			hookName: KNOWLEDGE_VAULT_HOOK_NAME,
			toolName: "recall 1 note",
			status: "completed",
		})
	})

	it("does nothing when disabled", async () => {
		enabled = false
		await store.upsert({
			id: "n",
			ts: 1,
			taskId: "old",
			task: "Old",
			note: "DID: old | WHERE: a:1 | VERIFY: none",
			template: "fused",
		})
		const model = scriptedModel([TWO_BLOCK_NOTE])
		const vault = build(model.handler)

		await expect(vault.hooks.beforeRun?.({ snapshot: snapshotOf(taskOnly) } as never)).resolves.toBeUndefined()
		await completeRun(vault)
		expect(model.calls).toHaveLength(0)
		expect(emitted).toHaveLength(0)
	})

	it("in-session mode: the actor writes the note as a final turn of its own conversation", async () => {
		const written: unknown[] = []
		const model = scriptedModel([TWO_BLOCK_NOTE])
		const vault = build(model.handler, { writeMode: "inline", onNoteWritten: (r) => written.push(r) })

		let resolved = false
		const beforeModel = vault.hooks.beforeModel?.({
			snapshot: snapshotOf(fullSession),
			request: { systemPrompt: "SYSTEM PROMPT", messages: fullSession, tools: SESSION_TOOLS },
		} as never)
		await beforeModel
		const afterRun = vault.hooks.afterRun?.({
			snapshot: snapshotOf(fullSession),
			result: { status: "completed", outputText: "Done." },
		} as never)
		void afterRun?.then(() => {
			resolved = true
		})
		await afterRun
		expect(resolved).toBe(true) // afterRun returns before the note turn finishes
		await vault.waitForWrites()

		expect(model.calls).toHaveLength(1)
		const call = model.calls[0]
		expect(call.systemPrompt).toBe("SYSTEM PROMPT")
		expect(call.tools).toEqual(SESSION_TOOLS)
		// The actor's conversation, converted to provider form, then the note instruction.
		expect(call.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"])
		expect(call.messages[1].content).toEqual([
			{ type: "tool_use", id: "c1", name: "write_to_file", input: { path: "src/fetch.ts", content: "..." } },
		])
		expect(call.messages.at(-1)).toEqual({ role: "user", content: INLINE_NOTE_INSTRUCTION })

		const notes = await store.list()
		expect(notes).toHaveLength(1)
		expect(notes[0]).toMatchObject({
			taskId: "conv-1",
			task: "Add a retry to the fetch helper",
			template: "two-block",
			provider: "goodvision",
			model: "gpt-5.4-mini",
			mode: "inline",
			reason: "ok",
			note: TWO_BLOCK_NOTE,
		})
		expect(written).toEqual([{ note: notes[0] }])
		expect(emitted.map((m) => [statusOf(m).status, statusOf(m).toolName])).toEqual([
			["running", "write note"],
			["completed", "write note (in-session)"],
		])
		expect(emitted[0].ts).toBe(emitted[1].ts)
	})

	it("in-session mode falls back to the separate v5 writer when the actor's output is invalid twice", async () => {
		const model = scriptedModel(["Sure, done!", "Anything else?", TWO_BLOCK_NOTE])
		const vault = build(model.handler, { writeMode: "inline" })
		await completeRun(vault)

		expect(model.calls).toHaveLength(3)
		expect(model.calls[2].systemPrompt).toBe(TWO_BLOCK_WRITER_PROMPT)
		expect(model.calls[2].tools).toBeUndefined()
		expect(model.calls[2].messages[0].content).toContain("TASK:\nAdd a retry to the fetch helper")
		expect((await store.list())[0]).toMatchObject({ mode: "separate", reason: "invalid_twice", note: TWO_BLOCK_NOTE })
		expect(statusOf(emitted.at(-1)!).toolName).toBe("write note (separate: invalid_twice)")
	})

	it("skips the in-session turn when the actor's context window has no room", async () => {
		const model = scriptedModel([TWO_BLOCK_NOTE], 1500)
		const vault = build(model.handler, { writeMode: "inline" })
		await completeRun(vault)

		expect(model.calls).toHaveLength(1)
		expect(model.calls[0].systemPrompt).toBe(TWO_BLOCK_WRITER_PROMPT)
		expect((await store.list())[0]).toMatchObject({ mode: "separate", reason: "no_headroom" })
	})

	it("uses the separate writer directly by default, for the GoodVision writer, for the fused template, and for a session without a captured request", async () => {
		const cases: Array<[Parameters<typeof build>[1], string, string, string]> = [
			[{}, TWO_BLOCK_NOTE, TWO_BLOCK_WRITER_PROMPT, "separate_mode"],
			[{ writeMode: "inline", writer: "goodvision" }, TWO_BLOCK_NOTE, TWO_BLOCK_WRITER_PROMPT, "writer_not_actor"],
			[{ writeMode: "inline", template: "fused" }, FUSED_NOTE, FUSED_WRITER_PROMPT, "fused_template"],
		]
		for (const [options, reply, expectedPrompt, expectedReason] of cases) {
			await store.clear()
			const model = scriptedModel([reply])
			const vault = build(model.handler, options)
			await completeRun(vault)
			expect(model.calls).toHaveLength(1)
			expect(model.calls[0].systemPrompt).toBe(expectedPrompt)
			expect((await store.list())[0]).toMatchObject({ mode: "separate", reason: expectedReason, note: reply })
		}

		await store.clear()
		const model = scriptedModel([TWO_BLOCK_NOTE])
		await completeRun(build(model.handler, { writeMode: "inline" }), fullSession, false)
		expect(model.calls[0].systemPrompt).toBe(TWO_BLOCK_WRITER_PROMPT)
		expect((await store.list())[0]).toMatchObject({ mode: "separate", reason: "no_request" })
	})

	it("re-distills a session in place on a follow-up completion", async () => {
		const model = scriptedModel([TWO_BLOCK_NOTE, `${TWO_BLOCK_NOTE}\nCONTEXT: tests use bun | WHERE: package.json`])
		const vault = build(model.handler, { writeMode: "inline" })
		await completeRun(vault)
		await completeRun(vault)
		const notes = await store.list()
		expect(notes).toHaveLength(1)
		expect(notes[0].note).toContain("CONTEXT: tests use bun")
	})

	it("skips aborted runs and sessions that used no tool", async () => {
		const model = scriptedModel([TWO_BLOCK_NOTE])
		const vault = build(model.handler)
		await vault.hooks.afterRun?.({ snapshot: snapshotOf(fullSession), result: { status: "aborted" } } as never)
		await vault.hooks.afterRun?.({
			snapshot: snapshotOf([...taskOnly, message("assistant", [{ type: "text", text: "Just an answer" }])]),
			result: { status: "completed" },
		} as never)
		await vault.waitForWrites()
		expect(model.calls).toHaveLength(0)
		expect(await store.list()).toEqual([])
	})

	it("reports a writer that produced no valid note as a failed hook, leaving the vault unchanged", async () => {
		const written: unknown[] = []
		const vault = build(scriptedModel(["I cannot do that", "no", "still no", "nope"]).handler, {
			onNoteWritten: (r) => written.push(r),
		})
		await completeRun(vault)

		expect(await store.list()).toEqual([])
		expect(written).toEqual([{ error: "the writer's output did not validate after one retry" }])
		expect(statusOf(emitted.at(-1)!).status).toBe("failed")
	})

	it("survives a writer that throws", async () => {
		const vault = buildKnowledgeVaultHooks({
			isEnabled: () => true,
			getTemplate: () => "two-block",
			getWriter: () => "task",
			getWriteMode: () => "separate",
			store,
			createWriterHandler: vi.fn(async () => {
				throw new Error("no provider configured")
			}),
			emitHookMessage: (m) => emitted.push(m),
		})
		await completeRun(vault)
		expect(emitted.at(-1)?.text).toContain("no provider configured")
		expect(await store.list()).toEqual([])
	})
})
