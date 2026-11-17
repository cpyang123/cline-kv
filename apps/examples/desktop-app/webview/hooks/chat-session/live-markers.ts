/**
 * Live-only transcript rows and annotations: Knowledge Vault markers,
 * provider notices, and the model a provider reports having served an answer
 * with. None of them are part of the persisted transcript, so they are
 * carried across canonical-history reconciles here.
 */
import type { ChatMessage } from "@/lib/chat-schema";
import { makeId } from "./helpers";

/** chat_event stream the sidecar reports Knowledge Vault events on. */
export const KNOWLEDGE_VAULT_STREAM = "chat_knowledge_vault";
export const KNOWLEDGE_VAULT_MESSAGE_KIND = "knowledge_vault";
export const PROVIDER_NOTICE_MESSAGE_KIND = "provider_notice";

/** Live status rows kept when canonical history replaces the transcript. */
const LIVE_ONLY_MESSAGE_KINDS = new Set([
	KNOWLEDGE_VAULT_MESSAGE_KIND,
	PROVIDER_NOTICE_MESSAGE_KIND,
]);

export type KnowledgeVaultMarker = NonNullable<
	NonNullable<ChatMessage["meta"]>["knowledgeVault"]
>;

/** Parses a `chat_knowledge_vault` chunk (core's KnowledgeVaultEvent). */
export function parseKnowledgeVaultEvent(
	chunk: string,
): KnowledgeVaultMarker | undefined {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(chunk) as Record<string, unknown>;
	} catch {
		return undefined;
	}
	const { ts, kind, status } = parsed;
	if (
		typeof ts !== "number" ||
		(kind !== "recall" && kind !== "write") ||
		(status !== "running" && status !== "completed" && status !== "failed")
	) {
		return undefined;
	}
	return {
		ts,
		kind,
		status,
		...(typeof parsed.count === "number" ? { count: parsed.count } : {}),
		...(parsed.mode === "inline" || parsed.mode === "separate"
			? { mode: parsed.mode }
			: {}),
		...(typeof parsed.body === "string" ? { body: parsed.body } : {}),
		...(typeof parsed.provider === "string"
			? { provider: parsed.provider }
			: {}),
		...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
	};
}

/** The one-line text of a memory row. */
export function knowledgeVaultStatusText(marker: KnowledgeVaultMarker): string {
	if (marker.kind === "recall") {
		const count = marker.count ?? 0;
		return `Recalled ${count} ${count === 1 ? "note" : "notes"} from memory`;
	}
	if (marker.status === "running") return "Saving note to memory…";
	if (marker.status === "completed") return "Note saved to memory";
	const detail = marker.body?.trim().split("\n")[0];
	return detail ? `Note failed: ${detail}` : "Note failed";
}

/**
 * Adds a memory row, or updates the row of the same marker in place: a write
 * reports `running` and then `completed`/`failed` with the same `ts`.
 */
export function applyKnowledgeVaultMarker(
	messages: ChatMessage[],
	sessionId: string,
	marker: KnowledgeVaultMarker,
	createdAt: number,
): ChatMessage[] {
	const index = messages.findIndex(
		(message) =>
			message.sessionId === sessionId &&
			message.meta?.messageKind === KNOWLEDGE_VAULT_MESSAGE_KIND &&
			message.meta.knowledgeVault?.ts === marker.ts &&
			message.meta.knowledgeVault.kind === marker.kind,
	);
	if (index >= 0) {
		const existing = messages[index];
		const next = [...messages];
		next[index] = {
			...existing,
			content: knowledgeVaultStatusText(marker),
			meta: { ...existing.meta, knowledgeVault: marker },
		};
		return next;
	}
	return [
		...messages,
		{
			id: makeId("memory"),
			sessionId,
			role: "status",
			content: knowledgeVaultStatusText(marker),
			createdAt,
			meta: {
				messageKind: KNOWLEDGE_VAULT_MESSAGE_KIND,
				knowledgeVault: marker,
			},
		},
	];
}

const PROVIDER_NOTICE_KINDS = new Set([
	"responses_unavailable",
	"reasoning_disabled_for_tools",
	"reasoning_replay_dropped",
]);

export type ProviderNotice = {
	kind: string;
	message: string;
	modelId?: string;
};

