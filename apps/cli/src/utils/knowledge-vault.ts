/**
 * Knowledge Vault (per-workspace memory) for CLI sessions.
 *
 * The vault itself lives in `@cline/core` (hooks, store, writer). This module
 * adapts it to the CLI: settings come from the global settings file shared
 * with the other Cline hosts (read per run, so `/settings` changes apply to
 * the next run), an optional `--memory` / `--no-memory` override applies to
 * one CLI invocation, and the writer runs on the session's provider
 * connection as the CLI resolved it.
 */
import {
	type AgentHooks,
	type BasicLogger,
	buildKnowledgeVaultHooks,
	composeAgentHooks,
	createKnowledgeVaultWriterHandler,
	KNOWLEDGE_VAULT_GOODVISION_PROVIDER_ID,
	type KnowledgeVaultEvent,
	type KnowledgeVaultGlobalSettings,
	type KnowledgeVaultNote,
	type KnowledgeVaultNoteWriterHandler,
	KnowledgeVaultStore,
	knowledgeVaultNoteLabel,
	ProviderSettingsManager,
	readKnowledgeVaultSettingsGlobally,
} from "@cline/core";
import { resolveCompactionProviderConfig } from "../runtime/interactive/compaction";
import { getPersistedProviderApiKey, isOAuthProvider } from "./provider-auth";
import type { Config } from "./types";

/** How long a CLI process waits for a pending note write before exiting. */
export const KNOWLEDGE_VAULT_EXIT_WAIT_MS = 60_000;

/** Status notice metadata kind the CLI uses to carry vault events to the TUI. */
export const KNOWLEDGE_VAULT_NOTICE_KIND = "knowledge_vault";

/** Shared across the vault instances of one CLI process (one per session start). */
export interface KnowledgeVaultWriteTracker {
	track(write: Promise<void>): void;
	pending(): number;
	/** Resolves `true` once every tracked write settled, `false` on timeout. */
	waitAll(timeoutMs?: number): Promise<boolean>;
}

export function createKnowledgeVaultWriteTracker(): KnowledgeVaultWriteTracker {
	const writes = new Set<Promise<void>>();
	return {
		track(write) {
			const settled = write.catch(() => {});
			writes.add(settled);
			void settled.finally(() => writes.delete(settled));
		},
		pending: () => writes.size,
		async waitAll(timeoutMs = KNOWLEDGE_VAULT_EXIT_WAIT_MS) {
			if (writes.size === 0) {
				return true;
			}
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs);
				timer.unref?.();
			});
			try {
				return await Promise.race([
					Promise.allSettled([...writes]).then(() => true as const),
					timeout,
				]);
			} finally {
				if (timer) clearTimeout(timer);
			}
		},
	};
}

export interface CliKnowledgeVault {
	hooks: AgentHooks;
	tracker: KnowledgeVaultWriteTracker;
	/** Resolves `true` once pending writes settled, `false` on timeout. */
	waitForWrites(timeoutMs?: number): Promise<boolean>;
}

export interface CreateCliKnowledgeVaultInput {
	/** The live session config; read at write time so model switches apply. */
	getConfig: () => Config;
	/** Workspace whose `.cline/knowledge-vault/notes.jsonl` the session uses. */
	workspaceRoot: string;
	providerSettingsManager?: ProviderSettingsManager;
	onEvent?: (event: KnowledgeVaultEvent) => void;
	logger?: BasicLogger;
	tracker?: KnowledgeVaultWriteTracker;
	/** Test seams. */
	readSettings?: () => KnowledgeVaultGlobalSettings;
	createWriterHandler?: (
		options: Parameters<typeof createKnowledgeVaultWriterHandler>[0],
	) => Promise<KnowledgeVaultNoteWriterHandler>;
}

/** The global vault settings with the CLI's one-run `--memory` override applied. */
export function resolveCliKnowledgeVaultSettings(
	config: Pick<Config, "knowledgeVaultEnabled">,
	readSettings: () => KnowledgeVaultGlobalSettings = readKnowledgeVaultSettingsGlobally,
): KnowledgeVaultGlobalSettings {
	const settings = readSettings();
	return typeof config.knowledgeVaultEnabled === "boolean"
		? { ...settings, enabled: config.knowledgeVaultEnabled }
		: settings;
}

