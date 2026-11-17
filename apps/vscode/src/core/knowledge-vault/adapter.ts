import type { BasicLogger, KnowledgeVaultEvent } from "@cline/core"
import type { ClineKnowledgeVaultInfo, ClineMessage } from "@shared/ExtensionMessage"
import { Logger } from "@shared/services/Logger"

/**
 * A `knowledge_vault` chat message: a compact marker the chat renders as a
 * small icon row, expandable to the injected notes or the written note. The
 * same `ts` is reused to turn a running marker into its final state in place.
 */
export function buildKnowledgeVaultMessage(info: ClineKnowledgeVaultInfo, ts: number): ClineMessage {
	return {
		ts,
		type: "say",
		say: "knowledge_vault",
		text: JSON.stringify(info),
		partial: false,
	}
}

/** Map a core Knowledge Vault event onto the chat message the webview renders. */
export function knowledgeVaultEventToMessage(event: KnowledgeVaultEvent): ClineMessage {
	const { ts, ...info } = event
	return buildKnowledgeVaultMessage(info, ts)
}

/** The extension's Logger as the core module's `BasicLogger`. */
export const knowledgeVaultLogger: BasicLogger = {
	debug: (message) => Logger.debug(message),
	log: (message, metadata) => {
		if (metadata?.severity === "error") {
			Logger.error(message)
		} else if (metadata?.severity === "warn") {
			Logger.warn(message)
		} else {
			Logger.info(message)
		}
	},
	error: (message, metadata) => (metadata?.error === undefined ? Logger.error(message) : Logger.error(message, metadata.error)),
}
