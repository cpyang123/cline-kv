/**
 * Parser for Knowledge Vault notes, for display.
 *
 * A note is a list of lines, each `TAG: main text | KEY: value | KEY: value`,
 * where a value may end in an exit-code marker such as `[exit 0]` or
 * `[last exit 1]`. Both templates fit: the v5 two-block note (FILES / STATUS /
 * VERIFY / DID / CONTEXT) and the paper's fused notes (DID / CONTEXT / LESSON,
 * with VERIFY inlined as a segment of the DID line).
 */

export const NOTE_TAG_ORDER = ["FILES", "STATUS", "VERIFY", "DID", "CONTEXT", "LESSON"] as const
export type NoteTag = (typeof NOTE_TAG_ORDER)[number]

export const NOTE_TAG_LABELS: Record<string, string> = {
	FILES: "Files touched",
	STATUS: "Outcome",
	VERIFY: "How to verify",
	DID: "What changed",
	CONTEXT: "Repository facts",
	LESSON: "Dead ends",
}

export interface NoteSegment {
	/** Segment key (WHERE, TESTS, COVERS, VERIFY, …); undefined for the line's main text. */
	key?: string
	value: string
	/** Exit code found in the segment (`0`, `1`, … or `none`), stripped from `value`. */
	exitCode?: string
}

export interface NoteLine {
	tag: string
	/** The line's main text (the first segment), without its exit marker. */
	text: string
	exitCode?: string
	/** The `| KEY: value` continuations, in order. */
	segments: NoteSegment[]
	raw: string
}

export interface ParsedNote {
	/** The `[label]` header a recalled note carries; absent for a single note. */
	label?: string
	lines: NoteLine[]
	/** Lines without a recognised `TAG:` start (shown verbatim). */
	untagged: string[]
}

export interface NoteTagGroup {
	tag: string
	lines: NoteLine[]
}

const TAG_START = /^([A-Z]+):\s*(.*)$/
const EXIT_MARKER = /\s*\[(?:last\s+)?exit\s+(\d+|none)\]\s*$/i
const SEGMENT_SEPARATOR = /\s+\|\s+/

function splitExit(value: string): { value: string; exitCode?: string } {
	const match = EXIT_MARKER.exec(value)
	if (!match) {
		return { value: value.trim() }
	}
	return { value: value.slice(0, match.index).trim(), exitCode: match[1].toLowerCase() }
}

export function parseNoteLine(raw: string): NoteLine | undefined {
	const match = TAG_START.exec(raw.trim())
	if (!match) {
		return undefined
	}
	const [, tag, rest] = match
	const parts = rest.split(SEGMENT_SEPARATOR)
	const main = splitExit(parts[0] ?? "")
	const segments: NoteSegment[] = []
	for (const part of parts.slice(1)) {
		const keyed = TAG_START.exec(part.trim())
		if (keyed) {
			const { value, exitCode } = splitExit(keyed[2])
			segments.push({ key: keyed[1], value, ...(exitCode ? { exitCode } : {}) })
		} else {
			// A stray `|` inside the main text: keep it with the text.
			const { value, exitCode } = splitExit(part)
			segments.push({ value, ...(exitCode ? { exitCode } : {}) })
		}
	}
	return { tag, text: main.value, ...(main.exitCode ? { exitCode: main.exitCode } : {}), segments, raw: raw.trim() }
}

export function parseNote(text: string, label?: string): ParsedNote {
	const lines: NoteLine[] = []
	const untagged: string[] = []
	for (const raw of text.split("\n")) {
		if (!raw.trim()) {
			continue
		}
		const line = parseNoteLine(raw)
		if (line) {
			lines.push(line)
		} else {
			untagged.push(raw.trim())
		}
	}
	return { ...(label !== undefined ? { label } : {}), lines, untagged }
}

const LABEL_LINE = /^\[(.+)\]$/

/** A recalled body is one or more notes, each introduced by a `[label]` line. */
export function parseRecallBody(body: string): ParsedNote[] {
	const notes: ParsedNote[] = []
	let label: string | undefined
	let buffer: string[] = []
	const flush = () => {
		if (label !== undefined || buffer.some((line) => line.trim())) {
			notes.push(parseNote(buffer.join("\n"), label))
		}
		buffer = []
	}
	for (const raw of body.split("\n")) {
		const match = LABEL_LINE.exec(raw.trim())
		if (match && !TAG_START.test(raw.trim())) {
			flush()
			label = match[1]
			continue
		}
		buffer.push(raw)
	}
	flush()
	return notes
}

/** Lines grouped by tag, in the template's canonical order, unknown tags last. */
export function groupNoteLines(lines: NoteLine[]): NoteTagGroup[] {
	const groups = new Map<string, NoteLine[]>()
	for (const line of lines) {
		const bucket = groups.get(line.tag) ?? []
		bucket.push(line)
		groups.set(line.tag, bucket)
	}
	const ordered: NoteTagGroup[] = []
	for (const tag of NOTE_TAG_ORDER) {
		const bucket = groups.get(tag)
		if (bucket) {
			ordered.push({ tag, lines: bucket })
			groups.delete(tag)
		}
	}
	for (const [tag, bucket] of groups) {
		ordered.push({ tag, lines: bucket })
	}
	return ordered
}

/** Comma-separated paths of a FILES line (or a COVERS segment). */
export function splitPaths(value: string): string[] {
	return value
		.split(/,\s*/)
		.map((path) => path.trim())
		.filter(Boolean)
}