export function createCliKnowledgeVault(
	input: CreateCliKnowledgeVaultInput,
): CliKnowledgeVault {
	const readSettings = input.readSettings ?? readKnowledgeVaultSettingsGlobally;
	const settings = () =>
		resolveCliKnowledgeVaultSettings(input.getConfig(), readSettings);
	const tracker = input.tracker ?? createKnowledgeVaultWriteTracker();
	let providerSettingsManager = input.providerSettingsManager;
	const getProviderSettingsManager = () => {
		providerSettingsManager ??= new ProviderSettingsManager();
		return providerSettingsManager;
	};
	const createWriterHandler =
		input.createWriterHandler ?? createKnowledgeVaultWriterHandler;

	const vault = buildKnowledgeVaultHooks({
		isEnabled: () => settings().enabled,
		getTemplate: () => settings().template,
		getWriter: () => settings().writer,
		getWriteMode: () => settings().writeMode,
		store: KnowledgeVaultStore.forWorkspace(input.workspaceRoot),
		createWriterHandler: async () => {
			const config = input.getConfig();
			const manager = getProviderSettingsManager();
			// OAuth tokens refresh during a session and are persisted; the key the
			// CLI resolved at startup may be stale by the time the note is written.
			const apiKey =
				(isOAuthProvider(config.providerId)
					? getPersistedProviderApiKey(
							config.providerId,
							manager.getProviderSettings(config.providerId),
						)
					: undefined) ||
				config.apiKey ||
				undefined;
			return createWriterHandler({
				writer: settings().writer,
				session: {
					providerId: config.providerId,
					modelId: config.modelId,
					apiKey,
					baseUrl: config.baseUrl,
					headers: config.headers,
					providerConfig: resolveCompactionProviderConfig(config, manager),
				},
				providerSettings: manager,
				goodVisionModelId:
					config.providerId === KNOWLEDGE_VAULT_GOODVISION_PROVIDER_ID
						? config.modelId
						: undefined,
				logger: input.logger,
			});
		},
		onEvent: input.onEvent,
		logger: input.logger,
	});

	const afterRun = vault.hooks.afterRun;
	const hooks: AgentHooks = {
		...vault.hooks,
		...(afterRun
			? {
					afterRun: async (ctx) => {
						await afterRun(ctx);
						// The write is detached; track it so the process can wait for
						// it before exiting.
						tracker.track(vault.waitForWrites());
					},
				}
			: {}),
	};

	return {
		hooks,
		tracker,
		waitForWrites: (timeoutMs) => tracker.waitAll(timeoutMs),
	};
}

/** File hooks first (they may stop a run), then the vault. */
export function composeWithKnowledgeVault(
	hooks: AgentHooks | undefined,
	vault: CliKnowledgeVault | undefined,
): AgentHooks | undefined {
	if (!vault) {
		return hooks;
	}
	return composeAgentHooks(hooks, vault.hooks);
}

function firstLine(text: string | undefined): string | undefined {
	const line = text
		?.split("\n")
		.map((part) => part.trim())
		.find(Boolean);
	if (!line) return undefined;
	return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

/** One-line description of a vault event (`[memory] <text>` in plain mode). */
export function formatKnowledgeVaultEvent(
	event: KnowledgeVaultEvent,
): string | undefined {
	if (event.kind === "recall") {
		if (event.status !== "completed") return undefined;
		const count = event.count ?? 0;
		return `recalled ${count} note${count === 1 ? "" : "s"}`;
	}
	switch (event.status) {
		case "running":
			return "saving note…";
		case "completed":
			return "note saved";
		case "failed":
			return `note failed: ${firstLine(event.body) ?? event.reason ?? "unknown error"}`;
	}
}

/** Wraps a vault event as a status notice so it travels the agent event path. */
export function knowledgeVaultEventToNotice(event: KnowledgeVaultEvent) {
	return {
		type: "notice" as const,
		noticeType: "status" as const,
		displayRole: "status" as const,
		message: formatKnowledgeVaultEvent(event) ?? "",
		metadata: { kind: KNOWLEDGE_VAULT_NOTICE_KIND, event },
	};
}

export function parseKnowledgeVaultNoticeMetadata(
	metadata: Record<string, unknown> | undefined,
): KnowledgeVaultEvent | undefined {
	if (metadata?.kind !== KNOWLEDGE_VAULT_NOTICE_KIND) return undefined;
	const event = metadata.event as KnowledgeVaultEvent | undefined;
	if (
		!event ||
		typeof event !== "object" ||
		(event.kind !== "recall" && event.kind !== "write")
	) {
		return undefined;
	}
	return event;
}

export interface KnowledgeVaultSummary {
	path: string;
	settings: KnowledgeVaultGlobalSettings;
	notes: KnowledgeVaultNote[];
}

export async function loadKnowledgeVaultSummary(
	workspaceRoot: string,
	readSettings: () => KnowledgeVaultGlobalSettings = readKnowledgeVaultSettingsGlobally,
): Promise<KnowledgeVaultSummary> {
	const store = KnowledgeVaultStore.forWorkspace(workspaceRoot);
	return {
		path: store.filePath,
		settings: readSettings(),
		notes: await store.list(),
	};
}

export function formatKnowledgeVaultSettingsLine(
	settings: KnowledgeVaultGlobalSettings,
): string {
	return `Memory ${settings.enabled ? "on" : "off"} · template ${settings.template} · writer ${settings.writer} · write mode ${settings.writeMode}`;
}

/** Plain-text lines describing a workspace vault (for `cline memory` and `/memory`). */
export function formatKnowledgeVaultSummaryLines(
	summary: KnowledgeVaultSummary,
): string[] {
	const lines = [
		formatKnowledgeVaultSettingsLine(summary.settings),
		`Vault: ${summary.path}`,
	];
	if (summary.notes.length === 0) {
		lines.push("No notes yet.");
		return lines;
	}
	lines.push(
		`${summary.notes.length} note${summary.notes.length === 1 ? "" : "s"}:`,
	);
	for (const note of summary.notes) {
		const writer = [note.provider, note.model].filter(Boolean).join("/");
		lines.push(
			`  ${note.id}  ${knowledgeVaultNoteLabel(note)}${writer ? `  (${writer})` : ""}`,
		);
	}
	return lines;
}
