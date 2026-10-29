import type { ClineKnowledgeVaultInfo, ClineMessage } from "@shared/ExtensionMessage"
import { BrainIcon, ChevronDownIcon, ChevronRightIcon, LoaderCircleIcon } from "lucide-react"
import { useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { NoteView } from "../knowledge-vault/NoteView"

export function parseKnowledgeVaultInfo(text: string | undefined): ClineKnowledgeVaultInfo | undefined {
	if (!text) {
		return undefined
	}
	try {
		const parsed = JSON.parse(text)
		if (parsed && typeof parsed === "object" && (parsed.kind === "recall" || parsed.kind === "write")) {
			return parsed as ClineKnowledgeVaultInfo
		}
	} catch {
		// Malformed payloads render as a spacer below.
	}
	return undefined
}

/** One-line label of a memory marker. */
export function formatKnowledgeVaultLabel(info: ClineKnowledgeVaultInfo): string {
	if (info.kind === "recall") {
		const count = info.count ?? 0
		return `Memory recalled · ${count} note${count === 1 ? "" : "s"}`
	}
	if (info.status === "running") {
		return "Writing memory note"
	}
	if (info.status === "failed") {
		return `Memory note not written${info.reason ? ` · ${info.reason}` : ""}`
	}
	const how = info.mode === "inline" ? "in-session" : info.reason ? `separate · ${info.reason}` : "separate"
	return `Memory note written · ${how}`
}

/**
 * Compact marker for Knowledge Vault activity: a small icon row that expands,
 * on click, to the notes injected into this task (recall) or the note this
 * task wrote (write). The Memory view (navbar) shows the whole vault.
 */
export const KnowledgeVaultRow = ({ message }: { message: ClineMessage }) => {
	const [expanded, setExpanded] = useState(false)
	const { navigateToKnowledgeVault } = useExtensionState()
	const info = parseKnowledgeVaultInfo(message.text)
	if (!info) {
		// Virtuoso cannot handle zero-height items; render a spacer instead of null.
		return <div aria-hidden className="h-px" />
	}

	const inProgress = info.status === "running"
	const isFailed = info.status === "failed"
	const canExpand = Boolean(info.body) && !inProgress
	const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon

	return (
		<div data-testid="knowledge-vault-row">
			<button
				aria-expanded={canExpand ? expanded : undefined}
				className={cn(
					"flex w-full items-center gap-2 py-1.5 bg-transparent border-0 p-0 text-left text-description",
					canExpand ? "cursor-pointer hover:text-foreground" : "cursor-default",
					{ "text-error": isFailed },
				)}
				onClick={() => canExpand && setExpanded((value) => !value)}
				type="button">
				{inProgress ? (
					<LoaderCircleIcon className="size-3 shrink-0 animate-spin" />
				) : (
					<BrainIcon className="size-3 shrink-0" />
				)}
				<span className="min-w-0 text-xs">
					{formatKnowledgeVaultLabel(info)}
					{inProgress ? "…" : ""}
				</span>
				<div className="flex-1 min-w-4 border-t border-description/30" />
				{canExpand && <Chevron className="size-3 shrink-0" />}
			</button>
			{expanded && canExpand && (
				<div className="mb-2 ml-5 rounded-xs border border-editor-widget-border/50 bg-editor-background/40 p-2">
					<div className="max-h-96 overflow-auto">
						{info.status === "failed" ? (
							<pre className="m-0 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-foreground/90">
								{info.body}
							</pre>
						) : (
							<NoteView recall={info.kind === "recall"} text={info.body ?? ""} />
						)}
					</div>
					<div className="mt-2 flex items-center gap-3 text-[11px] text-description">
						{info.model && (
							<span>
								writer: {info.provider ? `${info.provider}/` : ""}
								{info.model}
							</span>
						)}
						<button
							className="bg-transparent border-0 p-0 cursor-pointer text-link hover:underline"
							onClick={() => navigateToKnowledgeVault()}
							type="button">
							Open Memory view
						</button>
					</div>
				</div>
			)}
		</div>
	)
}
