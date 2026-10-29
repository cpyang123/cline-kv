import { describe, expect, it } from "vitest"
import {
	cutNote,
	FUSED_TAGS,
	isValidNote,
	NOTE_TEMPLATES,
	NOTE_VALIDATOR_V2,
	normalizeWriterOutput,
	noteLines,
	noteLineTag,
	parseInlineNote,
	stripActionResidue,
	TWO_BLOCK_TAGS,
} from "./note"

describe("normalizeWriterOutput", () => {
	it("drops a thinking prefix, surrounding backticks and a leading fence marker", () => {
		expect(normalizeWriterOutput("<think>hmm</think>\n```\nDID: x | WHERE: a.py:1 | VERIFY: none\n```")).toBe(
			"DID: x | WHERE: a.py:1 | VERIFY: none",
		)
		expect(normalizeWriterOutput("  \n`DID: y`\n ")).toBe("DID: y")
	})
})

describe("isValidNote", () => {
	it("accepts output whose first line starts with an allowed tag", () => {
		expect(
			isValidNote(
				"DID: added parser | WHERE: src/p.ts:10-20 (parse) | VERIFY: bun test src/p.test.ts [last exit 0]",
				FUSED_TAGS,
			),
		).toBe(true)
		expect(isValidNote("FILES: src/p.ts\nSTATUS: completed | TESTS: bun test [last exit 0]", TWO_BLOCK_TAGS)).toBe(true)
	})

	it("rejects empty output, a wrong first tag, and transcript continuations with code fences", () => {
		expect(isValidNote("", FUSED_TAGS)).toBe(false)
		expect(isValidNote("FILES: a.py", FUSED_TAGS)).toBe(false)
		expect(isValidNote("DID: x\n```bash\nls\n```", FUSED_TAGS)).toBe(false)
	})

	it("does not reject a note merely for mentioning a tool name (validator v2 rule)", () => {
		expect(isValidNote("LESSON: /tmp is cleared between run_commands invocations", FUSED_TAGS)).toBe(true)
	})
})

describe("cutNote", () => {
	it("returns short notes unchanged and truncates long notes plainly by default (RSM_VALID_V2 unset)", () => {
		const note = "DID: one\nCONTEXT: two\nLESSON: three"
		expect(NOTE_VALIDATOR_V2).toBe(false)
		expect(cutNote(note, 100)).toBe(note)
		expect(cutNote(note, 15)).toBe("DID: one\nCONTEX")
	})

	it("cuts at the last complete line under the v2 rule, with a hard cut inside the first line", () => {
		const note = "DID: one\nCONTEXT: two\nLESSON: three"
		expect(cutNote(note, 15, true)).toBe("DID: one")
		expect(cutNote("DID: a very long first line", 5, true)).toBe("DID: ")
	})
})

describe("templates", () => {
	it("defines both templates with their tag grammar and the correction hint", () => {
		expect(NOTE_TEMPLATES.fused.tags).toEqual(["DID:", "CONTEXT:", "LESSON:"])
		expect(NOTE_TEMPLATES.fused.firstTagHint).toBe("DID:")
		expect(NOTE_TEMPLATES["two-block"].tags).toEqual(["FILES:", "STATUS:", "VERIFY:", "DID:", "CONTEXT:"])
		expect(NOTE_TEMPLATES["two-block"].systemPrompt).toContain("=== TASK BLOCK")
	})

	it("splits notes into tagged lines", () => {
		expect(noteLines("DID: a\n\nCONTEXT: b\n")).toEqual(["DID: a", "CONTEXT: b"])
		expect(noteLineTag("VERIFY: pytest [exit 0]")).toBe("VERIFY")
		expect(noteLineTag("no tag here")).toBeUndefined()
	})
})

describe("stripActionResidue / parseInlineNote (in-session note)", () => {
	it("drops thinking, fenced commands, THOUGHT lines and untagged lines, keeping tagged lines in order", () => {
		const raw = [
			"<think>plan</think>",
			"THOUGHT: let me also run the tests",
			"```bash",
			"bun test",
			"```",
			"Here is the note:",
			"FILES: src/a.ts",
			"  STATUS: completed | TESTS: bun test [last exit 0]",
			"DID: added retry | WHERE: src/a.ts:1 (retry)",
			"Hope this helps!",
		].join("\n")
		const { note, ok } = parseInlineNote(raw, TWO_BLOCK_TAGS)
		expect(ok).toBe(true)
		expect(note).toBe(
			"FILES: src/a.ts\n  STATUS: completed | TESTS: bun test [last exit 0]\nDID: added retry | WHERE: src/a.ts:1 (retry)",
		)
	})

	it("reports an output with no tagged line as invalid and applies the cap at a line boundary", () => {
		expect(parseInlineNote("I could not finish.", TWO_BLOCK_TAGS)).toEqual({ note: "", ok: false })
		// The cap applies after residue stripping, with the same cut rule as the separate writer.
		const three = "FILES: a\nDID: one | WHERE: a:1\nDID: two | WHERE: a:2"
		expect(stripActionResidue(three, TWO_BLOCK_TAGS, 30)).toBe("FILES: a\nDID: one | WHERE: a:1")
		expect(stripActionResidue(three, TWO_BLOCK_TAGS, 12)).toBe("FILES: a\nDID")
	})
})
