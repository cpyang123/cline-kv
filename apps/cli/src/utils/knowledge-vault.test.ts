import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type KnowledgeVaultEvent,
	type KnowledgeVaultGlobalSettings,
	type KnowledgeVaultNoteWriterHandler,
	KnowledgeVaultStore,
	type ProviderSettingsManager,
} from "@cline/core";
import type { AgentMessage } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	composeWithKnowledgeVault,
	createCliKnowledgeVault,
	createKnowledgeVaultWriteTracker,
	formatKnowledgeVaultEvent,
	formatKnowledgeVaultSummaryLines,
	knowledgeVaultEventToNotice,
	loadKnowledgeVaultSummary,
	parseKnowledgeVaultNoticeMetadata,
	resolveCliKnowledgeVaultSettings,
} from "./knowledge-vault";
import type { Config } from "./types";

const DEFAULTS: KnowledgeVaultGlobalSettings = {
	enabled: true,
	template: "two-block",
	writer: "task",
	writeMode: "separate",
};

const TWO_BLOCK_NOTE =
	"FILES: src/fetch.ts\nSTATUS: completed | TESTS: bun test [last exit 0]\nDID: added retry | WHERE: src/fetch.ts:12 (fetchWithRetry)";

const taskOnly: AgentMessage[] = [
	{
		id: "m1",
		role: "user",
		content: [{ type: "text", text: "Add a retry to the fetch helper" }],
		createdAt: 1,
	},
];
const fullSession: AgentMessage[] = [
	...taskOnly,
	{
		id: "m2",
		role: "assistant",
		content: [
			{
				type: "tool-call",
				toolCallId: "c1",
				toolName: "write_to_file",
				input: { path: "src/fetch.ts", content: "..." },
			},
		],
		createdAt: 2,
	},
	{
		id: "m3",
		role: "user",
		content: [
			{
				type: "tool-result",
				toolCallId: "c1",
				toolName: "write_to_file",
				output: "ok",
			},
		],
		createdAt: 3,
	},
	{
		id: "m4",
		role: "assistant",
		content: [{ type: "text", text: "Done." }],
		createdAt: 4,
	},
];

function snapshotOf(messages: AgentMessage[]) {
	return {
		conversationId: "conv-1",
		runId: "run-1",
		agentId: "agent-1",
		messages,
	};
}

function writerReturning(text: string): KnowledgeVaultNoteWriterHandler {
	return {
		getModel: () => ({
			id: "model-a",
			providerId: "openai-compatible",
			info: { contextWindow: 200_000 },
		}),
		createMessage() {
			async function* stream() {
				yield { type: "text" as const, text };
				yield { type: "done" as const, success: true };
			}
			return stream();
		},
	} as KnowledgeVaultNoteWriterHandler;
}

function makeConfig(overrides: Partial<Config> = {}): Config {
	return {
		providerId: "openai-compatible",
		modelId: "model-a",
		apiKey: "sk-test",
		cwd: "/tmp",
		verbose: false,
		sandbox: false,
		outputMode: "text",
		mode: "act",
		defaultToolAutoApprove: true,
		toolPolicies: {},
		systemPrompt: "",
		enableTools: true,
		enableSpawnAgent: false,
		enableAgentTeams: false,
		...overrides,
	} as Config;
}

function stubProviderSettings(): ProviderSettingsManager {
	return {
		getProviderSettings: (id: string) =>
			id === "openai-compatible"
				? {
						provider: "openai-compatible",
						model: "model-a",
						apiKey: "sk-saved",
						baseUrl: "https://llm.example.test/v1",
						protocol: "openai-chat",
					}
				: undefined,
	} as unknown as ProviderSettingsManager;
}

