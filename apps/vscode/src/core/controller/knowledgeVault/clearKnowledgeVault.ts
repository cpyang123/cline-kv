import type { EmptyRequest } from "@shared/proto/cline/common"
import type { KnowledgeVaultSnapshot } from "@shared/proto/cline/knowledge_vault"
import type { Controller } from ".."
import { buildVaultSnapshot, resolveWorkspaceVaultStore } from "./vaultSnapshot"

/** Removes every note from the current workspace's vault. */
export async function clearKnowledgeVault(controller: Controller, _request: EmptyRequest): Promise<KnowledgeVaultSnapshot> {
	const { workspaceRoot, store } = await resolveWorkspaceVaultStore()
	await store.clear()
	return buildVaultSnapshot(controller, workspaceRoot, store)
}
