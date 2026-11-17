import type { ApiHandler } from "@cline/llms";
import { describe, expect, it, vi } from "vitest";
import type {
	ProviderConfig,
	ProviderSettings,
} from "../../services/llms/provider-settings";
import {
	createKnowledgeVaultWriterHandler,
	resolveKnowledgeVaultWriterProviderConfig,
} from "./writer-handler";

function fakeHandler(id: string): ApiHandler {
	return {
		getMessages: () => [],
		getModel: () => ({ id, info: { id, contextWindow: 128_000 } }),
		createMessage: async function* () {
			yield { type: "text", text: "DID: x", id: "1" };
		},
	} as unknown as ApiHandler;
}

const settingsSource = (settings?: ProviderSettings) => ({
	getProviderSettings: vi.fn((providerId: string) =>
		providerId === "goodvision" ? settings : undefined,
	),
});

describe("resolveKnowledgeVaultWriterProviderConfig", () => {
	it("task writer: reuses the session's connection, drops reasoning, pins 900 tokens and temperature 0", () => {
		const config = resolveKnowledgeVaultWriterProviderConfig({
			writer: "task",
			session: {
				providerId: "anthropic",
				modelId: "claude-sonnet-4-5",
				apiKey: "top-level-key",
				providerConfig: {
					providerId: "anthropic",
					modelId: "claude-sonnet-4-5",
					apiKey: "stale-key",
					baseUrl: "https://example.test",
					reasoningEffort: "high",
					thinkingBudgetTokens: 4096,
					temperature: 0.7,
					maxOutputTokens: 32_000,
				} as ProviderConfig,
			},
		});
		expect(config).toMatchObject({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-5",
			apiKey: "top-level-key",
			baseUrl: "https://example.test",
			thinking: false,
			maxOutputTokens: 900,
			temperature: 0,
		});
		expect(config).not.toHaveProperty("reasoningEffort");
		expect(config).not.toHaveProperty("thinkingBudgetTokens");
	});

	it("task writer: ignores a providerConfig snapshot of another provider and omits temperature for models that reject it", () => {
		const config = resolveKnowledgeVaultWriterProviderConfig({
			writer: "task",
			session: {
				providerId: "openai-native",
				modelId: "gpt-5.4-mini",
				apiKey: "k",
				providerConfig: {
					providerId: "anthropic",
					modelId: "x",
					baseUrl: "https://wrong.test",
				} as ProviderConfig,
			},
		});
		expect(config.baseUrl).toBeUndefined();
		expect(config).not.toHaveProperty("temperature");
		expect(config.thinking).toBe(false);
	});

	it("task writer on GoodVision never pins a temperature", () => {
		const config = resolveKnowledgeVaultWriterProviderConfig({
			writer: "task",
			session: {
				providerId: "goodvision",
				modelId: "claude-opus-5",
				apiKey: "k",
				providerConfig: {
					providerId: "goodvision",
					modelId: "claude-opus-5",
					temperature: 0.2,
				} as ProviderConfig,
			},
		});
		expect(config).not.toHaveProperty("temperature");
	});

	it("goodvision writer: reads GoodVision's saved credentials and resolves the model", () => {
		const source = settingsSource({
			provider: "goodvision",
			apiKey: "gv-key",
			baseUrl: "https://gv.test/v1",
			model: "saved-model",
		} as ProviderSettings);
		const session = {
			providerId: "anthropic",
			modelId: "claude-sonnet-4-5",
			apiKey: "anthropic-key",
		};

		const saved = resolveKnowledgeVaultWriterProviderConfig({
			writer: "goodvision",
			session,
			providerSettings: source,
		});
		expect(saved).toMatchObject({
			providerId: "goodvision",
			modelId: "saved-model",
			apiKey: "gv-key",
			baseUrl: "https://gv.test/v1",
			thinking: false,
			maxOutputTokens: 900,
		});
		expect(saved).not.toHaveProperty("temperature");

		const committed = resolveKnowledgeVaultWriterProviderConfig({
			writer: "goodvision",
			session,
			providerSettings: source,
			goodVisionModelId: "committed-model",
		});
		expect(committed.modelId).toBe("committed-model");

		const auto = resolveKnowledgeVaultWriterProviderConfig({
			writer: "goodvision",
			session,
			providerSettings: settingsSource({
				provider: "goodvision",
				apiKey: "gv-key",
			} as ProviderSettings),
		});
		expect(auto.modelId).toBe("auto");
	});

	it("goodvision writer: fails clearly when GoodVision is not configured", () => {
		expect(() =>
			resolveKnowledgeVaultWriterProviderConfig({
				writer: "goodvision",
				session: { providerId: "anthropic", modelId: "m" },
				providerSettings: settingsSource(undefined),
			}),
		).toThrow(/no GoodVision provider is configured/);
		expect(() =>
			resolveKnowledgeVaultWriterProviderConfig({
				writer: "goodvision",
				session: { providerId: "anthropic", modelId: "m" },
			}),
		).toThrow(/no GoodVision provider is configured/);
	});
});

describe("createKnowledgeVaultWriterHandler", () => {
	it("builds the handler from the resolved config and reports its provider id", async () => {
		const createHandler = vi.fn(async (config: ProviderConfig) =>
			fakeHandler(config.modelId),
		);
		const handler = await createKnowledgeVaultWriterHandler({
			writer: "task",
			session: { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
			providerConfigOverrides: { timeoutMs: 1234 },
			createHandler,
		});
		expect(createHandler).toHaveBeenCalledWith(
			expect.objectContaining({
				providerId: "anthropic",
				modelId: "claude-sonnet-4-5",
				timeoutMs: 1234,
				thinking: false,
				maxOutputTokens: 900,
				temperature: 0,
			}),
		);
		expect(handler.getModel()).toMatchObject({
			id: "claude-sonnet-4-5",
			providerId: "anthropic",
			info: { contextWindow: 128_000 },
		});
		const chunks = [];
		for await (const chunk of handler.createMessage("sys", [])) {
			chunks.push(chunk);
		}
		expect(chunks).toEqual([{ type: "text", text: "DID: x", id: "1" }]);
	});
});
