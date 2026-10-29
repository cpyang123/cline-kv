import type { Message } from "@cline/shared"
import { describe, expect, it } from "vitest"
import { NOTE_TEMPLATES } from "./note"
import { correctionMessage, distillNote, type NoteWriterHandler, truncateMiddle, type WriterStreamChunk } from "./writer"

function handlerReplying(replies: string[], options: { failFirst?: boolean } = {}) {
	const calls: Array<{ systemPrompt: string; messages: Message[] }> = []
	const handler: NoteWriterHandler = {
		getModel: () => ({ id: "writer-model", providerId: "test" }),
		createMessage(systemPrompt, messages) {
			calls.push({ systemPrompt, messages: messages.map((m) => ({ ...m })) })
			const reply = replies[calls.length - 1] ?? ""
			const failing = options.failFirst && calls.length === 1
			async function* stream(): AsyncGenerator<WriterStreamChunk> {
				if (failing) {
					yield { type: "done", success: false, error: "boom" }
					return
				}
				const middle = Math.floor(reply.length / 2)
				yield { type: "text", text: reply.slice(0, middle) }
				yield { type: "usage" }
				yield { type: "text", text: reply.slice(middle) }
				yield { type: "done", success: true }
			}
			return stream()
		},
	}
	return { handler, calls }
}

describe("truncateMiddle", () => {
	it("keeps the head and the tail of over-long material", () => {
		expect(truncateMiddle("short", 100)).toBe("short")
		const cut = truncateMiddle(`${"a".repeat(100)}${"b".repeat(100)}`, 40)
		expect(cut.startsWith("a".repeat(20))).toBe(true)
		expect(cut.endsWith("b".repeat(20))).toBe(true)
		expect(cut).toContain("...[middle truncated]...")
	})
})

describe("distillNote", () => {
	const template = NOTE_TEMPLATES.fused

	it("sends the template prompt with the material and returns a validated note", async () => {
		const { handler, calls } = handlerReplying([
			"DID: changed x | WHERE: a.ts:1 | VERIFY: bun test [last exit 0]\nCONTEXT: bun runs tests | WHERE: package.json",
		])
		const result = await distillNote({ handler, material: "ASSISTANT:\nhello", template })

		expect(result.attempts).toBe(1)
		expect(result.note).toBe(
			"DID: changed x | WHERE: a.ts:1 | VERIFY: bun test [last exit 0]\nCONTEXT: bun runs tests | WHERE: package.json",
		)
		expect(calls[0]?.systemPrompt).toBe(template.systemPrompt)
		expect(calls[0]?.messages).toEqual([{ role: "user", content: "ASSISTANT:\nhello" }])
	})

	it("retries once with the correction message when the first output is invalid", async () => {
		const { handler, calls } = handlerReplying(["```bash\nls\n```", "DID: ok | WHERE: a.ts:1 | VERIFY: none"])
		const result = await distillNote({ handler, material: "m", template })

		expect(result.attempts).toBe(2)
		expect(result.note).toBe("DID: ok | WHERE: a.ts:1 | VERIFY: none")
		expect(calls[1]?.messages).toEqual([
			{ role: "user", content: "m" },
			{ role: "assistant", content: "bash\nls" },
			{ role: "user", content: correctionMessage("DID:") },
		])
	})

	it("gives up after the retry with an empty note", async () => {
		const { handler } = handlerReplying(["nope", "still nope"])
		const result = await distillNote({ handler, material: "m", template })
		expect(result.note).toBe("")
		expect(result.attempts).toBe(2)
		expect(result.error).toContain("did not validate")
	})

	it("reports a provider failure that produced no text", async () => {
		const { handler } = handlerReplying([""], { failFirst: true })
		const result = await distillNote({ handler, material: "m", template })
		expect(result).toMatchObject({ note: "", attempts: 1, error: "boom" })
	})

	it("cuts the note to the template cap and middle-truncates the material", async () => {
		const longNote = Array.from({ length: 40 }, (_, i) => `DID: step ${i} | WHERE: f${i}.ts:1 | VERIFY: none`).join("\n")
		const { handler, calls } = handlerReplying([longNote])
		const result = await distillNote({ handler, material: "x".repeat(50_000), template, distillCap: 1000 })

		expect(result.note).toHaveLength(template.noteCap)
		expect(longNote.startsWith(result.note)).toBe(true)
		expect(calls[0]?.messages[0]?.content).toContain("...[middle truncated]...")
		expect(calls[0]?.messages[0]?.content.length).toBeLessThan(1100)
	})
})
