import { describe, expect, it } from "vitest";
import type { ChatSessionConfig } from "@/lib/chat-schema";
import {
	extractAssistantTurnDataFromRpcMessages,
	inferHydratedChatStatus,
	resolveCredentialError,
	resolveCredentialFailureAction,
	resolveCredentialFailureHint,
} from "./helpers";
import {
	applyKnowledgeVaultMarker,
	carryLiveDetailsIntoHistory,
	isServedByDifferentModel,
	KNOWLEDGE_VAULT_MESSAGE_KIND,
	readProviderNotice,
} from "./live-markers";

const CLOUD_CONFIG: ChatSessionConfig = {
	executionTarget: "cloud",
	provider: "cline",
	model: "anthropic/claude-sonnet-5",
	apiKey: "",
	workspaceRoot: "",
	cwd: "",
	repoUrl: "https://github.com/cline/cline",
} as ChatSessionConfig;

describe("resolveCredentialError (cloud)", () => {
	it("accepts a valid HTTPS GitHub URL for a new session", () => {
		expect(resolveCredentialError(CLOUD_CONFIG)).toBeNull();
	});

	it("rejects invalid GitHub repository URLs", () => {
		for (const repoUrl of [
			"https://exa",
			"git@github.com:cline/cline.git",
			"https://gitlab.com/cline/cline",
			"http://github.com/cline/cline",
		]) {
			expect(resolveCredentialError({ ...CLOUD_CONFIG, repoUrl })).toMatch(
				/valid HTTPS GitHub repository URL/,
			);
		}
	});

	it("does not require a repo URL when sending into an existing session", () => {
		expect(
			resolveCredentialError(
				{ ...CLOUD_CONFIG, repoUrl: "" },
				{ hasActiveSession: true },
			),
		).toBeNull();
	});

	it("still requires the Cline provider for existing sessions", () => {
		expect(
			resolveCredentialError(
				{ ...CLOUD_CONFIG, provider: "anthropic" },
				{ hasActiveSession: true },
			),
		).toMatch(/Cline provider/);
	});
});

function makeConfig(overrides: Partial<ChatSessionConfig>): ChatSessionConfig {
	return {
		workspaceRoot: "/tmp/project",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		mode: "act",
		apiKey: "",
		enableTools: true,
		providerAuth: { providerId: "anthropic", capabilities: [] },
		...overrides,
	};
}

describe("resolveCredentialError", () => {
	it("requires a provider", () => {
		expect(resolveCredentialError(makeConfig({ provider: "  " }))).toMatch(
			/Provider is required/,
		);
	});

	it("defers authentication to the host when facts belong to a different provider", () => {
		expect(
			resolveCredentialError(
				makeConfig({
					provider: "anthropic",
					providerAuth: {
						providerId: "custom-cli",
						capabilities: ["local-auth"],
					},
				}),
			),
		).toBeNull();
	});

	it.each([
		"claude-code",
		"custom-oauth",
		"custom-local",
		"anthropic",
	])("defers authentication to the host when %s has no catalog facts", (provider) => {
		expect(
			resolveCredentialError(makeConfig({ provider, providerAuth: undefined })),
		).toBeNull();
	});

	it("blocks API-key providers without a key", () => {
		expect(
			resolveCredentialError(makeConfig({ provider: "anthropic" })),
		).toMatch(/Missing API key/);
	});

	it("allows a provider whose metadata declares the API key optional", () => {
		// Local OpenAI-compatible endpoints (LM Studio, vLLM, ...) and Ollama
		// have no key; the catalog carries the declaration from `@cline/llms`.
		expect(
			resolveCredentialError(
				makeConfig({
					provider: "openai-compatible",
					providerAuth: {
						providerId: "openai-compatible",
						capabilities: ["tools"],
						apiKeyOptional: true,
					},
				}),
			),
		).toBeNull();
	});

	it("allows API-key providers with a key", () => {
		expect(
			resolveCredentialError(
				makeConfig({ provider: "anthropic", apiKey: "sk-123" }),
			),
		).toBeNull();
	});

	it.each([
		"cline",
		"cline-pass",
		"oca",
		"openai-codex",
	])("allows OAuth-managed provider %s without a visible API key", (provider) => {
		// OAuth credentials live in the backend provider settings store
		// (ClinePass shares the Cline account login), never in the webview
		// config, so the pre-flight gate must not demand an API key.
		expect(resolveCredentialError(makeConfig({ provider }))).toBeNull();
	});

	it.each([
		"claude-code",
		"openai-codex-cli",
	])("allows local-auth provider %s without an API key", (provider) => {
		// Local CLI providers authenticate from the CLI's own credential
		// store; the catalog marks them `local-auth` and the key is inert.
		expect(
			resolveCredentialError(
				makeConfig({
					provider,
					providerAuth: { providerId: provider, capabilities: ["local-auth"] },
				}),
			),
		).toBeNull();
	});

	it("allows a catalog-declared OAuth provider outside the fallback id set", () => {
		expect(
			resolveCredentialError(
				makeConfig({
					provider: "custom-oauth",
					providerAuth: { providerId: "custom-oauth", capabilities: ["oauth"] },
				}),
			),
		).toBeNull();
	});

	it("treats provider ids case-insensitively", () => {
		expect(
			resolveCredentialError(makeConfig({ provider: "Cline-Pass" })),
		).toBeNull();
	});
});

