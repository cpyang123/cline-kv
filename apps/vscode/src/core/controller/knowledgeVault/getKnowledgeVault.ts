import type { EmptyRequest } from "@shared/proto/cline/common"
import type { KnowledgeVaultSnapshot } from "@shared/proto/cline/knowledge_vault"
import type { Controller } from ".."
import { buildVaultSnapshot, resolveWorkspaceVaultStore } from "./vaultSnapshot"

/** Reads the current workspace's Knowledge Vault for the Memory view. */
export async function getKnowledgeVault(controller: Controller, _request: EmptyRequest): Promise<KnowledgeVaultSnapshot> {
	const { workspaceRoot, store } = await resolveWorkspaceVaultStore()
	return buildVaultSnapshot(controller, workspaceRoot, store)
}
