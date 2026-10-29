import * as fs from "node:fs/promises"
import * as path from "node:path"
import { KNOWLEDGE_VAULT_DIR_SEGMENTS, KNOWLEDGE_VAULT_NOTES_FILENAME } from "@shared/knowledge-vault"

/** One note per completed session, as stored in the vault's JSONL file. */
export interface KnowledgeVaultNote {
	id: string
	/** Epoch milliseconds when the note was written. */
	ts: number
	/** Session (task) the note was distilled from. A session is re-distilled in place. */
	taskId: string
	/** Opening of the task prompt, used for the note's label. */
	task: string
	note: string
	template: string
	provider?: string
	model?: string
	/** `inline`: the actor wrote it in its own session; `separate`: a writer call distilled the transcript. */
	mode?: "inline" | "separate"
	/** Why the separate writer was used when `mode` is `separate` (e.g. `no_headroom`, `invalid_twice`). */
	reason?: string
}

/**
 * FIFO cap on the injected body (RSM_STORE_FIFO_CHARS): the most recent 30K
 * characters of notes are injected, older notes fall off the front.
 */
export const STORE_FIFO_CHARS = 30_000

export const MEM_WRAP_HEAD = "<memory_context>\nNotes from earlier work sessions on this repository:\n"

export function resolveKnowledgeVaultPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, ...KNOWLEDGE_VAULT_DIR_SEGMENTS, KNOWLEDGE_VAULT_NOTES_FILENAME)
}

export function noteLabel(note: KnowledgeVaultNote): string {
	const date = Number.isFinite(note.ts) ? new Date(note.ts).toISOString().slice(0, 10) : ""
	// Notes written before envelopes were stripped at write time still carry them.
	const task = note.task.replace(/<\/?user_input\b[^>]*>/g, "").trim()
	const firstLine = task.split("\n")[0]?.trim() ?? ""
	const short = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine
	return [date, short].filter(Boolean).join(" ")
}

/** The body injected before a task: every note with its label, FIFO-capped. */
export function renderVaultBody(notes: readonly KnowledgeVaultNote[], fifoChars: number = STORE_FIFO_CHARS): string {
	const body = notes.map((note) => `[${noteLabel(note)}]\n${note.note}`).join("\n\n")
	return body.length > fifoChars ? body.slice(-fifoChars) : body
}

export function wrapMemoryContext(body: string): string {
	return `${MEM_WRAP_HEAD}${body}\n</memory_context>`
}

function isNote(value: unknown): value is KnowledgeVaultNote {
	if (!value || typeof value !== "object") {
		return false
	}
	const record = value as Record<string, unknown>
	return (
		typeof record.id === "string" &&
		typeof record.ts === "number" &&
		typeof record.taskId === "string" &&
		typeof record.task === "string" &&
		typeof record.note === "string" &&
		typeof record.template === "string"
	)
}

/**
 * Append-only JSONL store of a workspace's notes. One line per note; a session
 * that completes again (follow-up turns) replaces its earlier note. Writes are
 * atomic (temp file + rename) so a crash never leaves a half-written vault.
 */
export class KnowledgeVaultStore {
	constructor(readonly filePath: string) {}

	static forWorkspace(workspaceRoot: string): KnowledgeVaultStore {
		return new KnowledgeVaultStore(resolveKnowledgeVaultPath(workspaceRoot))
	}

	async list(): Promise<KnowledgeVaultNote[]> {
		let raw: string
		try {
			raw = await fs.readFile(this.filePath, "utf8")
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return []
			}
			throw error
		}
		const notes: KnowledgeVaultNote[] = []
		for (const line of raw.split("\n")) {
			const trimmed = line.trim()
			if (!trimmed) {
				continue
			}
			try {
				const parsed: unknown = JSON.parse(trimmed)
				if (isNote(parsed)) {
					notes.push(parsed)
				}
			} catch {
				// A corrupt line loses one note, never the vault.
			}
		}
		notes.sort((a, b) => a.ts - b.ts)
		return notes
	}

	async upsert(note: KnowledgeVaultNote): Promise<KnowledgeVaultNote[]> {
		const existing = await this.list()
		const next = existing.filter((entry) => entry.taskId !== note.taskId)
		next.push(note)
		next.sort((a, b) => a.ts - b.ts)
		await this.writeAll(next)
		return next
	}

	async clear(): Promise<void> {
		await this.writeAll([])
	}

	/** Removes one note by id; a missing id is a no-op. */
	async delete(id: string): Promise<KnowledgeVaultNote[]> {
		const existing = await this.list()
		const next = existing.filter((entry) => entry.id !== id)
		if (next.length !== existing.length) {
			await this.writeAll(next)
		}
		return next
	}

	async exists(): Promise<boolean> {
		try {
			await fs.access(this.filePath)
			return true
		} catch {
			return false
		}
	}

	/** Creates an empty vault file when none exists, so it can be opened in the editor. */
	async ensureFile(): Promise<void> {
		if (!(await this.exists())) {
			await this.writeAll([])
		}
	}

	private async writeAll(notes: readonly KnowledgeVaultNote[]): Promise<void> {
		await fs.mkdir(path.dirname(this.filePath), { recursive: true })
		const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
		const content = notes.map((note) => JSON.stringify(note)).join("\n")
		await fs.writeFile(tmp, content ? `${content}\n` : "", "utf8")
		await fs.rename(tmp, this.filePath)
	}
}
