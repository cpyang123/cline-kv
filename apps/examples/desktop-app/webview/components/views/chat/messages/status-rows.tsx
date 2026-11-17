"use client";

import { Brain, ChevronRight, Loader2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import {
	type KnowledgeVaultMarker,
	knowledgeVaultStatusText,
} from "@/hooks/chat-session/live-markers";
import { cn } from "@/lib/utils";

/**
 * A compact memory row: what the Knowledge Vault recalled at the start of the
 * task or wrote when it completed, expandable to the notes themselves.
 */
export function KnowledgeVaultRow({
	marker,
}: {
	marker: KnowledgeVaultMarker;
}) {
	const [expanded, setExpanded] = useState(false);
	const text = knowledgeVaultStatusText(marker);
	const failed = marker.status === "failed";
	// A failure shows its reason inline; the body only repeats it.
	const body = !failed ? marker.body?.trim() : undefined;
	const writer =
		marker.kind === "write" && marker.status === "completed" && marker.model
			? marker.model
			: undefined;
	const icon =
		marker.status === "running" ? (
			<Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin" />
		) : (
			<Brain aria-hidden className="size-3.5 shrink-0" />
		);
	const label = (
		<>
			{icon}
			<span className="min-w-0 truncate">{text}</span>
			{writer ? (
				<span className="shrink-0 text-muted-foreground/70">· {writer}</span>
			) : null}
		</>
	);
	const rowClass = cn(
		"flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground",
		failed && "text-destructive",
	);
	return (
		<div
			className="flex min-w-0 flex-col gap-1.5"
			data-memory-status={marker.status}
		>
			{body ? (
				<button
					aria-expanded={expanded}
					className={cn(rowClass, "w-fit hover:text-foreground")}
					onClick={() => setExpanded((value) => !value)}
					type="button"
				>
					{label}
					<ChevronRight
						aria-hidden
						className={cn(
							"size-3 shrink-0 transition-transform",
							expanded && "rotate-90",
						)}
					/>
				</button>
			) : (
				<div className={rowClass}>{label}</div>
			)}
			{body && expanded ? (
				<pre className="max-h-72 overflow-auto rounded-md border border-border bg-muted/40 p-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground">
					{body}
				</pre>
			) : null}
		</div>
	);
}

/** A provider fallback the user should know about (warning styling). */
export function ProviderNoticeRow({ content }: { content: string }) {
	return (
		<output className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
			<TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
			<span className="min-w-0 wrap-break-word">{content}</span>
		</output>
	);
}
