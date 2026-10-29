import type { StringRequest } from "@shared/proto/cline/common"
import type { KnowledgeVaultSnapshot } from "@shared/proto/cline/knowledge_vault"
import type { Controller } from ".."
import { buildVaultSnapshot, resolveWorkspaceVaultStore } from "./vaultSnapshot"

/** Deletes one note (by id) from the current workspace's vault. */
export async function deleteKnowledgeVaultNote(controller: Controller, request: StringRequest): Promise<KnowledgeVaultSnapshot> {
	const { workspaceRoot, store } = await resolveWorkspaceVaultStore()
	const id = request.value?.trim()
	if (!id) {
		throw new Error("A note id is required.")
	}
	await store.delete(id)
	return buildVaultSnapshot(controller, workspaceRoot, store)
}
