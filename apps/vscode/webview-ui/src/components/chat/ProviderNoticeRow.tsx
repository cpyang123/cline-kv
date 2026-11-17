import type { ClineMessage } from "@shared/ExtensionMessage"
import { TriangleAlertIcon } from "lucide-react"

/**
 * A say:"provider_notice" row: the model API request was served differently
 * than configured (e.g. Responses API -> Chat Completions, reasoning turned
 * off for tools). The text is the SDK's user-facing explanation.
 */
export function ProviderNoticeRow({ message }: { message: ClineMessage }) {
	return (
		<div className="flex flex-col bg-warning/20 p-2 rounded-xs border border-warning/50" role="status">
			<div className="flex items-center mb-1">
				<TriangleAlertIcon className="mr-2 size-2 stroke-3 text-warning" />
				<span className="font-medium text-foreground">Warning</span>
			</div>
			<div className="text-foreground opacity-80 wrap-anywhere">{message.text}</div>
		</div>
	)
}
