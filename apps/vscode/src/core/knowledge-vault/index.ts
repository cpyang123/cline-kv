/**
 * The Knowledge Vault lives in `@cline/core` (hooks, store, writer); this
 * module adapts it to the extension: settings from the StateManager, chat
 * messages for its events, and the writer handler built from the extension's
 * API configuration.
 */
export {
	buildKnowledgeVaultHooks,
	composeAgentHooks,
	type KnowledgeVaultEvent,
	type KnowledgeVaultHooks,
	type KnowledgeVaultHooksOptions,
	type KnowledgeVaultNote,
	type KnowledgeVaultNoteWriterHandler as NoteWriterHandler,
	KnowledgeVaultStore,
	knowledgeVaultNoteLabel as noteLabel,
	renderKnowledgeVaultBody as renderVaultBody,
	resolveKnowledgeVaultPath,
} from "@cline/core"
export { buildKnowledgeVaultMessage, knowledgeVaultEventToMessage, knowledgeVaultLogger } from "./adapter"
export { buildKnowledgeVaultWriterHandler, resolveGoodVisionWriterModelId, writerHandlerOptions } from "./writer-handler"
