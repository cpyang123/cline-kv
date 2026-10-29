import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	type KnowledgeVaultNote,
	KnowledgeVaultStore,
	MEM_WRAP_HEAD,
	noteLabel,
	renderVaultBody,
	resolveKnowledgeVaultPath,
	wrapMemoryContext,
} from "./store"

function note(overrides: Partial<KnowledgeVaultNote> = {}): KnowledgeVaultNote {
	return {
		id: "n1",
		ts: Date.UTC(2026, 9, 29, 12),
		taskId: "task-1",
		task: "Fix the login redirect\nmore detail",
		note: "DID: fixed redirect | WHERE: src/auth.ts:10 | VERIFY: bun test [last exit 0]\nCONTEXT: tests use bun | WHERE: package.json",
		template: "fused",
		...overrides,
	}
}

describe("vault paths and rendering", () => {
	it("places the vault under .cline/knowledge-vault in the workspace", () => {
		expect(resolveKnowledgeVaultPath("/ws")).toBe(path.join("/ws", ".cline", "knowledge-vault", "notes.jsonl"))
	})

	it("labels notes by date and the task's first line", () => {
		expect(noteLabel(note())).toBe("2026-10-29 Fix the login redirect")
		expect(noteLabel(note({ task: "x".repeat(100) }))).toBe(`2026-10-29 ${"x".repeat(77)}...`)
		expect(noteLabel(note({ task: '<user_input mode="act">Create a site</user_input>' }))).toBe("2026-10-29 Create a site")
	})

	it("renders labelled notes and keeps only the most recent 30K characters", () => {
		const body = renderVaultBody([note(), note({ id: "n2", taskId: "task-2", task: "Second" })])
		expect(body.startsWith("[2026-10-29 Fix the login redirect]\nDID: fixed redirect")).toBe(true)
		expect(body).toContain("\n\n[2026-10-29 Second]\n")

		const big = renderVaultBody([note({ note: "a".repeat(40_000) })], 1000)
		expect(big).toHaveLength(1000)
		expect(big).toBe("a".repeat(1000))
	})

	it("wraps the body in the memory_context envelope", () => {
		expect(wrapMemoryContext("body")).toBe(`${MEM_WRAP_HEAD}body\n</memory_context>`)
	})
})

describe("KnowledgeVaultStore", () => {
	let dir: string
	let store: KnowledgeVaultStore

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "kv-store-"))
		store = KnowledgeVaultStore.forWorkspace(dir)
	})

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("lists nothing for a workspace without a vault", async () => {
		expect(await store.list()).toEqual([])
	})

	it("creates the vault directory, appends notes, and replaces a session's earlier note", async () => {
		await store.upsert(note())
		await store.upsert(note({ id: "n2", taskId: "task-2", ts: Date.UTC(2026, 9, 30), task: "Second" }))
		expect((await store.list()).map((n) => n.id)).toEqual(["n1", "n2"])

		await store.upsert(note({ id: "n3", taskId: "task-1", ts: Date.UTC(2026, 9, 31), note: "DID: redone" }))
		const notes = await store.list()
		expect(notes.map((n) => n.id)).toEqual(["n2", "n3"])
		expect(notes[1]?.note).toBe("DID: redone")

		const raw = await fs.readFile(store.filePath, "utf8")
		expect(raw.trim().split("\n")).toHaveLength(2)
		expect(await fs.readdir(path.dirname(store.filePath))).toEqual(["notes.jsonl"])
	})

	it("skips corrupt lines instead of failing the whole vault", async () => {
		await fs.mkdir(path.dirname(store.filePath), { recursive: true })
		await fs.writeFile(store.filePath, `${JSON.stringify(note())}\nnot json\n{"id":"x"}\n`, "utf8")
		expect((await store.list()).map((n) => n.id)).toEqual(["n1"])
	})

	it("clears the vault", async () => {
		await store.upsert(note())
		await store.clear()
		expect(await store.list()).toEqual([])
	})
})