describe("resolveCredentialFailureHint", () => {
	it("points local-auth providers at their own CLI", () => {
		expect(
			resolveCredentialFailureHint("claude-code", {
				providerId: "claude-code",
				localCli: { command: "claude" },
			}),
		).toBe(
			"Sign in again with the `claude` CLI in a terminal, then try again.",
		);
		expect(
			resolveCredentialFailureHint("openai-codex-cli", {
				providerId: "openai-codex-cli",
				localCli: { command: "codex" },
			}),
		).toMatch(/`codex` CLI/);
		expect(
			resolveCredentialFailureHint("opencode", {
				providerId: "opencode",
				localCli: { command: "opencode" },
			}),
		).toMatch(/`opencode` CLI/);
	});

	it("points Cline at signing in again from Settings → Account", () => {
		expect(resolveCredentialFailureHint("cline")).toBe(
			"Sign in to Cline again in Settings → Account, then try again.",
		);
	});

	it("points known non-CLI providers at Settings → Providers", () => {
		for (const providerId of ["anthropic", "openai-codex"]) {
			expect(resolveCredentialFailureHint(providerId, { providerId })).toMatch(
				/Settings → Providers/,
			);
		}
	});

	it.each([
		undefined,
		{ providerId: "unrelated", localCli: { command: "other" } },
	])("does not invent a credential fix when catalog facts are missing or stale", (auth) => {
		expect(resolveCredentialFailureHint("claude-code", auth)).toBe(
			"Sign in again using your provider's authentication method, then try again.",
		);
		expect(resolveCredentialFailureAction("claude-code", auth)).toBeNull();
	});
});

describe("resolveCredentialFailureAction", () => {
	it("does not use a different provider's CLI metadata", () => {
		expect(
			resolveCredentialFailureAction("anthropic", {
				providerId: "custom-cli",
				localCli: { command: "custom" },
			}),
		).toBeNull();
	});
	it("handles custom CLI providers from host metadata", () => {
		expect(
			resolveCredentialFailureAction("custom-cli", {
				providerId: "custom-cli",
				localCli: { command: "custom" },
			}),
		).toBeNull();
	});
	it("offers no in-app action for local-auth providers", () => {
		expect(
			resolveCredentialFailureAction("claude-code", {
				providerId: "claude-code",
				localCli: { command: "claude" },
			}),
		).toBeNull();
	});

	it("sends Cline to the Account page and other providers to Models", () => {
		expect(resolveCredentialFailureAction("cline")).toEqual({
			label: "Sign in to Cline",
			target: "account",
		});
		expect(
			resolveCredentialFailureAction("anthropic", { providerId: "anthropic" }),
		).toEqual({
			label: "Open API providers",
			target: "models",
		});
	});
});

describe("inferHydratedChatStatus", () => {
	it("treats an assistant-answered running record as completed", () => {
		// The stale-record heuristic: a "running" record whose transcript
		// ends on an assistant answer is read as a session that died without
		// a status flip. (The stale-stream poll deliberately bypasses this
		// via mapSessionRecordStatus — see use-chat-session.)
		expect(
			inferHydratedChatStatus("running", [
				{
					id: "u",
					sessionId: "s",
					role: "user",
					content: "prompt",
					createdAt: 1,
				},
				{
					id: "a",
					sessionId: "s",
					role: "assistant",
					content: "answer",
					createdAt: 2,
				},
			]),
		).toBe("completed");
	});
});

