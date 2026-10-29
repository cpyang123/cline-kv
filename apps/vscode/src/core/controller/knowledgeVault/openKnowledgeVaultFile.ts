import { Empty, type EmptyRequest, StringRequest } from "@shared/proto/cline/common"
import type { Controller } from ".."
import { openFile } from "../file/openFile"
import { resolveWorkspaceVaultStore } from "./vaultSnapshot"

/** Opens the workspace's notes file (the whole memory document) in the editor, creating it when absent. */
export async function openKnowledgeVaultFile(controller: Controller, _request: EmptyRequest): Promise<Empty> {
	const { store } = await resolveWorkspaceVaultStore()
	await store.ensureFile()
	await openFile(controller, StringRequest.create({ value: store.filePath }))
	return Empty.create({})
}