/** The provider notice a `chat_core_log` chunk carries, if any. */
export function readProviderNotice(chunk: string): ProviderNotice | undefined {
	try {
		const parsed = JSON.parse(chunk) as {
			message?: unknown;
			metadata?: { kind?: unknown; modelId?: unknown };
		};
		const kind = parsed.metadata?.kind;
		const message =
			typeof parsed.message === "string" ? parsed.message.trim() : "";
		if (typeof kind !== "string" || !PROVIDER_NOTICE_KINDS.has(kind)) {
			return undefined;
		}
		if (!message) return undefined;
		const modelId = parsed.metadata?.modelId;
		return {
			kind,
			message,
			...(typeof modelId === "string" && modelId ? { modelId } : {}),
		};
	} catch {
		return undefined;
	}
}

/** Notices repeat on every request; a session shows each kind+model once. */
export function providerNoticeKey(notice: ProviderNotice): string {
	return `${notice.kind}\u0000${notice.modelId ?? ""}`;
}

export function makeProviderNoticeMessage(
	sessionId: string,
	notice: ProviderNotice,
	createdAt: number,
): ChatMessage {
	return {
		id: makeId("notice"),
		sessionId,
		role: "status",
		content: notice.message,
		createdAt,
		meta: {
			messageKind: PROVIDER_NOTICE_MESSAGE_KIND,
			noticeKind: notice.kind,
			...(notice.modelId ? { modelId: notice.modelId } : {}),
		},
	};
}

/**
 * Records the served model on the assistant message the usage belongs to:
 * the streaming message when there is one, else the latest assistant message
 * of the current turn (a tool-only step has no message of its own).
 */
export function applyResponseModelId(
	messages: ChatMessage[],
	options: {
		sessionId: string;
		assistantMessageId: string | null;
		responseModelId: string;
		selectedModelId?: string;
	},
): ChatMessage[] {
	let index = options.assistantMessageId
		? messages.findIndex((message) => message.id === options.assistantMessageId)
		: -1;
	if (index < 0) {
		for (let cursor = messages.length - 1; cursor >= 0; cursor--) {
			const message = messages[cursor];
			if (message.sessionId !== options.sessionId) continue;
			if (message.role === "user") break;
			if (message.role === "assistant") {
				index = cursor;
				break;
			}
		}
	}
	const target = index >= 0 ? messages[index] : undefined;
	if (!target || target.meta?.responseModelId === options.responseModelId) {
		return messages;
	}
	const next = [...messages];
	next[index] = {
		...target,
		meta: {
			...target.meta,
			responseModelId: options.responseModelId,
			...(target.meta?.modelId || !options.selectedModelId
				? {}
				: { modelId: options.selectedModelId }),
		},
	};
	return next;
}

function lastSegment(modelId: string): string {
	return modelId.trim().toLowerCase().split("/").at(-1) ?? "";
}

/**
 * Whether the served model is worth naming: not the requested model, its
 * provider-prefixed form, or a dated snapshot of it.
 */
export function isServedByDifferentModel(
	responseModelId: string | undefined,
	requestedModelId: string | undefined,
): boolean {
	const served = responseModelId ? lastSegment(responseModelId) : "";
	if (!served) return false;
	const requested = requestedModelId ? lastSegment(requestedModelId) : "";
	if (!requested) return true;
	return !(served === requested || served.startsWith(`${requested}-`));
}

/**
 * Canonical history replaces the live transcript at turn end. Keep the live
 * memory and notice rows (they are not persisted) and the served-model
 * annotations of answers the history also contains.
 */
export function carryLiveDetailsIntoHistory(
	history: ChatMessage[],
	live: ChatMessage[],
): ChatMessage[] {
	const servedModels = live.filter(
		(message) => message.role === "assistant" && message.meta?.responseModelId,
	);
	const liveOnlyRows = live.filter(
		(message) =>
			message.role === "status" &&
			LIVE_ONLY_MESSAGE_KINDS.has(message.meta?.messageKind ?? "") &&
			!history.some((candidate) => candidate.id === message.id),
	);
	if (servedModels.length === 0 && liveOnlyRows.length === 0) {
		return history;
	}
	const annotated = history.map((message) => {
		if (message.role !== "assistant" || message.meta?.responseModelId) {
			return message;
		}
		const source = servedModels.find(
			(candidate) =>
				candidate.content.trim() &&
				(candidate.content === message.content ||
					message.content.includes(candidate.content)),
		);
		if (!source) return message;
		servedModels.splice(servedModels.indexOf(source), 1);
		return {
			...message,
			meta: {
				...message.meta,
				responseModelId: source.meta?.responseModelId,
				...(message.meta?.modelId || !source.meta?.modelId
					? {}
					: { modelId: source.meta.modelId }),
			},
		};
	});
	if (liveOnlyRows.length === 0) return annotated;
	return [...annotated, ...liveOnlyRows].sort((left, right) =>
		left.createdAt !== right.createdAt ? left.createdAt - right.createdAt : 0,
	);
}
