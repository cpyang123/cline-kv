import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type KnowledgeVaultGlobalSettings,
	type KnowledgeVaultNoteWriterHandler,
	KnowledgeVaultStore,
	readKnowledgeVaultSettingsGlobally,
} from "@cline/core";
import type { AgentMessage } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleChatSessionCommand } from "./chat-session";
import { handleCommand } from "./commands";
import { createSidecarContext, handleCoreSessionEvent } from "./context";
import {
	createDesktopKnowledgeVaultHooks,
	KNOWLEDGE_VAULT_STREAM,
} from "./knowledge-vault";
import type { SidecarContext } from "./types";

const TWO_BLOCK_NOTE =
	"FILES: src/fetch.ts\nSTATUS: completed | TESTS: bun test [last exit 0]\nDID: added retry | WHERE: src/fetch.ts:12 (fetchWithRetry)";

let counter = 0;
function message(
	role: AgentMessage["role"],
	content: AgentMessage["content"],
): AgentMessage {
	counter += 1;
	return { id: `m${counter}`, role, content, createdAt: counter };
}

const firstPrompt = [
	message("user", [{ type: "text", text: "Add a retry to the fetch helper" }]),
];
const completedSession: AgentMessage[] = [
	...firstPrompt,
	message("assistant", [
		{
			type: "tool-call",
			toolCallId: "c1",
			toolName: "editor",
			input: { path: "src/fetch.ts" },
		},
	]),
	message("user", [
		{ type: "tool-result", toolCallId: "c1", toolName: "editor", output: "ok" },
	]),
	message("assistant", [{ type: "text", text: "Done." }]),
];

/** The hook context as it arrives over the Hub: plain JSON. */
function runContext(messages: AgentMessage[]) {
	return JSON.parse(
		JSON.stringify({
			snapshot: {
				conversationId: "session-kv",
				runId: "run-1",
				agentId: "agent-1",
				messages,
			},
		}),
	);
}

function stubWriter(reply: string): KnowledgeVaultNoteWriterHandler {
	return {
		getModel: () => ({
			id: "writer-model",
			providerId: "openai-compatible",
			info: { contextWindow: 200_000 },
		}),
		createMessage() {
			async function* stream() {
				yield { type: "text" as const, text: reply };
				yield { type: "done" as const, success: true };
			}
			return stream() as never;
		},
	};
}

function chunksFor(events: Array<{ name: string; payload: unknown }>) {
	return events
		.filter((event) => event.name === "chat_event")
		.map((event) => event.payload as { stream: string; chunk: string })
		.filter((payload) => payload.stream === KNOWLEDGE_VAULT_STREAM)
		.map((payload) => JSON.parse(payload.chunk));
}

let dataDir: string;
let workspace: string;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "cline-desktop-kv-data-"));
	workspace = mkdtempSync(join(tmpdir(), "cline-desktop-kv-ws-"));
	process.env.CLINE_DATA_DIR = dataDir;
});

