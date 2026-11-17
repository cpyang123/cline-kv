/**
 * Knowledge Vault (per-workspace memory) for desktop chat sessions.
 *
 * Sessions run in the shared Hub daemon, but the hooks passed in the start
 * config are proxied back to this process: recall (`beforeRun`) and the note
 * write (`afterRun`) run here, read the global settings here, build the writer
 * from this machine's provider settings, and report to the webview as
 * `chat_knowledge_vault` chunks.
 */
import {
	buildKnowledgeVaultHooks,
	createKnowledgeVaultWriterHandler,
	isKnowledgeVaultTemplate,
	isKnowledgeVaultWriteMode,
	isKnowledgeVaultWriter,
	KNOWLEDGE_VAULT_GOODVISION_PROVIDER_ID,
	KNOWLEDGE_VAULT_TEMPLATE_LABELS,
	KNOWLEDGE_VAULT_TEMPLATES,
	KNOWLEDGE_VAULT_WRITE_MODE_LABELS,
	KNOWLEDGE_VAULT_WRITE_MODES,
	KNOWLEDGE_VAULT_WRITER_LABELS,
	KNOWLEDGE_VAULT_WRITERS,
	type KnowledgeVaultEvent,
	type KnowledgeVaultGlobalSettings,
	type KnowledgeVaultHooks,
	type KnowledgeVaultNoteWriterHandler,
	type KnowledgeVaultOptionLabel,
	KnowledgeVaultStore,
	type KnowledgeVaultWriterSessionConnection,
	knowledgeVaultNoteLabel,
	ProviderSettingsManager,
	readKnowledgeVaultSettingsGlobally,
	setKnowledgeVaultSettingsGlobally,
} from "@cline/core";
import type { AgentHooks } from "@cline/shared";
import { emitChunk } from "./context";
import type { SidecarContext } from "./types";

/** chat_event stream carrying {@link KnowledgeVaultEvent} JSON. */
export const KNOWLEDGE_VAULT_STREAM = "chat_knowledge_vault";

export type DesktopKnowledgeVaultOptions = {
	/** The session id; resolved once the session has started. */
	getSessionId: () => string;
	/** The workspace whose vault the session reads and writes. */
	getWorkspaceRoot: () => string | undefined;
	/** The session's current provider connection, with stored credentials resolved. */
	resolveConnection: () => Promise<KnowledgeVaultWriterSessionConnection>;
	/**
	 * SSH sessions run against a remote workspace: the vault file lives under
	 * the workspace, which this process cannot write, so the vault is skipped.
	 */
	remote?: boolean;
	/** Test seams. */
	readSettings?: () => KnowledgeVaultGlobalSettings;
	createWriterHandler?: (
		writer: KnowledgeVaultGlobalSettings["writer"],
		connection: KnowledgeVaultWriterSessionConnection,
	) => Promise<KnowledgeVaultNoteWriterHandler>;
};

