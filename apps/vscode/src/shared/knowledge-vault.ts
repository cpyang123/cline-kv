/**
 * Knowledge Vault: cross-session repository memory.
 *
 * After a task completes, a "writer" model distills the session transcript into
 * one short structured note (the team's fusednote / Knowledge Vault method). The
 * notes a repository has accumulated are injected into the first turn of later
 * tasks in that repository, so the agent inherits what earlier sessions
 * established (files, verify commands, repository facts, dead ends) instead of
 * rediscovering it.
 *
 * Types and constants here are shared by the extension host (hooks, settings)
 * and the webview (settings UI).
 */

export const KNOWLEDGE_VAULT_TEMPLATES = ["fused", "two-block"] as const
export type KnowledgeVaultTemplate = (typeof KNOWLEDGE_VAULT_TEMPLATES)[number]

export const KNOWLEDGE_VAULT_WRITERS = ["task", "goodvision"] as const
export type KnowledgeVaultWriter = (typeof KNOWLEDGE_VAULT_WRITERS)[number]

export const KNOWLEDGE_VAULT_WRITE_MODES = ["inline", "separate"] as const
export type KnowledgeVaultWriteMode = (typeof KNOWLEDGE_VAULT_WRITE_MODES)[number]

export const DEFAULT_KNOWLEDGE_VAULT_ENABLED = true
/**
 * Defaults reproduce the `v5knote` arm of knowledge-vault-project@chainswe-v5-note-arm
 * (docs/V5_NOTE_ARM.md): the v5 two-block template, written by a separate writer call.
 * The later `v5inline` write mode is available but not the default.
 */
export const DEFAULT_KNOWLEDGE_VAULT_TEMPLATE: KnowledgeVaultTemplate = "two-block"
export const DEFAULT_KNOWLEDGE_VAULT_WRITER: KnowledgeVaultWriter = "task"
export const DEFAULT_KNOWLEDGE_VAULT_WRITE_MODE: KnowledgeVaultWriteMode = "separate"

export function isKnowledgeVaultTemplate(value: unknown): value is KnowledgeVaultTemplate {
	return typeof value === "string" && (KNOWLEDGE_VAULT_TEMPLATES as readonly string[]).includes(value)
}

export function isKnowledgeVaultWriter(value: unknown): value is KnowledgeVaultWriter {
	return typeof value === "string" && (KNOWLEDGE_VAULT_WRITERS as readonly string[]).includes(value)
}

export function isKnowledgeVaultWriteMode(value: unknown): value is KnowledgeVaultWriteMode {
	return typeof value === "string" && (KNOWLEDGE_VAULT_WRITE_MODES as readonly string[]).includes(value)
}

/** The vault lives inside the workspace: `<root>/.cline/knowledge-vault/notes.jsonl`. */
export const KNOWLEDGE_VAULT_DIR_SEGMENTS = [".cline", "knowledge-vault"] as const
export const KNOWLEDGE_VAULT_NOTES_FILENAME = "notes.jsonl"
export const KNOWLEDGE_VAULT_RELATIVE_PATH = `${KNOWLEDGE_VAULT_DIR_SEGMENTS.join("/")}/${KNOWLEDGE_VAULT_NOTES_FILENAME}`

export const KNOWLEDGE_VAULT_TEMPLATE_LABELS: Record<KnowledgeVaultTemplate, { label: string; description: string }> = {
	"two-block": {
		label: "Two-block note (v5, current)",
		description:
			"A TASK block scoped to the files this session touched (FILES / STATUS / VERIFY / DID), then repository-wide CONTEXT facts. The template of the v5 note arm.",
	},
	fused: {
		label: "Fused notes (v3, the paper's arm)",
		description:
			"One line per note (DID / CONTEXT / LESSON); each DID carries its verify command inline. Always written by a separate writer call.",
	},
}

export const KNOWLEDGE_VAULT_WRITER_LABELS: Record<KnowledgeVaultWriter, { label: string; description: string }> = {
	task: {
		label: "Task model",
		description: "The model the task ran on writes the note (the actor doubles as the writer).",
	},
	goodvision: {
		label: "GoodVision SmartRouter",
		description:
			"A separate writer call through the GoodVision SmartRouter configured under API Configuration, whatever the task ran on (its routing policy picks the model when the id is auto).",
	},
}

export const KNOWLEDGE_VAULT_WRITE_MODE_LABELS: Record<KnowledgeVaultWriteMode, { label: string; description: string }> = {
	separate: {
		label: "Separate writer call (v5knote, current)",
		description:
			"A fresh request distills the session transcript into the note: the template as the system message, the transcript as the user message, temperature 0, at most 900 output tokens. The arm of the reported v5 runs.",
	},
	inline: {
		label: "In-session (v5inline, experimental)",
		description:
			"The actor writes the note as one more turn of its own session, so the request reuses the session's cached prefix. Falls back to the separate writer call when the output does not validate or the context window has no room. Applies to the task-model writer with the two-block template.",
	},
}