afterEach(() => {
	delete process.env.CLINE_DATA_DIR;
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(workspace, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function contextWithEvents(): {
	ctx: SidecarContext;
	events: Array<{ name: string; payload: unknown }>;
} {
	const events: Array<{ name: string; payload: unknown }> = [];
	const ctx = createSidecarContext(workspace);
	ctx.wsClients.add({
		send: (raw: string) => events.push(JSON.parse(raw).event),
	});
	return { ctx, events };
}

const defaults: KnowledgeVaultGlobalSettings = {
	enabled: true,
	template: "two-block",
	writer: "task",
	writeMode: "separate",
};

describe("desktop Knowledge Vault hooks", () => {
	it("is skipped for SSH sessions, whose workspace is remote", () => {
		const { ctx } = contextWithEvents();
		expect(
			createDesktopKnowledgeVaultHooks(ctx, {
				getSessionId: () => "s",
				getWorkspaceRoot: () => "/remote/project",
				resolveConnection: async () => ({ providerId: "x", modelId: "y" }),
				remote: true,
			}),
		).toBeUndefined();
	});

	it("registers only run hooks unless the session starts in inline mode", () => {
		const { ctx } = contextWithEvents();
		const options = {
			getSessionId: () => "s",
			getWorkspaceRoot: () => workspace,
			resolveConnection: async () => ({ providerId: "x", modelId: "y" }),
		};
		const separate = createDesktopKnowledgeVaultHooks(ctx, {
			...options,
			readSettings: () => defaults,
		});
		expect(Object.keys(separate ?? {}).sort()).toEqual([
			"afterRun",
			"beforeRun",
		]);
		const inline = createDesktopKnowledgeVaultHooks(ctx, {
			...options,
			readSettings: () => ({ ...defaults, writeMode: "inline" }),
		});
		expect(Object.keys(inline ?? {}).sort()).toEqual([
			"afterRun",
			"beforeModel",
			"beforeRun",
		]);
	});

	it("recalls the workspace's notes and forwards the recall to the webview", async () => {
		await KnowledgeVaultStore.forWorkspace(workspace).upsert({
			id: "n1",
			ts: Date.parse("2026-01-02T00:00:00Z"),
			taskId: "earlier",
			task: "Fix the login flow",
			note: TWO_BLOCK_NOTE,
			template: "two-block",
		});
		const { ctx, events } = contextWithEvents();
		const hooks = createDesktopKnowledgeVaultHooks(ctx, {
			getSessionId: () => "session-kv",
			getWorkspaceRoot: () => workspace,
			resolveConnection: async () => ({ providerId: "x", modelId: "y" }),
			readSettings: () => defaults,
		});

		const result = await hooks?.beforeRun?.(runContext(firstPrompt));

		expect(result?.appendContext).toContain("<memory_context>");
		expect(result?.appendContext).toContain(TWO_BLOCK_NOTE);
		const [recall] = chunksFor(events);
		expect(recall).toMatchObject({
			kind: "recall",
			status: "completed",
			count: 1,
		});
		expect(recall.body).toContain("Fix the login flow");
		expect(
			(events[0]?.payload as { sessionId?: string } | undefined)?.sessionId,
		).toBe("session-kv");
	});

	it("does nothing when the vault is disabled", async () => {
		await KnowledgeVaultStore.forWorkspace(workspace).upsert({
			id: "n1",
			ts: 1,
			taskId: "earlier",
			task: "x",
			note: TWO_BLOCK_NOTE,
			template: "two-block",
		});
		const { ctx, events } = contextWithEvents();
		const createWriterHandler = vi.fn();
		const hooks = createDesktopKnowledgeVaultHooks(ctx, {
			getSessionId: () => "session-kv",
			getWorkspaceRoot: () => workspace,
			resolveConnection: async () => ({ providerId: "x", modelId: "y" }),
			readSettings: () => ({ ...defaults, enabled: false }),
			createWriterHandler,
		});
		expect(await hooks?.beforeRun?.(runContext(firstPrompt))).toBeUndefined();
		await hooks?.afterRun?.({
			...runContext(completedSession),
			result: { status: "completed" },
		});
		expect(createWriterHandler).not.toHaveBeenCalled();
		expect(chunksFor(events)).toEqual([]);
	});

	it("writes a note with the session's live connection and reports running then completed", async () => {
		const { ctx, events } = contextWithEvents();
		const resolveConnection = vi.fn(async () => ({
			providerId: "openai-compatible",
			modelId: "gpt-test",
			apiKey: "sk-test",
		}));
		const createWriterHandler = vi.fn(async () => stubWriter(TWO_BLOCK_NOTE));
		const hooks = createDesktopKnowledgeVaultHooks(ctx, {
			getSessionId: () => "session-kv",
			getWorkspaceRoot: () => workspace,
			resolveConnection,
			readSettings: () => defaults,
			createWriterHandler,
		});

		await hooks?.afterRun?.({
			...runContext(completedSession),
			result: { status: "completed" },
		});
		await vi.waitFor(async () => {
			expect(await KnowledgeVaultStore.forWorkspace(workspace).list()).toEqual([
				expect.objectContaining({ note: TWO_BLOCK_NOTE }),
			]);
		});
		expect(createWriterHandler).toHaveBeenCalledWith("task", {
			providerId: "openai-compatible",
			modelId: "gpt-test",
			apiKey: "sk-test",
		});
		await vi.waitFor(() => expect(chunksFor(events)).toHaveLength(2));
		const [running, completed] = chunksFor(events);
		expect(running).toMatchObject({ kind: "write", status: "running" });
		expect(completed).toMatchObject({
			kind: "write",
			status: "completed",
			body: TWO_BLOCK_NOTE,
			ts: running.ts,
		});
	});

	it("reports a failed write without throwing into the run", async () => {
		const { ctx, events } = contextWithEvents();
		const hooks = createDesktopKnowledgeVaultHooks(ctx, {
			getSessionId: () => "session-kv",
			getWorkspaceRoot: () => workspace,
			resolveConnection: async () => {
				throw new Error("no credentials");
			},
			readSettings: () => defaults,
		});
		await expect(
			hooks?.afterRun?.({
				...runContext(completedSession),
				result: { status: "completed" },
			}),
		).resolves.toBeUndefined();
		await vi.waitFor(() =>
			expect(chunksFor(events).at(-1)).toMatchObject({
				kind: "write",
				status: "failed",
				body: "no credentials",
			}),
		);
	});

	it("tolerates a malformed hook context from the Hub", async () => {
		const { ctx } = contextWithEvents();
		const hooks = createDesktopKnowledgeVaultHooks(ctx, {
			getSessionId: () => "session-kv",
			getWorkspaceRoot: () => workspace,
			resolveConnection: async () => ({ providerId: "x", modelId: "y" }),
			readSettings: () => defaults,
		});
		await expect(hooks?.afterRun?.({} as never)).resolves.toBeUndefined();
		await expect(hooks?.beforeRun?.({} as never)).resolves.toBeUndefined();
	});
});

describe("Knowledge Vault in desktop session starts", () => {
	function startManager() {
		return vi.fn(
			async (_input: {
				config: Record<string, unknown>;
				localRuntime?: Record<string, unknown>;
			}) => ({
				sessionId: "session-kv",
				manifest: { cwd: workspace, workspace_root: workspace },
			}),
		);
	}

	function bindingContext(
		kind: "local" | "ssh",
		start: ReturnType<typeof startManager>,
	) {
		const { ctx, events } = contextWithEvents();
		ctx.runtimeBindings.set(kind === "ssh" ? "ssh-1" : "local", {
			environmentId: kind === "ssh" ? "ssh-1" : "local",
			kind,
			workspaceRoot: workspace,
			sessionManager: { start, readMessages: vi.fn(async () => []) },
			hubClient: { command: vi.fn() },
			unsubscribeSessionEvents: () => {},
		} as never);
		return { ctx, events };
	}

	it("passes the vault hooks as a local runtime option on local starts", async () => {
		const start = startManager();
		const { ctx } = bindingContext("local", start);
		await handleChatSessionCommand(ctx, {
			action: "start",
			config: { provider: "cline", model: "m", cwd: workspace },
		});
		const input = start.mock.calls[0]?.[0];
		expect(input?.config).not.toHaveProperty("hooks");
		const hooks = input?.localRuntime?.hooks as Record<string, unknown>;
		expect(typeof hooks?.beforeRun).toBe("function");
		expect(typeof hooks?.afterRun).toBe("function");
	});

	it("leaves SSH sessions without vault hooks", async () => {
		const start = startManager();
		const { ctx } = bindingContext("ssh", start);
		await handleChatSessionCommand(ctx, {
			action: "start",
			config: { sessionId: "session-kv", environmentId: "ssh-1" },
		});
		expect(start.mock.calls[0]?.[0].localRuntime).not.toHaveProperty("hooks");
	});

	it("recalls into the workspace the SDK resolved for a pathless chat", async () => {
		await KnowledgeVaultStore.forWorkspace(workspace).upsert({
			id: "n1",
			ts: 1,
			taskId: "earlier",
			task: "Earlier task",
			note: TWO_BLOCK_NOTE,
			template: "two-block",
		});
		const start = startManager();
		const { ctx, events } = bindingContext("local", start);
		await handleChatSessionCommand(ctx, {
			action: "start",
			config: { provider: "cline", model: "m" },
		});
		const hooks = start.mock.calls[0]?.[0].localRuntime?.hooks as {
			beforeRun: (ctx: unknown) => Promise<{ appendContext?: string }>;
		};
		const result = await hooks.beforeRun(runContext(firstPrompt));
		expect(result?.appendContext).toContain(TWO_BLOCK_NOTE);
		expect(chunksFor(events)[0]).toMatchObject({ kind: "recall", count: 1 });
	});
});

describe("Knowledge Vault commands", () => {
	it("reads and writes the shared global settings with core's labels", async () => {
		const { ctx } = contextWithEvents();
		const initial = (await handleCommand(
			ctx,
			"get_knowledge_vault_settings",
		)) as {
			settings: KnowledgeVaultGlobalSettings;
			options: { writers: Array<{ value: string; label: string }> };
		};
		expect(initial.settings).toEqual(readKnowledgeVaultSettingsGlobally());
		expect(initial.options.writers.map((option) => option.value)).toEqual([
			"task",
			"goodvision",
		]);
		expect(initial.options.writers[1]?.label).toBe("GoodVision SmartRouter");

		const updated = (await handleCommand(ctx, "set_knowledge_vault_settings", {
			enabled: false,
			writeMode: "inline",
		})) as { settings: KnowledgeVaultGlobalSettings };
		expect(updated.settings).toMatchObject({
			enabled: false,
			writeMode: "inline",
		});
		expect(readKnowledgeVaultSettingsGlobally()).toMatchObject({
			enabled: false,
			writeMode: "inline",
		});
	});

	it("rejects unknown setting values", async () => {
		const { ctx } = contextWithEvents();
		await expect(
			handleCommand(ctx, "set_knowledge_vault_settings", { writer: "nope" }),
		).rejects.toThrow("Unknown Knowledge Vault writer");
		await expect(
			handleCommand(ctx, "set_knowledge_vault_settings", { enabled: "yes" }),
		).rejects.toThrow("enabled must be a boolean");
	});

	it("lists, deletes and clears the notes of the requested workspace", async () => {
		const store = KnowledgeVaultStore.forWorkspace(workspace);
		for (const [id, ts] of [
			["a", 1],
			["b", 2],
		] as const) {
			await store.upsert({
				id,
				ts,
				taskId: `task-${id}`,
				task: `Task ${id}`,
				note: TWO_BLOCK_NOTE,
				template: "two-block",
			});
		}
		const { ctx } = contextWithEvents();
		const listed = (await handleCommand(ctx, "list_knowledge_vault_notes", {
			workspacePath: workspace,
		})) as { path: string; notes: Array<{ id: string; label: string }> };
		expect(listed.path).toBe(store.filePath);
		expect(listed.notes.map((note) => note.id)).toEqual(["b", "a"]);
		expect(listed.notes[0]?.label).toContain("Task b");

		const afterDelete = (await handleCommand(
			ctx,
			"delete_knowledge_vault_note",
			{ workspacePath: workspace, id: "b" },
		)) as { notes: Array<{ id: string }> };
		expect(afterDelete.notes.map((note) => note.id)).toEqual(["a"]);

		// Without a workspace the sidecar's own workspace is used.
		const cleared = (await handleCommand(
			ctx,
			"clear_knowledge_vault_notes",
		)) as { notes: unknown[] };
		expect(cleared.notes).toEqual([]);
		expect(await store.list()).toEqual([]);
	});
});

describe("served model forwarding", () => {
	it("passes the provider's responseModelId through chat_usage", () => {
		const { ctx, events } = contextWithEvents();
		handleCoreSessionEvent(ctx, {
			type: "agent_event",
			payload: {
				sessionId: "session-kv",
				event: {
					type: "usage",
					inputTokens: 10,
					outputTokens: 2,
					responseModelId: "gpt-5.4-mini",
				},
			},
		} as never);
		const usage = events
			.filter((event) => event.name === "chat_event")
			.map((event) => event.payload as { stream: string; chunk: string })
			.find((payload) => payload.stream === "chat_usage");
		expect(JSON.parse(usage?.chunk ?? "{}")).toMatchObject({
			inputTokens: 10,
			responseModelId: "gpt-5.4-mini",
		});
	});
});
