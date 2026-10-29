import type { ClineKnowledgeVaultInfo, ClineMessage } from "@shared/ExtensionMessage"
import { EmptyRequest, StringRequest } from "@shared/proto/cline/common"
import type { KnowledgeVaultNote, KnowledgeVaultSnapshot } from "@shared/proto/cline/knowledge_vault"
import { BrainIcon, ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon, RefreshCwIcon, Trash2Icon } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { KnowledgeVaultServiceClient } from "@/services/grpc-client"
import { formatKnowledgeVaultLabel, parseKnowledgeVaultInfo } from "../chat/KnowledgeVaultRow"
import ViewHeader from "../common/ViewHeader"
import { NoteView } from "./NoteView"

interface KnowledgeVaultViewProps {
	onDone: () => void
}

function formatWhen(ts: number): string {
	if (!Number.isFinite(ts) || ts <= 0) {
		return ""
	}
	return new Date(ts).toLocaleString()
}

/** A collapsible block of note text with a one-line header. */
const MemoryBlock = ({
	title,
	meta,
	body,
	kind = "note",
	defaultOpen = false,
	muted = false,
	actions,
}: {
	title: string
	meta?: string
	body?: string
	/** How to render the body: a single note, a recalled body with labels, or plain text. */
	kind?: "note" | "recall" | "text"
	defaultOpen?: boolean
	muted?: boolean
	actions?: React.ReactNode
}) => {
	const [open, setOpen] = useState(defaultOpen)
	const canOpen = Boolean(body)
	const Chevron = open ? ChevronDownIcon : ChevronRightIcon
	return (
		<div className="rounded-xs border border-editor-widget-border/50 mb-2">
			<div className="flex items-center gap-2 px-2 py-1.5">
				<button
					aria-expanded={canOpen ? open : undefined}
					className={`flex flex-1 min-w-0 items-center gap-2 bg-transparent border-0 p-0 text-left ${canOpen ? "cursor-pointer" : "cursor-default"} ${muted ? "text-description" : "text-foreground"}`}
					onClick={() => canOpen && setOpen((value) => !value)}
					type="button">
					{canOpen ? <Chevron className="size-3 shrink-0" /> : <span className="size-3 shrink-0" />}
					<span className="truncate text-xs">{title}</span>
					{meta && <span className="shrink-0 text-[11px] text-description">{meta}</span>}
				</button>
				{actions}
			</div>
			{open && canOpen && (
				<div className="max-h-96 overflow-auto border-t border-editor-widget-border/50 px-2 py-2">
					{kind === "text" ? (
						<pre className="m-0 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-foreground/90">
							{body}
						</pre>
					) : (
						<NoteView recall={kind === "recall"} text={body ?? ""} />
					)}
				</div>
			)}
		</div>
	)
}

/** Memory activity of the task shown in the chat: what was recalled, what was written. */
function sessionMemory(messages: ClineMessage[]): Array<{ ts: number; info: ClineKnowledgeVaultInfo }> {
	const entries: Array<{ ts: number; info: ClineKnowledgeVaultInfo }> = []
	for (const message of messages) {
		if (message.type !== "say" || message.say !== "knowledge_vault") {
			continue
		}
		const info = parseKnowledgeVaultInfo(message.text)
		if (info) {
			entries.push({ ts: message.ts, info })
		}
	}
	return entries
}

/**
 * The Memory view: this task's recalled and written memory (session memory)
 * and the workspace's whole vault (cross-session memory), with the notes file
 * one click away.
 */
