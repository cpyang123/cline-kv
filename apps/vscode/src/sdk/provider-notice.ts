import type { ModelNoticeKind } from "@cline/shared"
import { ShowMessageType } from "@shared/proto/host/window"
import { Logger } from "@shared/services/Logger"
import { HostProvider } from "@/hosts/host-provider"

/**
 * Status-notice kinds the SDK raises when it had to change how a request was
 * served (protocol fallback, reasoning turned off or dropped). They are
 * warnings the user should see, unlike other status notices.
 */
const PROVIDER_NOTICE_KINDS: ReadonlySet<string> = new Set<ModelNoticeKind>([
	"responses_unavailable",
	"reasoning_disabled_for_tools",
	"reasoning_replay_dropped",
])

export interface ProviderNoticeInfo {
	kind: ModelNoticeKind
	message: string
	modelId?: string
}

/** Recognize a provider warning by its status-notice metadata. */
export function parseProviderNotice(
	message: string | undefined,
	metadata: Record<string, unknown> | undefined,
): ProviderNoticeInfo | undefined {
	const kind = metadata?.kind
	if (typeof kind !== "string" || !PROVIDER_NOTICE_KINDS.has(kind) || !message) {
		return undefined
	}
	const modelId = typeof metadata?.modelId === "string" ? metadata.modelId : undefined
	return { kind: kind as ModelNoticeKind, message, ...(modelId ? { modelId } : {}) }
}

// The SDK runtime repeats a notice once per session; the toast is louder, so
// it fires once per VS Code process for each kind and model.
const toastedNotices = new Set<string>()

export function showProviderNoticeToastOnce(notice: ProviderNoticeInfo): void {
	const key = `${notice.kind}|${notice.modelId ?? ""}`
	if (toastedNotices.has(key)) {
		return
	}
	toastedNotices.add(key)
	try {
		void HostProvider.window.showMessage({ type: ShowMessageType.WARNING, message: notice.message }).catch((error) => {
			Logger.warn("[ProviderNotice] Failed to show warning toast:", error)
		})
	} catch (error) {
		// The chat row still carries the warning when no host is available.
		Logger.warn("[ProviderNotice] Failed to show warning toast:", error)
	}
}

/** Test-only: forget which notices were already shown as toasts. */
export function resetProviderNoticeToastsForTests(): void {
	toastedNotices.clear()
}
