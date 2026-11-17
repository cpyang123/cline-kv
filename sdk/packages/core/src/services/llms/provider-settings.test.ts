import { describe, expect, it } from "vitest";
import { safeParseSettings, toProviderConfig } from "./provider-settings";

describe("provider settings", () => {
	it("formats Cline OAuth access tokens for runtime API keys", () => {
		const config = toProviderConfig({
			provider: "cline",
			model: "anthropic/claude-sonnet-4.6",
			auth: {
				accessToken: "oauth-access-token",
			},
		});

		expect(config.apiKey).toBe("workos:oauth-access-token");
		expect(config.accessToken).toBe("oauth-access-token");
	});

	it("accepts the Bedrock apikey authentication alias", () => {
		const result = safeParseSettings({
			provider: "bedrock",
			model: "anthropic.claude-sonnet-4-5-20250929-v1:0",
			aws: {
				authentication: "apikey",
				region: "us-east-1",
			},
		});

		expect(result.success).toBe(true);
		if (!result.success) {
			throw new Error("expected Bedrock apikey settings to parse");
		}

		expect(toProviderConfig(result.data).aws).toEqual(
			expect.objectContaining({
				authentication: "apikey",
			}),
		);
	});

	it("resolves the regional endpoint from apiLine when no base URL is set", () => {
		expect(
			toProviderConfig({ provider: "zai", apiLine: "china" }),
		).toMatchObject({
			apiLine: "china",
			baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		});

		expect(
			toProviderConfig({ provider: "moonshot", apiLine: "china" }),
		).toMatchObject({
			baseUrl: "https://api.moonshot.cn/v1",
		});

		expect(
			toProviderConfig({ provider: "qwen", apiLine: "international" }),
		).toMatchObject({
			baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
		});
	});

	it("lets an explicit base URL win over apiLine", () => {
		expect(
			toProviderConfig({
				provider: "zai",
				apiLine: "china",
				baseUrl: "https://proxy.example.com/v4",
			}),
		).toMatchObject({
			baseUrl: "https://proxy.example.com/v4",
		});
	});

	it("limits ChatGPT subscription known models to the Codex catalog", () => {
		const knownModels = toProviderConfig({
			provider: "openai-codex",
		}).knownModels;
		const modelIds = Object.keys(knownModels ?? {});

		expect(modelIds).toEqual(
			expect.arrayContaining(["gpt-5.5", "gpt-5.6-terra"]),
		);
		expect(modelIds).not.toContain("gpt-4o");
		expect(modelIds).not.toContain("gpt-4.1");
		expect(modelIds).not.toContain("chatgpt-image-latest");
		expect(modelIds).not.toContain("gpt-5.4-nano");
		expect(knownModels?.["gpt-5.5"]).toMatchObject({
			contextWindow: 400_000,
			maxInputTokens: 272_000 * 0.95,
		});
	});

	describe("OpenAI Compatible API protocol", () => {
		it.each([
			"openai-chat",
			"openai-responses",
		] as const)("maps protocol %s to apiProtocol without rerouting to openai-native", (protocol) => {
			const config = toProviderConfig({
				provider: "openai-compatible",
				model: "gpt-6-luna",
				baseUrl: "https://example.openai.azure.com/openai/v1",
				protocol,
			});

			expect(config.apiProtocol).toBe(protocol);
			expect(config.routingProviderId).toBeUndefined();
		});

		it("leaves apiProtocol unset (Auto) when no protocol is stored", () => {
			const config = toProviderConfig({
				provider: "openai-compatible",
				model: "gpt-6-luna",
			});

			expect(config).not.toHaveProperty("apiProtocol");
			expect(config.routingProviderId).toBeUndefined();
		});

		it("accepts the extension's openai alias", () => {
			expect(
				toProviderConfig({ provider: "openai", protocol: "openai-responses" }),
			).toMatchObject({ apiProtocol: "openai-responses" });
		});

		it("ignores protocols that are not an OpenAI wire protocol", () => {
			const config = toProviderConfig({
				provider: "openai-compatible",
				protocol: "anthropic",
			});

			expect(config).not.toHaveProperty("apiProtocol");
			expect(config.routingProviderId).toBeUndefined();
		});

		it("keeps client openai as the explicit openai-native escape hatch", () => {
			expect(
				toProviderConfig({ provider: "openai-compatible", client: "openai" })
					.routingProviderId,
			).toBe("openai-native");
		});

		it("still routes other providers' Responses protocol through openai-native", () => {
			const config = toProviderConfig({
				provider: "my-gateway",
				protocol: "openai-responses",
				baseUrl: "https://gateway.example/v1",
			});

			expect(config.routingProviderId).toBe("openai-native");
			expect(config).not.toHaveProperty("apiProtocol");
		});
	});

	it("keeps the provider default base URL when no apiLine is set", () => {
		expect(toProviderConfig({ provider: "zai" })).toMatchObject({
			baseUrl: "https://api.z.ai/api/paas/v4",
		});
		expect(toProviderConfig({ provider: "moonshot" })).toMatchObject({
			baseUrl: "https://api.moonshot.ai/v1",
		});
	});
});
