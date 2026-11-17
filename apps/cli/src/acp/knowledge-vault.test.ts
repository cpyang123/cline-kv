import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../utils/types";

const managerMock = vi.hoisted(() => ({
	start: vi.fn(async () => ({ sessionId: "acp-1" })),
	dispose: vi.fn(async () => {}),
	abort: vi.fn(async () => {}),
}));

vi.mock("../runtime/prompt", () => ({
	resolveSystemPrompt: vi.fn().mockResolvedValue("system prompt"),
}));

vi.mock("../session/session", () => ({
	createCliCore: vi.fn(async () => managerMock),
}));

vi.mock("../runtime/session-events", () => ({
	subscribeToAgentEvents: vi.fn(() => () => {}),
}));

const { AcpAgent } = await import("./acpAgent");

type AgentInternals = {
	sessions: Map<string, unknown>;
	ensureSessionManager(session: unknown, acpSessionId: string): Promise<void>;
	knowledgeVaultWrites: {
		track: () => void;
		pending: () => number;
		waitAll: (timeoutMs?: number) => Promise<boolean>;
	};
};

function makeSession() {
	return {
		id: "acp-1",
		cwd: process.cwd(),
		mcpServers: [],
		currentMode: "act",
		currentProviderId: "anthropic",
		currentModelId: "claude-sonnet",
		autoApproveTools: false,
	};
}

describe("ACP Knowledge Vault", () => {
	it("composes the Knowledge Vault hooks into the ACP session", async () => {
		const agent = new AcpAgent(
			{} as AgentSideConnection,
		) as unknown as AgentInternals;
		await agent.ensureSessionManager(makeSession(), "acp-1");

		const startInput = (
			managerMock.start.mock.calls as unknown as Array<
				[{ config: Config & { sessionId?: string } }]
			>
		)[0]?.[0];
		expect(startInput?.config.sessionId).toBe("acp-1");
		expect(startInput?.config.modelId).toBe("claude-sonnet");
		expect(startInput?.config.hooks?.beforeRun).toBeTypeOf("function");
		expect(startInput?.config.hooks?.afterRun).toBeTypeOf("function");
	});

	it("waits for pending note writes on shutdown", async () => {
		const agent = new AcpAgent(
			{} as AgentSideConnection,
		) as unknown as AgentInternals;
		const waitAll = vi.fn(async () => true);
		agent.knowledgeVaultWrites = {
			track: vi.fn(),
			pending: () => 1,
			waitAll,
		};
		await (agent as unknown as { shutdown(): Promise<void> }).shutdown();
		expect(waitAll).toHaveBeenCalledWith(60_000);
	});
});
