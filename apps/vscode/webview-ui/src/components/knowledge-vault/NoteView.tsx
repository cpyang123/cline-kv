import { useState } from "react"
import { cn } from "@/lib/utils"
import {
	groupNoteLines,
	NOTE_TAG_LABELS,
	type NoteLine,
	type NoteSegment,
	type ParsedNote,
	parseNote,
	parseRecallBody,
	splitPaths,
} from "./noteParser"

/** Tag colours from the editor's chart palette, so they follow the theme. */
const TAG_COLORS: Record<string, string> = {
	FILES: "var(--vscode-charts-blue)",
	STATUS: "var(--vscode-charts-green)",
	VERIFY: "var(--vscode-charts-purple)",
	DID: "var(--vscode-charts-orange)",
	CONTEXT: "var(--vscode-charts-yellow)",
	LESSON: "var(--vscode-charts-red)",
}

const Tag = ({ tag }: { tag: string }) => (
	<span
		className="inline-block shrink-0 rounded-xs px-1.5 py-px font-mono text-[10px] font-semibold tracking-wider"
		style={{
			color: TAG_COLORS[tag] ?? "var(--vscode-descriptionForeground)",
			backgroundColor: "color-mix(in srgb, var(--vscode-editor-foreground) 8%, transparent)",
		}}>
		{tag}
	</span>
)

const ExitBadge = ({ code }: { code: string }) => {
	const ok = code === "0"
	const none = code === "none"
	return (
		<span
			className="inline-block shrink-0 rounded-xs px-1 py-px font-mono text-[10px]"
			style={{
				color: none ? "var(--vscode-charts-yellow)" : ok ? "var(--vscode-charts-green)" : "var(--vscode-errorForeground)",
				backgroundColor: "color-mix(in srgb, currentColor 12%, transparent)",
			}}
			title={none ? "The change was never verified" : `Last exit code ${code}`}>
			{none ? "unverified" : `exit ${code}`}
		</span>
	)
}

const Code = ({ children, block = false }: { children: string; block?: boolean }) => (
	<code
		className={cn(
			"rounded-xs bg-editor-background/70 font-mono text-[11px] text-foreground/90",
			block ? "block whitespace-pre-wrap break-all px-1.5 py-1" : "inline break-all px-1 py-px",
		)}>
		{children}
	</code>
)

const PathChips = ({ value }: { value: string }) => (
	<span className="flex flex-wrap gap-1">
		{splitPaths(value).map((path) => (
			<Code key={path}>{path}</Code>
		))}
	</span>
)

const SegmentView = ({ segment }: { segment: NoteSegment }) => {
	const key = segment.key ?? ""
	const isPaths = key === "COVERS" || key === "FILES"
	const isCommand = key === "TESTS" || key === "VERIFY"
	const isCode = isPaths || isCommand || key === "WHERE"
	return (
		<span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1">
			{key && <span className="shrink-0 text-[10px] uppercase tracking-wider text-description">{key.toLowerCase()}</span>}
			{isPaths ? (
				<PathChips value={segment.value} />
			) : isCode ? (
				<Code block={isCommand}>{segment.value}</Code>
			) : (
				<span className="text-xs">{segment.value}</span>
			)}
			{segment.exitCode && <ExitBadge code={segment.exitCode} />}
		</span>
	)
}

const StatusWord = ({ text }: { text: string }) => {
	const lower = text.toLowerCase()
	const color =
		lower.startsWith("completed") || lower.startsWith("submitted")
			? "var(--vscode-charts-green)"
			: lower.startsWith("no code change")
				? "var(--vscode-descriptionForeground)"
				: "var(--vscode-charts-yellow)"
	return (
		<span className="text-xs font-medium" style={{ color }}>
			{text}
		</span>
	)
}

const LineView = ({ line }: { line: NoteLine }) => {
	const mainIsPaths = line.tag === "FILES"
	const mainIsCommand = line.tag === "VERIFY" && line.text.toLowerCase() !== "none"
	return (
		<li className="flex flex-col gap-1 py-1">
			<span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1">
				{mainIsPaths ? (
					<PathChips value={line.text} />
				) : line.tag === "STATUS" ? (
					<StatusWord text={line.text} />
				) : mainIsCommand ? (
					<Code block>{line.text}</Code>
				) : line.tag === "VERIFY" ? (
					<span className="text-xs text-description">not verified in that session</span>
				) : (
					<span className="text-xs text-foreground">{line.text}</span>
				)}
				{line.exitCode && <ExitBadge code={line.exitCode} />}
			</span>
			{line.segments.length > 0 && (
				<span className="flex flex-col gap-1 pl-2">
					{line.segments.map((segment, index) => (
						<SegmentView key={`${segment.key ?? "text"}-${index}`} segment={segment} />
					))}
				</span>
			)}
		</li>
	)
}

/** One parsed note, its lines grouped by category. */
export const ParsedNoteView = ({ note }: { note: ParsedNote }) => {
	const groups = groupNoteLines(note.lines)
	if (groups.length === 0 && note.untagged.length === 0) {
		return <p className="m-0 text-xs text-description">Empty note.</p>
	}
	return (
		<div className="flex flex-col gap-2">
			{groups.map((group) => (
				<section className="flex flex-col" key={group.tag}>
					<div className="flex items-center gap-2">
						<Tag tag={group.tag} />
						<span className="text-[11px] text-description">{NOTE_TAG_LABELS[group.tag] ?? ""}</span>
					</div>
					<ul className="m-0 list-none p-0 pl-1">
						{group.lines.map((line, index) => (
							<LineView key={`${group.tag}-${index}`} line={line} />
						))}
					</ul>
				</section>
			))}
			{note.untagged.length > 0 && (
				<section>
					<div className="flex items-center gap-2">
						<Tag tag="TEXT" />
						<span className="text-[11px] text-description">Unstructured lines</span>
					</div>
					<pre className="m-0 whitespace-pre-wrap break-words pl-1 font-mono text-[11px] text-foreground/80">
						{note.untagged.join("\n")}
					</pre>
				</section>
			)}
		</div>
	)
}

interface NoteViewProps {
	/** One note (a write marker, a vault entry) or a recalled body with `[label]` headers. */
	text: string
	recall?: boolean
	/** Start on the raw text instead of the structured view. */
	defaultRaw?: boolean
}

/**
 * Structured rendering of a note or of recalled notes, grouped by category,
 * with a toggle to the raw text for copying.
 */
export const NoteView = ({ text, recall = false, defaultRaw = false }: NoteViewProps) => {
	const [raw, setRaw] = useState(defaultRaw)
	const notes = recall ? parseRecallBody(text) : [parseNote(text)]
	return (
		<div className="flex flex-col gap-2" data-testid="note-view">
			{raw ? (
				<pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-foreground/90">
					{text}
				</pre>
			) : (
				notes.map((note, index) => (
					<div
						className={cn(notes.length > 1 && "rounded-xs border border-editor-widget-border/40 p-2")}
						key={`${note.label ?? "note"}-${index}`}>
						{note.label && <div className="mb-1.5 text-[11px] font-medium text-foreground/80">{note.label}</div>}
						<ParsedNoteView note={note} />
					</div>
				))
			)}
			<div>
				<button
					className="bg-transparent border-0 p-0 cursor-pointer text-[11px] text-link hover:underline"
					onClick={() => setRaw((value) => !value)}
					type="button">
					{raw ? "Show structured" : "Show raw text"}
				</button>
			</div>
		</div>
	)
}
