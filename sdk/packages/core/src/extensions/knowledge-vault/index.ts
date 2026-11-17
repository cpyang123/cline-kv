export { composeAgentHooks } from "./compose";
export * from "./constants";
export {
	buildKnowledgeVaultHooks,
	isSubagentRun,
	type KnowledgeVaultHooks,
	type KnowledgeVaultHooksOptions,
} from "./hooks";
export {
	closeDanglingToolCalls,
	headroomOk,
	lastActorPromptTokens,
	runInlineNoteTurn,
} from "./inline";
export {
	buildSessionMaterial,
	collectChangedFiles,
	firstUserPrompt,
	stripInjectedContext,
} from "./material";
export {
	cutNote,
	isValidNote,
	NOTE_TEMPLATES,
	type NoteTemplateSpec,
	normalizeWriterOutput,
	parseInlineNote,
} from "./note";
export {
	FUSED_WRITER_PROMPT,
	INLINE_NOTE_INSTRUCTION,
	TWO_BLOCK_WRITER_PROMPT,
} from "./prompts";
export {
	type KnowledgeVaultNote,
	KnowledgeVaultStore,
	MEM_WRAP_HEAD,
	noteLabel,
	renderVaultBody,
	resolveKnowledgeVaultPath,
	STORE_FIFO_CHARS,
	wrapMemoryContext,
} from "./store";
export {
	DEFAULT_DISTILL_CAP,
	distillNote,
	type NoteWriterHandler,
	truncateMiddle,
	type WriterStreamChunk,
} from "./writer";
export {
	type CreateKnowledgeVaultWriterHandlerOptions,
	createKnowledgeVaultWriterHandler,
	type KnowledgeVaultProviderSettingsSource,
	type KnowledgeVaultWriterSessionConnection,
	resolveKnowledgeVaultWriterProviderConfig,
} from "./writer-handler";
export {
	GOODVISION_DEFAULT_WRITER_MODEL,
	GOODVISION_PROVIDER_ID,
	KNOWLEDGE_VAULT_WRITER_MAX_OUTPUT_TOKENS,
	KNOWLEDGE_VAULT_WRITER_TEMPERATURE,
	type KnowledgeVaultWriterRequestOptions,
	knowledgeVaultWriterRequestOptions,
	modelRejectsTemperature,
	resolveGoodVisionWriterModelId,
} from "./writer-options";