describe("CLI Knowledge Vault", () => {
	let dir: string;
	let events: KnowledgeVaultEvent[];

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-kv-"));
		events = [];
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("applies the one-run --memory override over the global setting", () => {
		expect(resolveCliKnowledgeVaultSettings({}, () => DEFAULTS).enabled).toBe(
			true,
		);
		expect(
			resolveCliKnowledgeVaultSettings(
				{ knowledgeVaultEnabled: false },
				() => DEFAULTS,
			).enabled,
		).toBe(false);
		expect(
			resolveCliKnowledgeVaultSettings({ knowledgeVaultEnabled: true }, () => ({
				...DEFAULTS,
				enabled: false,
			})).enabled,
		).toBe(true);
	});

	it("recalls the workspace's notes and writes a note on the session's connection", async () => {
		const store = KnowledgeVaultStore.forWorkspace(dir);
		await store.upsert({
			id: "old",
			ts: Date.UTC(2026, 9, 1),
			taskId: "old-task",
			task: "Old task",
			note: "DID: old | WHERE: a:1 | VERIFY: none",
			template: "fused",
		});
		const createWriterHandler = vi.fn(async () =>
			writerReturning(TWO_BLOCK_NOTE),
		);
		const vault = createCliKnowledgeVault({
			getConfig: () => makeConfig(),
			workspaceRoot: dir,
			providerSettingsManager: stubProviderSettings(),
			onEvent: (event) => events.push(event),
			readSettings: () => DEFAULTS,
			createWriterHandler,
		});

		const recall = await vault.hooks.beforeRun?.({
			snapshot: snapshotOf(taskOnly),
		} as never);
		expect(recall?.appendContext).toContain("DID: old");
		expect(events[0]).toMatchObject({
			kind: "recall",
			status: "completed",
			count: 1,
		});

		await vault.hooks.afterRun?.({
			snapshot: snapshotOf(fullSession),
			result: { status: "completed", outputText: "Done." },
		} as never);
		expect(vault.tracker.pending()).toBe(1);
		await expect(vault.waitForWrites(5_000)).resolves.toBe(true);
		expect(vault.tracker.pending()).toBe(0);

		const writes = events.filter((event) => event.kind === "write");
		expect(writes.map((event) => event.status)).toEqual([
			"running",
			"completed",
		]);
		expect(writes[0]?.ts).toBe(writes[1]?.ts);

		const notes = await store.list();
		expect(notes).toHaveLength(2);
		expect(notes[1]?.note).toBe(TWO_BLOCK_NOTE);

		const options = (
			createWriterHandler.mock.calls as unknown as Array<
				[
					{
						writer: string;
						session: Record<string, unknown> & {
							providerConfig?: Record<string, unknown>;
						};
						providerSettings: unknown;
					},
				]
			>
		)[0]?.[0];
		expect(options?.writer).toBe("task");
		expect(options?.session).toMatchObject({
			providerId: "openai-compatible",
			modelId: "model-a",
			apiKey: "sk-test",
		});
		expect(options?.session.providerConfig).toMatchObject({
			providerId: "openai-compatible",
			baseUrl: "https://llm.example.test/v1",
			apiProtocol: "openai-chat",
		});
		expect(options?.providerSettings).toBeDefined();
	});

	it("does nothing when --no-memory is set", async () => {
		const store = KnowledgeVaultStore.forWorkspace(dir);
		await store.upsert({
			id: "old",
			ts: 1,
			taskId: "old-task",
			task: "Old task",
			note: "DID: old | WHERE: a:1 | VERIFY: none",
			template: "fused",
		});
		const createWriterHandler = vi.fn(async () =>
			writerReturning(TWO_BLOCK_NOTE),
		);
		const vault = createCliKnowledgeVault({
			getConfig: () => makeConfig({ knowledgeVaultEnabled: false }),
			workspaceRoot: dir,
			providerSettingsManager: stubProviderSettings(),
			onEvent: (event) => events.push(event),
			readSettings: () => DEFAULTS,
			createWriterHandler,
		});
		await expect(
			vault.hooks.beforeRun?.({ snapshot: snapshotOf(taskOnly) } as never),
		).resolves.toBeUndefined();
		await vault.hooks.afterRun?.({
			snapshot: snapshotOf(fullSession),
			result: { status: "completed", outputText: "Done." },
		} as never);
		await vault.waitForWrites(1_000);
		expect(createWriterHandler).not.toHaveBeenCalled();
		expect(events).toEqual([]);
	});

	it("composes with file hooks and stands alone when file hooks are off (yolo)", async () => {
		const vault = createCliKnowledgeVault({
			getConfig: () => makeConfig(),
			workspaceRoot: dir,
			readSettings: () => DEFAULTS,
		});
		const alone = composeWithKnowledgeVault(undefined, vault);
		expect(alone?.beforeRun).toBeTypeOf("function");
		expect(alone?.afterRun).toBeTypeOf("function");

		const fileBeforeRun = vi.fn(async () => ({ appendContext: "FILE HOOK" }));
		const composed = composeWithKnowledgeVault(
			{ beforeRun: fileBeforeRun },
			vault,
		);
		const result = await composed?.beforeRun?.({
			snapshot: snapshotOf(taskOnly),
		} as never);
		expect(fileBeforeRun).toHaveBeenCalled();
		expect(result).toEqual({ appendContext: "FILE HOOK" });
		expect(composeWithKnowledgeVault(undefined, undefined)).toBeUndefined();
	});

	it("bounds the wait for pending writes", async () => {
		const tracker = createKnowledgeVaultWriteTracker();
		await expect(tracker.waitAll(10)).resolves.toBe(true);
		tracker.track(new Promise<void>(() => {}));
		expect(tracker.pending()).toBe(1);
		await expect(tracker.waitAll(20)).resolves.toBe(false);
		tracker.track(Promise.reject(new Error("boom")));
		await Promise.resolve();
	});

	it("formats vault events for the status line", () => {
		expect(
			formatKnowledgeVaultEvent({
				ts: 1,
				kind: "recall",
				status: "completed",
				count: 3,
			}),
		).toBe("recalled 3 notes");
		expect(
			formatKnowledgeVaultEvent({
				ts: 1,
				kind: "recall",
				status: "completed",
				count: 1,
			}),
		).toBe("recalled 1 note");
		expect(
			formatKnowledgeVaultEvent({ ts: 1, kind: "write", status: "running" }),
		).toBe("saving note…");
		expect(
			formatKnowledgeVaultEvent({ ts: 1, kind: "write", status: "completed" }),
		).toBe("note saved");
		expect(
			formatKnowledgeVaultEvent({
				ts: 1,
				kind: "write",
				status: "failed",
				body: "\n401 Unauthorized\nmore detail",
			}),
		).toBe("note failed: 401 Unauthorized");
	});

	it("round-trips vault events through status notices", () => {
		const event: KnowledgeVaultEvent = {
			ts: 5,
			kind: "write",
			status: "completed",
		};
		const notice = knowledgeVaultEventToNotice(event);
		expect(notice).toMatchObject({
			type: "notice",
			displayRole: "status",
			message: "note saved",
		});
		expect(parseKnowledgeVaultNoticeMetadata(notice.metadata)).toEqual(event);
		expect(
			parseKnowledgeVaultNoticeMetadata({ kind: "responses_unavailable" }),
		).toBeUndefined();
	});

	it("summarizes a workspace vault", async () => {
		const empty = await loadKnowledgeVaultSummary(dir, () => DEFAULTS);
		expect(formatKnowledgeVaultSummaryLines(empty)).toEqual([
			"Memory on · template two-block · writer task · write mode separate",
			`Vault: ${path.join(dir, ".cline", "knowledge-vault", "notes.jsonl")}`,
			"No notes yet.",
		]);
		await KnowledgeVaultStore.forWorkspace(dir).upsert({
			id: "n1",
			ts: Date.UTC(2026, 9, 1),
			taskId: "t",
			task: "Fix the parser",
			note: TWO_BLOCK_NOTE,
			template: "two-block",
			provider: "goodvision",
			model: "auto",
		});
		const lines = formatKnowledgeVaultSummaryLines(
			await loadKnowledgeVaultSummary(dir, () => DEFAULTS),
		);
		expect(lines[2]).toBe("1 note:");
		expect(lines[3]).toBe("  n1  2026-10-01 Fix the parser  (goodvision/auto)");
	});
});