const KnowledgeVaultView = ({ onDone }: KnowledgeVaultViewProps) => {
	const { clineMessages, knowledgeVaultEnabled, navigateToSettings } = useExtensionState()
	const [snapshot, setSnapshot] = useState<KnowledgeVaultSnapshot | undefined>(undefined)
	const [error, setError] = useState<string | undefined>(undefined)
	const [loading, setLoading] = useState(false)
	const [confirmClear, setConfirmClear] = useState(false)

	const load = useCallback(async () => {
		setLoading(true)
		try {
			setSnapshot(await KnowledgeVaultServiceClient.getKnowledgeVault(EmptyRequest.create({})))
			setError(undefined)
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setLoading(false)
		}
	}, [])

	useEffect(() => {
		void load()
	}, [load])

	const session = useMemo(() => sessionMemory(clineMessages), [clineMessages])
	const notesNewestFirst = useMemo(() => [...(snapshot?.notes ?? [])].sort((a, b) => b.ts - a.ts), [snapshot])

	const openFile = async () => {
		try {
			await KnowledgeVaultServiceClient.openKnowledgeVaultFile(EmptyRequest.create({}))
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		}
	}

	const deleteNote = async (note: KnowledgeVaultNote) => {
		try {
			setSnapshot(await KnowledgeVaultServiceClient.deleteKnowledgeVaultNote(StringRequest.create({ value: note.id })))
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		}
	}

	const clearAll = async () => {
		try {
			setSnapshot(await KnowledgeVaultServiceClient.clearKnowledgeVault(EmptyRequest.create({})))
			setConfirmClear(false)
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		}
	}

	return (
		<div className="fixed inset-0 flex flex-col overflow-hidden" data-testid="knowledge-vault-view">
			<ViewHeader onDone={onDone} title="Memory" />
			<div className="flex-1 overflow-y-auto px-5 pb-5">
				<p className="mt-0 mb-4 text-xs text-description">
					Knowledge Vault is {knowledgeVaultEnabled === false ? "off" : "on"}. Notes written after each completed task
					are injected into the first turn of later tasks in this workspace.{" "}
					<button
						className="bg-transparent border-0 p-0 cursor-pointer text-link hover:underline"
						onClick={() => navigateToSettings()}
						type="button">
						Settings
					</button>
				</p>

				<div className="mb-3 flex items-center gap-2">
					<BrainIcon className="size-3.5 text-description" />
					<h4 className="m-0 text-sm font-medium">This task</h4>
				</div>
				{session.length === 0 ? (
					<p className="mt-0 mb-5 text-xs text-description">
						No memory activity in the current task yet. Recalled notes appear when a task starts; the written note
						appears when it completes.
					</p>
				) : (
					<div className="mb-5">
						{session.map(({ ts, info }) => (
							<MemoryBlock
								body={info.body}
								key={`${ts}-${info.kind}`}
								kind={info.status === "failed" ? "text" : info.kind === "recall" ? "recall" : "note"}
								meta={formatWhen(ts)}
								muted={info.status === "running"}
								title={formatKnowledgeVaultLabel(info)}
							/>
						))}
					</div>
				)}

				<div className="mb-1 flex flex-wrap items-center gap-2">
					<BrainIcon className="size-3.5 text-description" />
					<h4 className="m-0 text-sm font-medium">Workspace vault</h4>
					<span className="text-[11px] text-description">
						{snapshot
							? `${snapshot.notes.length} note${snapshot.notes.length === 1 ? "" : "s"} · ${snapshot.totalChars} chars`
							: ""}
					</span>
					<div className="flex-1" />
					<Button disabled={loading} onClick={() => void load()} size="xs" variant="secondary">
						<RefreshCwIcon /> Refresh
					</Button>
					<Button onClick={() => void openFile()} size="xs" variant="secondary">
						<ExternalLinkIcon /> Open notes file
					</Button>
					{confirmClear ? (
						<>
							<Button onClick={() => void clearAll()} size="xs" variant="danger">
								Confirm clear
							</Button>
							<Button onClick={() => setConfirmClear(false)} size="xs" variant="secondary">
								Cancel
							</Button>
						</>
					) : (
						<Button
							disabled={!snapshot || snapshot.notes.length === 0}
							onClick={() => setConfirmClear(true)}
							size="xs"
							variant="secondary">
							<Trash2Icon /> Clear all
						</Button>
					)}
				</div>
				{snapshot && (
					<p className="mt-0 mb-3 break-all text-[11px] text-description">
						{snapshot.filePath}
						{snapshot.notes.length > 0 &&
							` · next task receives ${snapshot.injectedChars} chars (most recent notes, 30K cap)`}
					</p>
				)}
				{error && <p className="mt-0 mb-3 text-xs text-error">{error}</p>}
				{snapshot && snapshot.notes.length === 0 && !error && (
					<p className="mt-0 text-xs text-description">
						The vault is empty. Complete a task that uses tools and its note will appear here.
					</p>
				)}
				{notesNewestFirst.map((note) => (
					<MemoryBlock
						actions={
							<Button aria-label="Delete note" onClick={() => void deleteNote(note)} size="icon" variant="icon">
								<Trash2Icon />
							</Button>
						}
						body={note.note}
						key={note.id}
						meta={[note.template, note.mode === "inline" ? "in-session" : note.mode, note.model]
							.filter(Boolean)
							.join(" · ")}
						title={note.label || note.task || note.id}
					/>
				))}
			</div>
		</div>
	)
}

export default KnowledgeVaultView
