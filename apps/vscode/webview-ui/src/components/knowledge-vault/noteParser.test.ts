import { describe, expect, it } from "vitest"
import { groupNoteLines, parseNote, parseNoteLine, parseRecallBody, splitPaths } from "./noteParser"

const TWO_BLOCK = [
	"FILES: /srv/peter/site/index.html, /srv/peter/site/styles.css, /srv/peter/site/script.js",
	'STATUS: completed | TESTS: cd /srv/peter/site && python3 -c "import a; assert \\"x | y\\" in b" [exit 0]',
	"VERIFY: cd /srv/peter/site && node --check script.js && echo OK [exit 0] | COVERS: /srv/peter/site/script.js",
	"VERIFY: bun test src/a.test.ts [last exit 1] | COVERS: src/a.ts, src/b.ts",
	"DID: created a dependency-free rankings site | WHERE: /srv/peter/site/index.html",
	"CONTEXT: static site, no build step | WHERE: /srv/peter/site/README.md",
].join("\n")

describe("parseNoteLine", () => {
	it("splits a line into tag, main text, keyed segments and exit codes", () => {
		const line = parseNoteLine("VERIFY: bun test src/a.test.ts [last exit 1] | COVERS: src/a.ts, src/b.ts")
		expect(line).toMatchObject({
			tag: "VERIFY",
			text: "bun test src/a.test.ts",
			exitCode: "1",
			segments: [{ key: "COVERS", value: "src/a.ts, src/b.ts" }],
		})
	})

	it("keeps an exit marker that sits on a segment with that segment", () => {
		const line = parseNoteLine("STATUS: completed | TESTS: pytest tests/ [last exit 0]")
		expect(line).toMatchObject({
			tag: "STATUS",
			text: "completed",
			segments: [{ key: "TESTS", value: "pytest tests/", exitCode: "0" }],
		})
		expect(line?.exitCode).toBeUndefined()
	})

	it("parses the paper's fused DID line with inline WHERE and VERIFY", () => {
		const line = parseNoteLine(
			"DID: added retry | WHERE: src/net.ts:12-40 (fetchWithRetry) | VERIFY: bun test src/net.test.ts [last exit 0]",
		)
		expect(line?.segments).toEqual([
			{ key: "WHERE", value: "src/net.ts:12-40 (fetchWithRetry)" },
			{ key: "VERIFY", value: "bun test src/net.test.ts", exitCode: "0" },
		])
	})

	it("treats VERIFY: none as text and rejects untagged lines", () => {
		expect(parseNoteLine("VERIFY: none | COVERS: a.ts")).toMatchObject({
			text: "none",
			segments: [{ key: "COVERS", value: "a.ts" }],
		})
		expect(parseNoteLine("just prose")).toBeUndefined()
		expect(parseNoteLine("lowercase: no")).toBeUndefined()
	})
})

describe("parseNote / groupNoteLines", () => {
	it("parses a two-block note and groups lines in canonical order", () => {
		const note = parseNote(TWO_BLOCK)
		expect(note.untagged).toEqual([])
		expect(note.lines.map((l) => l.tag)).toEqual(["FILES", "STATUS", "VERIFY", "VERIFY", "DID", "CONTEXT"])
		const groups = groupNoteLines(note.lines)
		expect(groups.map((g) => [g.tag, g.lines.length])).toEqual([
			["FILES", 1],
			["STATUS", 1],
			["VERIFY", 2],
			["DID", 1],
			["CONTEXT", 1],
		])
		expect(splitPaths(groups[0].lines[0].text)).toEqual([
			"/srv/peter/site/index.html",
			"/srv/peter/site/styles.css",
			"/srv/peter/site/script.js",
		])
	})

	it("orders fused-note tags DID, CONTEXT, LESSON and keeps unknown tags last", () => {
		const note = parseNote(
			"LESSON: do not mock fetch\nCONTEXT: tests use bun | WHERE: package.json\nDID: x | WHERE: a:1 | VERIFY: none\nNOTE: extra",
		)
		expect(groupNoteLines(note.lines).map((g) => g.tag)).toEqual(["DID", "CONTEXT", "LESSON", "NOTE"])
	})

	it("keeps lines it cannot parse as untagged text", () => {
		expect(parseNote("DID: a | WHERE: b\nsome trailing prose").untagged).toEqual(["some trailing prose"])
	})
})

describe("parseRecallBody", () => {
	it("splits a recalled body into labelled notes", () => {
		const body =
			"[2026-10-01 Old task]\nDID: old | WHERE: a:1 | VERIFY: none\n\n[2026-10-02 Second]\nFILES: b.ts\nSTATUS: completed | TESTS: bun test [last exit 0]"
		const notes = parseRecallBody(body)
		expect(notes.map((n) => n.label)).toEqual(["2026-10-01 Old task", "2026-10-02 Second"])
		expect(notes[1].lines.map((l) => l.tag)).toEqual(["FILES", "STATUS"])
	})

	it("treats a body without labels as one unlabelled note", () => {
		const notes = parseRecallBody("DID: x | WHERE: a:1")
		expect(notes).toHaveLength(1)
		expect(notes[0].label).toBeUndefined()
	})
})
