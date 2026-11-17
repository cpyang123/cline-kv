"use client";

import { Switch } from "@cline/ui";
import { ChevronRight, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { desktopClient } from "@/lib/desktop-client";
import { cn } from "@/lib/utils";
import {
	LOCAL_WORKSPACE_ENVIRONMENT_ID,
	readWorkspaceSelectionFromWindow,
} from "@/lib/workspace-paths";
import { PageFrame, PageHeader } from "../page-layout";

export type KnowledgeVaultSettings = {
	enabled: boolean;
	template: string;
	writer: string;
	writeMode: string;
};

type OptionEntry = { value: string; label: string; description: string };

/** `get_knowledge_vault_settings`: the sidecar sends core's labels. */
export type KnowledgeVaultSettingsResponse = {
	settings: KnowledgeVaultSettings;
	options: {
		templates: OptionEntry[];
		writers: OptionEntry[];
		writeModes: OptionEntry[];
	};
};

type VaultNote = {
	id: string;
	ts: number;
	label: string;
	note: string;
	model?: string;
	mode?: string;
};

type VaultNotesResponse = {
	workspaceRoot: string;
	path: string;
	notes: VaultNote[];
};

const ROW_CLASS =
	"flex items-center justify-between gap-5 border-b py-4 max-[720px]:flex-col max-[720px]:items-stretch";
const SELECT_CLASS =
	"h-9 w-72 shrink-0 rounded border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring disabled:opacity-60 max-[720px]:w-full";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function initialWorkspaces(): { selected: string; known: string[] } {
	const stored = readWorkspaceSelectionFromWindow(
		LOCAL_WORKSPACE_ENVIRONMENT_ID,
	);
	const known = [
		...new Set(
			[stored.lastWorkspace, ...stored.workspaces]
				.map((path) => path.trim())
				.filter(Boolean),
		),
	];
	return { selected: known[0] ?? "", known };
}

function OptionSelect({
	label,
	value,
	options,
	disabled,
	onChange,
}: {
	label: string;
	value: string;
	options: OptionEntry[];
	disabled: boolean;
	onChange: (value: string) => void;
}) {
	const selected = options.find((option) => option.value === value);
	return (
		<div className={ROW_CLASS}>
			<div className="flex min-w-0 flex-col gap-1">
				<p className="text-base font-semibold text-foreground">{label}</p>
				{selected ? (
					<p className="text-sm text-muted-foreground">
						{selected.description}
					</p>
				) : null}
			</div>
			<select
				aria-label={label}
				className={SELECT_CLASS}
				disabled={disabled}
				onChange={(event) => onChange(event.target.value)}
				value={value}
			>
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		</div>
	);
}

function NoteRow({
	note,
	deleting,
	onDelete,
}: {
	note: VaultNote;
	deleting: boolean;
	onDelete: () => void;
}) {
	const [expanded, setExpanded] = useState(false);
	return (
		<li className="border-b py-3">
			<div className="flex items-center justify-between gap-3">
				<button
					aria-expanded={expanded}
					className="flex min-w-0 items-center gap-1.5 text-left text-sm text-foreground hover:text-primary"
					onClick={() => setExpanded((value) => !value)}
					type="button"
				>
					<ChevronRight
						aria-hidden
						className={cn(
							"size-3.5 shrink-0 transition-transform",
							expanded && "rotate-90",
						)}
					/>
					<span className="truncate">{note.label || note.id}</span>
				</button>
				<Button
					aria-label={`Delete note ${note.label || note.id}`}
					disabled={deleting}
					onClick={onDelete}
					size="icon"
					type="button"
					variant="ghost"
				>
					<Trash2 className="size-4" />
				</Button>
			</div>
			{expanded ? (
				<pre className="mt-2 max-h-80 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground">
					{note.note}
				</pre>
			) : null}
		</li>
	);
}

/**
 * Knowledge Vault settings (shared with the CLI through the global settings
 * file) and the notes the vault holds for a workspace.
 */
export function MemorySettingsContent() {
	const [response, setResponse] =
		useState<KnowledgeVaultSettingsResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [settingsError, setSettingsError] = useState<string | null>(null);
	const [{ selected: initialWorkspace, known: knownWorkspaces }] =
		useState(initialWorkspaces);
	const [workspace, setWorkspace] = useState(initialWorkspace);
	const [notes, setNotes] = useState<VaultNotesResponse | null>(null);
	const [notesError, setNotesError] = useState<string | null>(null);
	const [notesBusy, setNotesBusy] = useState(false);
	const [confirmClear, setConfirmClear] = useState(false);
	const notesRequestRef = useRef(0);

	useEffect(() => {
		let cancelled = false;
		void desktopClient
			.invoke<KnowledgeVaultSettingsResponse>("get_knowledge_vault_settings")
			.then((result) => {
				if (!cancelled) setResponse(result);
			})
			.catch((error: unknown) => {
				if (!cancelled) setSettingsError(errorText(error));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const runNotesCommand = useCallback(
		async (command: string, args: Record<string, unknown> = {}) => {
			const requestId = ++notesRequestRef.current;
			setNotesBusy(true);
			setNotesError(null);
			try {
				const result = await desktopClient.invoke<VaultNotesResponse>(command, {
					...(workspace ? { workspacePath: workspace } : {}),
					...args,
				});
				if (notesRequestRef.current === requestId) setNotes(result);
			} catch (error) {
				if (notesRequestRef.current === requestId) {
					setNotesError(errorText(error));
				}
			} finally {
				if (notesRequestRef.current === requestId) setNotesBusy(false);
			}
		},
		[workspace],
	);

	useEffect(() => {
		setConfirmClear(false);
		void runNotesCommand("list_knowledge_vault_notes");
	}, [runNotesCommand]);

	const update = async (patch: Partial<KnowledgeVaultSettings>) => {
		if (!response) return;
		const previous = response;
		// Optimistic: the control moves at once and rolls back on failure.
		setResponse({
			...response,
			settings: { ...response.settings, ...patch },
		});
		setSaving(true);
		setSettingsError(null);
		try {
			setResponse(
				await desktopClient.invoke<KnowledgeVaultSettingsResponse>(
					"set_knowledge_vault_settings",
					patch,
				),
			);
		} catch (error) {
			setResponse(previous);
			setSettingsError(errorText(error));
		} finally {
			setSaving(false);
		}
	};

	const settings = response?.settings;
	const controlsDisabled = loading || saving || !settings;
	const noteCount = notes?.notes.length ?? 0;

	return (
		<PageFrame>
			<PageHeader
				description="The Knowledge Vault keeps short notes about each workspace: Cline recalls them at the start of a task and writes one after a task that used tools completes. These settings are shared with the Cline CLI."
				title="Memory"
			/>
			<section className="max-w-344">
				<div className={ROW_CLASS}>
					<div className="flex flex-col gap-1">
						<p className="text-base font-semibold text-foreground">
							Workspace memory
						</p>
						<p className="text-sm text-muted-foreground">
							Recall earlier notes into new tasks and save a note when a task
							completes.
						</p>
						{settingsError ? (
							<p className="mt-2 text-xs text-destructive" role="alert">
								Failed to update memory settings: {settingsError}
							</p>
						) : null}
					</div>
					<Switch
						aria-label="Workspace memory"
						checked={settings?.enabled ?? false}
						disabled={controlsDisabled}
						onCheckedChange={(checked) => void update({ enabled: checked })}
					/>
				</div>
				{response && settings ? (
					<>
						<OptionSelect
							disabled={controlsDisabled}
							label="Note template"
							onChange={(template) => void update({ template })}
							options={response.options.templates}
							value={settings.template}
						/>
						<OptionSelect
							disabled={controlsDisabled}
							label="Note writer"
							onChange={(writer) => void update({ writer })}
							options={response.options.writers}
							value={settings.writer}
						/>
						<OptionSelect
							disabled={controlsDisabled}
							label="Write mode"
							onChange={(writeMode) => void update({ writeMode })}
							options={response.options.writeModes}
							value={settings.writeMode}
						/>
					</>
				) : null}

				<div className="mt-8 flex flex-col gap-3">
					<div className="flex items-center justify-between gap-4 max-[720px]:flex-col max-[720px]:items-stretch">
						<div className="flex min-w-0 flex-col gap-1">
							<h2 className="text-lg font-semibold text-foreground">
								Saved notes
							</h2>
							{notes?.path ? (
								<p className="truncate font-mono text-xs text-muted-foreground">
									{notes.path}
								</p>
							) : null}
						</div>
						<div className="flex shrink-0 items-center gap-2">
							{knownWorkspaces.length > 1 ? (
								<select
									aria-label="Workspace"
									className={cn(SELECT_CLASS, "w-56")}
									onChange={(event) => setWorkspace(event.target.value)}
									value={workspace}
								>
									{knownWorkspaces.map((path) => (
										<option key={path} value={path}>
											{path}
										</option>
									))}
								</select>
							) : null}
							{confirmClear ? (
								<>
									<Button
										disabled={notesBusy}
										onClick={() => {
											setConfirmClear(false);
											void runNotesCommand("clear_knowledge_vault_notes");
										}}
										size="sm"
										type="button"
										variant="destructive"
									>
										Delete {noteCount} {noteCount === 1 ? "note" : "notes"}
									</Button>
									<Button
										onClick={() => setConfirmClear(false)}
										size="sm"
										type="button"
										variant="outline"
									>
										Cancel
									</Button>
								</>
							) : (
								<Button
									disabled={notesBusy || noteCount === 0}
									onClick={() => setConfirmClear(true)}
									size="sm"
									type="button"
									variant="outline"
								>
									Clear all
								</Button>
							)}
						</div>
					</div>
					{notesError ? (
						<p className="text-xs text-destructive" role="alert">
							{notesError}
						</p>
					) : null}
					{notes && noteCount === 0 ? (
						<p className="text-sm text-muted-foreground">
							No notes yet for this workspace.
						</p>
					) : null}
					{noteCount > 0 ? (
						<ul aria-label="Saved notes" className="border-t">
							{notes?.notes.map((note) => (
								<NoteRow
									deleting={notesBusy}
									key={note.id}
									note={note}
									onDelete={() =>
										void runNotesCommand("delete_knowledge_vault_note", {
											id: note.id,
										})
									}
								/>
							))}
						</ul>
					) : null}
				</div>
			</section>
		</PageFrame>
	);
}