describe("extractAssistantTurnDataFromRpcMessages", () => {
	it("does not render a display-only error as an assistant response", () => {
		expect(
			extractAssistantTurnDataFromRpcMessages([
				{ role: "user", content: "hi" },
				{
					role: "assistant",
					content: "API key expired.",
					metadata: { displayOnly: true, displayRole: "error" },
				},
			]),
		).toEqual({
			text: "",
			reasoning: "",
			reasoningRedacted: false,
			images: [],
			media: [],
		});
	});
});

describe("live markers across canonical history", () => {
	const user = (id: string, createdAt: number) => ({
		id,
		sessionId: "s",
		role: "user" as const,
		content: "Add a retry",
		createdAt,
	});

	it("keeps memory and notice rows and the served model of an answer", () => {
		const live = [
			user("live-user", 1),
			{
				id: "memory-1",
				sessionId: "s",
				role: "status" as const,
				content: "Recalled 1 note from memory",
				createdAt: 2,
				meta: {
					messageKind: KNOWLEDGE_VAULT_MESSAGE_KIND,
					knowledgeVault: {
						ts: 1,
						kind: "recall" as const,
						status: "completed" as const,
						count: 1,
					},
				},
			},
			{
				id: "live-answer",
				sessionId: "s",
				role: "assistant" as const,
				content: "Added the retry.",
				createdAt: 3,
				meta: { modelId: "auto", responseModelId: "gpt-5.4-mini" },
			},
			{
				id: "transient",
				sessionId: "s",
				role: "status" as const,
				content: "Session started: s",
				createdAt: 4,
			},
		];
		const history = [
			user("canonical-user", 1),
			{
				id: "canonical-answer",
				sessionId: "s",
				role: "assistant" as const,
				content: "Added the retry.",
				createdAt: 3,
				meta: { modelId: "auto" },
			},
		];

		const merged = carryLiveDetailsIntoHistory(history, live);

		expect(merged.map((message) => message.id)).toEqual([
			"canonical-user",
			"memory-1",
			"canonical-answer",
		]);
		expect(merged[2]?.meta).toEqual({
			modelId: "auto",
			responseModelId: "gpt-5.4-mini",
		});
		expect(carryLiveDetailsIntoHistory(history, [user("u", 1)])).toBe(history);
	});

	it("updates a write marker in place by its timestamp", () => {
		const running = applyKnowledgeVaultMarker(
			[],
			"s",
			{ ts: 5, kind: "write", status: "running" },
			10,
		);
		const done = applyKnowledgeVaultMarker(
			running,
			"s",
			{ ts: 5, kind: "write", status: "failed", body: "boom\ntrace" },
			20,
		);
		expect(done).toHaveLength(1);
		expect(done[0]).toMatchObject({
			id: running[0]?.id,
			createdAt: 10,
			content: "Note failed: boom",
		});
	});

	it("compares served and selected models loosely", () => {
		expect(isServedByDifferentModel("gpt-5.4-mini", "auto")).toBe(true);
		expect(
			isServedByDifferentModel(
				"claude-sonnet-4.6",
				"anthropic/claude-sonnet-4.6",
			),
		).toBe(false);
		expect(isServedByDifferentModel("gpt-4o-2024-08-06", "gpt-4o")).toBe(false);
		expect(isServedByDifferentModel(undefined, "gpt-4o")).toBe(false);
		expect(isServedByDifferentModel("gpt-4o", undefined)).toBe(true);
	});

	it("reads only the three provider notice kinds", () => {
		expect(
			readProviderNotice(
				JSON.stringify({
					message: "Using Chat Completions",
					metadata: { kind: "responses_unavailable", modelId: "gpt-x" },
				}),
			),
		).toEqual({
			kind: "responses_unavailable",
			message: "Using Chat Completions",
			modelId: "gpt-x",
		});
		expect(
			readProviderNotice(
				JSON.stringify({ message: "x", metadata: { kind: "plugin" } }),
			),
		).toBeUndefined();
		expect(readProviderNotice("not json")).toBeUndefined();
	});
});
