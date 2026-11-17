import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ProviderSettingsManager } from "@cline/core";
import { describe, expect, it, vi } from "vitest";
import {
	getPersistedProviderApiKey,
	normalizeAuthProviderId,
	parseAuthCommandArgs,
	saveOAuthProviderSettings,
} from "./auth";

describe("parseAuthCommandArgs", () => {
	it("parses Azure API version quick setup option", () => {
		expect(
			parseAuthCommandArgs([
				"--provider",
				"openai-compatible",
				"--apikey",
				"key",
				"--modelid",
				"gpt-4.1",
				"--baseurl",
				"https://example.openai.azure.com/openai/deployments/gpt-4.1",
				"--azure-api-version",
				"2025-01-01-preview",
			]),
		).toMatchObject({
			explicitProvider: "openai-compatible",
			apikey: "key",
			modelid: "gpt-4.1",
			baseurl: "https://example.openai.azure.com/openai/deployments/gpt-4.1",
			azureApiVersion: "2025-01-01-preview",
		});
	});
});

describe("saveOAuthProviderSettings", () => {
	it("preserves existing manual apiKey while updating OAuth tokens", () => {
		const save = vi.fn();
		const manager = {
			saveProviderSettings: save,
		} as unknown as ProviderSettingsManager;

		const merged = saveOAuthProviderSettings(
			manager,
			"cline",
			{
				provider: "cline",
				apiKey: "manual-key",
				auth: {
					accessToken: "workos:old-access",
					refreshToken: "old-refresh",
					accountId: "acct-old",
				},
			},
			{
				access: "new-access",
				refresh: "new-refresh",
				expires: 4_000_000_000_000,
				accountId: "acct-new",
			},
		);

		expect(merged).toMatchObject({
			provider: "cline",
			apiKey: "manual-key",
			auth: {
				accessToken: "workos:new-access",
				refreshToken: "new-refresh",
				accountId: "acct-new",
				expiresAt: 4_000_000_000_000,
			},
		});
		expect(save).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "cline",
				apiKey: "manual-key",
				auth: expect.objectContaining({
					accessToken: "workos:new-access",
				}),
			}),
			{ tokenSource: "oauth" },
		);
	});
});

describe("getPersistedProviderApiKey", () => {
	it("does not double-prefix persisted Cline OAuth tokens", () => {
		expect(
			getPersistedProviderApiKey("cline", {
				provider: "cline",
				auth: {
					accessToken: "workos:oauth-access",
				},
			}),
		).toBe("workos:oauth-access");
	});
});

describe("normalizeAuthProviderId", () => {
	it("keeps CLI-only codex shorthand in CLI parsing", () => {
		expect(normalizeAuthProviderId("codex")).toBe("openai-codex");
	});
});

describe("loadAuthTuiRuntime", () => {
	it("loads OpenTUI React after provider catalog initialization", async () => {
		const cliRoot = fileURLToPath(new URL("../..", import.meta.url));
		const script = `
import { ProviderSettingsManager, ensureCustomProvidersLoaded, listLocalProviders } from "@cline/core";
import { loadAuthTuiRuntime } from "./src/commands/auth.ts";
const manager = new ProviderSettingsManager();
await ensureCustomProvidersLoaded(manager);
await listLocalProviders(manager);
const runtime = await loadAuthTuiRuntime();
if (typeof runtime.createCliRenderer !== "function") throw new Error("missing createCliRenderer");
if (typeof runtime.createRoot !== "function") throw new Error("missing createRoot");
if (typeof runtime.OnboardingView !== "function") throw new Error("missing OnboardingView");
`;

		const result = spawnSync(
			"bun",
			["--conditions=development", "-e", script],
			{
				cwd: cliRoot,
				encoding: "utf8",
			},
		);

		expect(result.error).toBeUndefined();
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
	});
});

