export { composeAgentHooks } from "./compose"
export {
	buildKnowledgeVaultHooks,
	buildKnowledgeVaultStatusMessage,
	KNOWLEDGE_VAULT_HOOK_NAME,
	type KnowledgeVaultHooks,
	type KnowledgeVaultHooksOptions,
} from "./hooks"
export { closeDanglingToolCalls, headroomOk, lastActorPromptTokens, runInlineNoteTurn } from "./inline"
export { buildSessionMaterial, collectChangedFiles, firstUserPrompt, stripInjectedContext } from "./material"
export { cutNote, isValidNote, NOTE_TEMPLATES, type NoteTemplateSpec, normalizeWriterOutput, parseInlineNote } from "./note"
export {
	type KnowledgeVaultNote,
	KnowledgeVaultStore,
	MEM_WRAP_HEAD,
	renderVaultBody,
	resolveKnowledgeVaultPath,
	STORE_FIFO_CHARS,
	wrapMemoryContext,
} from "./store"
export { DEFAULT_DISTILL_CAP, distillNote, type NoteWriterHandler, truncateMiddle } from "./writer"
export { buildKnowledgeVaultWriterHandler, resolveGoodVisionWriterModelId } from "./writer-handler"
