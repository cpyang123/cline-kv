import type { AgentEvent } from "@cline/core";
import {
	isProviderWarningNotice,
	resolveNonCompactionStatusLabel,
} from "../../utils/events";
import {
	formatKnowledgeVaultEvent,
	parseKnowledgeVaultNoticeMetadata,
} from "../../utils/knowledge-vault";
import type { ChatEntry } from "../types";

export type StatusChatEntry = Extract<ChatEntry, { kind: "status" }>;

/**
 * The transcript entry for a non-compaction status notice: Knowledge Vault
 * reports carry their event ts so a write's final report replaces its
 * "saving" entry, and provider notices (protocol fallbacks) are warnings.
 */
export function resolveStatusNoticeEntry(
	event: AgentEvent,
): StatusChatEntry | undefined {
	if (event.type !== "notice" || event.displayRole !== "status") {
		return undefined;
	}
	const vaultEvent = parseKnowledgeVaultNoticeMetadata(event.metadata);
	if (vaultEvent) {
		const text = formatKnowledgeVaultEvent(vaultEvent);
		if (!text) return undefined;
		return {
			kind: "status",
			text: `Memory: ${text}`,
			tone: vaultEvent.status === "failed" ? "warning" : "memory",
			...(vaultEvent.kind === "write" ? { memoryTs: vaultEvent.ts } : {}),
		};
	}
	const label = resolveNonCompactionStatusLabel(event);
	if (!label) return undefined;
	return isProviderWarningNotice(event)
		? { kind: "status", text: label, tone: "warning" }
		: { kind: "status", text: label };
}

export function formatServedModelStatusText(modelId: string): string {
	return `Answered by ${modelId}`;
}