describe("auth --api-protocol and --baseurl", () => {
	async function makeManager() {
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { ProviderSettingsManager } = await import("@cline/core");
		const dir = mkdtempSync(join(tmpdir(), "cli-auth-protocol-"));
		return new ProviderSettingsManager({
			filePath: join(dir, "providers.json"),
		});
	}

	function makeIo() {
		const lines: string[] = [];
		const errors: string[] = [];
		return {
			lines,
			errors,
			io: {
				writeln: (text?: string) => lines.push(text ?? ""),
				writeErr: (text: string) => errors.push(text),
			},
		};
	}

	it("maps --api-protocol values to the providers.json protocol", async () => {
		const { resolveAuthApiProtocol } = await import("./auth");
		expect(resolveAuthApiProtocol("auto")).toBeUndefined();
		expect(resolveAuthApiProtocol("chat")).toBe("openai-chat");
		expect(resolveAuthApiProtocol("Responses")).toBe("openai-responses");
		expect(resolveAuthApiProtocol("grpc")).toBeNull();
		expect(
			parseAuthCommandArgs([
				"openai-compatible",
				"--api-protocol",
				"responses",
			]),
		).toMatchObject({
			explicitProvider: "openai-compatible",
			apiProtocol: "responses",
		});
	});

	it("saves the protocol with quick setup and removes it for auto", async () => {
		const { runAuthCommand } = await import("./auth");
		const manager = await makeManager();
		const { io, errors } = makeIo();

		await expect(
			runAuthCommand({
				providerSettingsManager: manager,
				io,
				explicitProvider: "openai-compatible",
				apikey: "sk-1",
				modelid: "model-a",
				baseurl: "https://llm.example.test/v1",
				apiProtocol: "responses",
			}),
		).resolves.toBe(0);
		expect(errors).toEqual([]);
		expect(manager.getProviderSettings("openai-compatible")).toMatchObject({
			apiKey: "sk-1",
			model: "model-a",
			baseUrl: "https://llm.example.test/v1",
			protocol: "openai-responses",
		});

		// Protocol only: keeps the rest of the entry.
		await expect(
			runAuthCommand({
				providerSettingsManager: manager,
				io,
				explicitProvider: "openai-compatible",
				apiProtocol: "chat",
			}),
		).resolves.toBe(0);
		expect(manager.getProviderSettings("openai-compatible")).toMatchObject({
			apiKey: "sk-1",
			protocol: "openai-chat",
		});

		await expect(
			runAuthCommand({
				providerSettingsManager: manager,
				io,
				explicitProvider: "openai-compatible",
				apiProtocol: "auto",
			}),
		).resolves.toBe(0);
		const saved = manager.getProviderSettings("openai-compatible");
		expect(saved?.protocol).toBeUndefined();
		expect(saved?.apiKey).toBe("sk-1");
	});

	it("rejects --api-protocol for other providers and unknown values", async () => {
		const { runAuthCommand } = await import("./auth");
		const manager = await makeManager();
		const { io, errors } = makeIo();

		await expect(
			runAuthCommand({
				providerSettingsManager: manager,
				io,
				explicitProvider: "anthropic",
				apikey: "sk-1",
				modelid: "claude",
				apiProtocol: "chat",
			}),
		).resolves.toBe(1);
		expect(errors.at(-1)).toContain("only supported for the OpenAI-compatible");

		await expect(
			runAuthCommand({
				providerSettingsManager: manager,
				io,
				explicitProvider: "openai-compatible",
				apiProtocol: "grpc",
			}),
		).resolves.toBe(1);
		expect(errors.at(-1)).toContain('invalid API protocol "grpc"');

		await expect(
			runAuthCommand({
				providerSettingsManager: manager,
				io,
				explicitProvider: "openai-compatible",
				apiProtocol: "chat",
			}),
		).resolves.toBe(1);
		expect(errors.at(-1)).toContain("not configured yet");
	});

	it("accepts --baseurl for GoodVision", async () => {
		const { runAuthCommand } = await import("./auth");
		const manager = await makeManager();
		const { io, errors } = makeIo();

		await expect(
			runAuthCommand({
				providerSettingsManager: manager,
				io,
				explicitProvider: "goodvision",
				apikey: "gv-key",
				modelid: "auto",
				baseurl: "https://test.goodvision.example/v1",
			}),
		).resolves.toBe(0);
		expect(errors).toEqual([]);
		expect(manager.getProviderSettings("goodvision")).toMatchObject({
			baseUrl: "https://test.goodvision.example/v1",
		});

		await expect(
			runAuthCommand({
				providerSettingsManager: manager,
				io,
				explicitProvider: "anthropic",
				apikey: "k",
				modelid: "m",
				baseurl: "https://x.example",
			}),
		).resolves.toBe(1);
		expect(errors.at(-1)).toContain("base URL is only supported");
	});
});
