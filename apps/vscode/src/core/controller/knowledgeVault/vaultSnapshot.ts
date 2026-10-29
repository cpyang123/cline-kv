import type { KnowledgeVaultNote as ProtoNote } from "@shared/proto/cline/knowledge_vault"
import { KnowledgeVaultSnapshot } from "@shared/proto/cline/knowledge_vault"
import { type KnowledgeVaultNote, KnowledgeVaultStore, noteLabel, renderVaultBody } from "@/core/knowledge-vault"
import { HostProvider } from "@/hosts/host-provider"
import type { Controller } from ".."

/**
 * The vault the Memory view operates on: the primary workspace folder's. The
 * session hooks use the session's own workspace root, which is the same folder
 * for a single-root window.
 */
export async function resolveWorkspaceVaultStore(): Promise<{ workspaceRoot: string; store: KnowledgeVaultStore }> {
	const paths = HostProvider.isInitialized() ? (await HostProvider.workspace.getWorkspacePaths({})).paths : []
	const workspaceRoot = paths[0]?.trim()
	if (!workspaceRoot) {
		throw new Error("Open a folder to use the Knowledge Vault: notes are stored per workspace.")
	}
	return { workspaceRoot, store: KnowledgeVaultStore.forWorkspace(workspaceRoot) }
}

export function toProtoNote(note: KnowledgeVaultNote): ProtoNote {
	return {
		id: note.id,
		ts: note.ts,
		taskId: note.taskId,
		task: note.task,
		note: note.note,
		template: note.template,
		provider: note.provider,
		model: note.model,
		mode: note.mode,
		reason: note.reason,
		label: noteLabel(note),
	}
}

export async function buildVaultSnapshot(
	controller: Controller,
	workspaceRoot: string,
	store: KnowledgeVaultStore,
): Promise<KnowledgeVaultSnapshot> {
	const notes = await store.list()
	return KnowledgeVaultSnapshot.create({
		workspaceRoot,
		filePath: store.filePath,
		exists: await store.exists(),
		notes: notes.map(toProtoNote),
		totalChars: notes.reduce((sum, note) => sum + note.note.length, 0),
		injectedChars: notes.length > 0 ? renderVaultBody(notes).length : 0,
		enabled: controller.stateManager.getGlobalSettingsKey("knowledgeVaultEnabled") ?? true,
	})
}