function readSettingsSafely(
	ctx: SidecarContext,
	read: () => KnowledgeVaultGlobalSettings,
): KnowledgeVaultGlobalSettings | undefined {
	try {
		return read();
	} catch (error) {
		ctx.logger?.log("Failed to read Knowledge Vault settings", {
			severity: "warn",
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

/**
 * Whether the vault needs the per-model-call capture hook: only the
 * in-session (`inline`) write replays the actor's last request, and over the
 * Hub every `beforeModel` is a client round trip carrying the whole request,
 * so it is registered only when the session starts in that mode. A session
 * switched to inline later falls back to the separate writer call.
 */
function needsModelCapture(settings: KnowledgeVaultGlobalSettings): boolean {
	return (
		settings.writeMode === "inline" &&
		settings.writer === "task" &&
		settings.template === "two-block"
	);
}

/**
 * Builds the Knowledge Vault hook bag for one desktop session. The vault
 * itself is created lazily on the first run, when the session id and its
 * workspace (the SDK resolves pathless chats) are known; settings are read
 * per run so changes apply without restarting the session.
 */
export function createDesktopKnowledgeVaultHooks(
	ctx: SidecarContext,
	options: DesktopKnowledgeVaultOptions,
): AgentHooks | undefined {
	if (options.remote) return undefined;
	const readSettings =
		options.readSettings ?? readKnowledgeVaultSettingsGlobally;
	const settingsAtStart = readSettingsSafely(ctx, readSettings);
	const current = () => readSettingsSafely(ctx, readSettings);

	let vault: KnowledgeVaultHooks | undefined;
	let vaultRoot: string | undefined;
	const getVault = (): KnowledgeVaultHooks | undefined => {
		const root = options.getWorkspaceRoot()?.trim();
		if (!root) return undefined;
		if (vault && vaultRoot === root) return vault;
		vaultRoot = root;
		vault = buildKnowledgeVaultHooks({
			isEnabled: () => current()?.enabled === true,
			getTemplate: () => current()?.template ?? "two-block",
			getWriter: () => current()?.writer ?? "task",
			getWriteMode: () => current()?.writeMode ?? "separate",
			store: KnowledgeVaultStore.forWorkspace(root),
			createWriterHandler: async () => {
				const writer = current()?.writer ?? "task";
				const connection = await options.resolveConnection();
				return options.createWriterHandler
					? options.createWriterHandler(writer, connection)
					: createKnowledgeVaultWriterHandler({
							writer,
							session: connection,
							providerSettings: new ProviderSettingsManager(),
							...(connection.providerId ===
								KNOWLEDGE_VAULT_GOODVISION_PROVIDER_ID && connection.modelId
								? { goodVisionModelId: connection.modelId }
								: {}),
							logger: ctx.logger,
						});
			},
			onEvent: (event) => forwardKnowledgeVaultEvent(ctx, options, event),
			logger: ctx.logger,
		});
		return vault;
	};

	const hooks: AgentHooks = {
		beforeRun: async (runContext) => {
			try {
				return await getVault()?.hooks.beforeRun?.(runContext);
			} catch (error) {
				logHookFailure(ctx, "recall", error);
				return undefined;
			}
		},
		afterRun: async (runContext) => {
			try {
				await getVault()?.hooks.afterRun?.(runContext);
			} catch (error) {
				logHookFailure(ctx, "write", error);
			}
		},
	};
	if (settingsAtStart && needsModelCapture(settingsAtStart)) {
		hooks.beforeModel = async (modelContext) => {
			try {
				return await getVault()?.hooks.beforeModel?.(modelContext);
			} catch (error) {
				logHookFailure(ctx, "capture", error);
				return undefined;
			}
		};
	}
	return hooks;
}

function logHookFailure(
	ctx: SidecarContext,
	phase: string,
	error: unknown,
): void {
	ctx.logger?.log(`[KnowledgeVault] ${phase} hook failed`, {
		severity: "warn",
		error: error instanceof Error ? error.message : String(error),
	});
}

function forwardKnowledgeVaultEvent(
	ctx: SidecarContext,
	options: Pick<DesktopKnowledgeVaultOptions, "getSessionId">,
	event: KnowledgeVaultEvent,
): void {
	const sessionId = options.getSessionId().trim();
	if (!sessionId) return;
	emitChunk(ctx, sessionId, KNOWLEDGE_VAULT_STREAM, JSON.stringify(event));
}

// ---------------------------------------------------------------------------
// Settings + memory inspection commands
// ---------------------------------------------------------------------------

type OptionEntry<T extends string> = KnowledgeVaultOptionLabel & { value: T };

function toOptions<T extends string>(
	values: readonly T[],
	labels: Record<T, KnowledgeVaultOptionLabel>,
): OptionEntry<T>[] {
	return values.map((value) => ({ value, ...labels[value] }));
}

/** The settings with the labels the UI renders; core stays authoritative. */
export function readKnowledgeVaultSettingsResponse() {
	return {
		settings: readKnowledgeVaultSettingsGlobally(),
		options: {
			templates: toOptions(
				KNOWLEDGE_VAULT_TEMPLATES,
				KNOWLEDGE_VAULT_TEMPLATE_LABELS,
			),
			writers: toOptions(
				KNOWLEDGE_VAULT_WRITERS,
				KNOWLEDGE_VAULT_WRITER_LABELS,
			),
			writeModes: toOptions(
				KNOWLEDGE_VAULT_WRITE_MODES,
				KNOWLEDGE_VAULT_WRITE_MODE_LABELS,
			),
		},
	};
}

export function parseKnowledgeVaultSettingsUpdate(
	args: Record<string, unknown> | undefined,
): Partial<KnowledgeVaultGlobalSettings> {
	const update: Partial<KnowledgeVaultGlobalSettings> = {};
	if (args?.enabled !== undefined) {
		if (typeof args.enabled !== "boolean") {
			throw new Error("enabled must be a boolean");
		}
		update.enabled = args.enabled;
	}
	if (args?.template !== undefined) {
		if (!isKnowledgeVaultTemplate(args.template)) {
			throw new Error(`Unknown Knowledge Vault template: ${args.template}`);
		}
		update.template = args.template;
	}
	if (args?.writer !== undefined) {
		if (!isKnowledgeVaultWriter(args.writer)) {
			throw new Error(`Unknown Knowledge Vault writer: ${args.writer}`);
		}
		update.writer = args.writer;
	}
	const writeMode = args?.writeMode ?? args?.write_mode;
	if (writeMode !== undefined) {
		if (!isKnowledgeVaultWriteMode(writeMode)) {
			throw new Error(`Unknown Knowledge Vault write mode: ${writeMode}`);
		}
		update.writeMode = writeMode;
	}
	if (Object.keys(update).length === 0) {
		throw new Error("No Knowledge Vault setting to update");
	}
	return update;
}

function resolveVaultWorkspace(
	ctx: SidecarContext,
	args: Record<string, unknown> | undefined,
): string {
	const requested = args?.workspacePath ?? args?.workspaceRoot;
	const workspaceRoot =
		(typeof requested === "string" && requested.trim()) ||
		ctx.localWorkspaceRoot;
	if (!workspaceRoot?.trim()) {
		throw new Error("No workspace is selected");
	}
	return workspaceRoot.trim();
}

async function listVaultNotes(workspaceRoot: string) {
	const store = KnowledgeVaultStore.forWorkspace(workspaceRoot);
	const notes = await store.list();
	return {
		workspaceRoot,
		path: store.filePath,
		// Newest first: the list is for inspection, not injection order.
		notes: notes
			.slice()
			.reverse()
			.map((note) => ({
				id: note.id,
				ts: note.ts,
				taskId: note.taskId,
				label: knowledgeVaultNoteLabel(note),
				note: note.note,
				template: note.template,
				provider: note.provider,
				model: note.model,
				mode: note.mode,
			})),
	};
}

export const KNOWLEDGE_VAULT_COMMANDS = new Set([
	"get_knowledge_vault_settings",
	"set_knowledge_vault_settings",
	"list_knowledge_vault_notes",
	"delete_knowledge_vault_note",
	"clear_knowledge_vault_notes",
]);

export async function handleKnowledgeVaultCommand(
	ctx: SidecarContext,
	command: string,
	args: Record<string, unknown> | undefined,
): Promise<unknown> {
	switch (command) {
		case "get_knowledge_vault_settings":
			return readKnowledgeVaultSettingsResponse();
		case "set_knowledge_vault_settings":
			setKnowledgeVaultSettingsGlobally(
				parseKnowledgeVaultSettingsUpdate(args),
			);
			return readKnowledgeVaultSettingsResponse();
		case "list_knowledge_vault_notes":
			return await listVaultNotes(resolveVaultWorkspace(ctx, args));
		case "delete_knowledge_vault_note": {
			const workspaceRoot = resolveVaultWorkspace(ctx, args);
			const id = typeof args?.id === "string" ? args.id.trim() : "";
			if (!id) throw new Error("note id is required");
			await KnowledgeVaultStore.forWorkspace(workspaceRoot).delete(id);
			return await listVaultNotes(workspaceRoot);
		}
		case "clear_knowledge_vault_notes": {
			const workspaceRoot = resolveVaultWorkspace(ctx, args);
			const store = KnowledgeVaultStore.forWorkspace(workspaceRoot);
			// Clearing a vault that was never written must not create one.
			if (await store.exists()) await store.clear();
			return await listVaultNotes(workspaceRoot);
		}
		default:
			throw new Error(`Unknown Knowledge Vault command: ${command}`);
	}
}
