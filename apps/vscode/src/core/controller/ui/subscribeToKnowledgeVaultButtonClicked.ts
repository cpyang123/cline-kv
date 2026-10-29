import { Empty, EmptyRequest } from "@shared/proto/cline/common"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import { Controller } from "../index"

// Active subscriptions to the Memory (Knowledge Vault) title-bar button
const activeKnowledgeVaultButtonClickedSubscriptions = new Set<StreamingResponseHandler<Empty>>()

/**
 * Subscribe to knowledge vault button clicked events
 * @param controller The controller instance
 * @param request The empty request
 * @param responseStream The streaming response handler
 * @param requestId The ID of the request (passed by the gRPC handler)
 */
export async function subscribeToKnowledgeVaultButtonClicked(
	_controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<Empty>,
	requestId?: string,
): Promise<void> {
	activeKnowledgeVaultButtonClickedSubscriptions.add(responseStream)

	const cleanup = () => {
		activeKnowledgeVaultButtonClickedSubscriptions.delete(responseStream)
	}

	if (requestId) {
		getRequestRegistry().registerRequest(
			requestId,
			cleanup,
			{ type: "knowledge_vault_button_clicked_subscription" },
			responseStream,
		)
	}
}

/**
 * Send a knowledge vault button clicked event to all active subscribers
 */
export async function sendKnowledgeVaultButtonClickedEvent(): Promise<void> {
	const promises = Array.from(activeKnowledgeVaultButtonClickedSubscriptions).map(async (responseStream) => {
		try {
			await responseStream(Empty.create({}), false)
		} catch (error) {
			Logger.error("Error sending knowledge vault button clicked event:", error)
			activeKnowledgeVaultButtonClickedSubscriptions.delete(responseStream)
		}
	})

	await Promise.all(promises)
}
