import { createInterface } from "node:readline";
import {
	type KnowledgeVaultGlobalSettings,
	KnowledgeVaultStore,
	readKnowledgeVaultSettingsGlobally,
	renderKnowledgeVaultBody,
} from "@cline/core";
import {
	formatKnowledgeVaultSettingsLine,
	formatKnowledgeVaultSummaryLines,
	loadKnowledgeVaultSummary,
} from "../utils/knowledge-vault";

export interface MemoryCommandIo {
	writeln: (text?: string) => void;
	writeErr: (text: string) => void;
}

export interface MemoryCommandInput {
	/** Workspace root whose vault is inspected. */
	workspaceRoot: string;
	io: MemoryCommandIo;
	json?: boolean;
	/** Print the notes as they are recalled into a task (the injected body). */
	body?: boolean;
	clear?: boolean;
	/** Note id to delete. */
	deleteId?: string;
	/** Skip the confirmation prompt of `--clear`. */
	yes?: boolean;
	isTty?: boolean;
	confirm?: (question: string) => Promise<boolean>;
	readSettings?: () => KnowledgeVaultGlobalSettings;
}

async function confirmInTerminal(question: string): Promise<boolean> {
	return await new Promise<boolean>((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${question} [y/N] `, (answer) => {
			rl.close();
			resolve(/^y(es)?$/i.test(answer.trim()));
		});
	});
}

/**
 * `cline memory`: list the workspace's Knowledge Vault notes, print the
 * recalled body, delete one note, or clear the vault.
 */
export async function runMemoryCommand(
	input: MemoryCommandInput,
): Promise<number> {
	const { io } = input;
	const readSettings = input.readSettings ?? readKnowledgeVaultSettingsGlobally;
	const store = KnowledgeVaultStore.forWorkspace(input.workspaceRoot);

	if (input.clear && input.deleteId) {
		io.writeErr("memory accepts only one of --clear or --delete");
		return 1;
	}

	if (input.deleteId) {
		const id = input.deleteId.trim();
		const before = await store.list();
		if (!before.some((note) => note.id === id)) {
			io.writeErr(`no note with id "${id}" in ${store.filePath}`);
			return 1;
		}
		const remaining = await store.delete(id);
		if (input.json) {
			io.writeln(JSON.stringify({ deleted: id, remaining: remaining.length }));
		} else {
			io.writeln(
				`Deleted note ${id} (${remaining.length} note${remaining.length === 1 ? "" : "s"} left).`,
			);
		}
		return 0;
	}

	if (input.clear) {
		const notes = await store.list();
		if (notes.length === 0) {
			if (input.json) {
				io.writeln(JSON.stringify({ cleared: 0, path: store.filePath }));
			} else {
				io.writeln(`The vault is already empty (${store.filePath}).`);
			}
			return 0;
		}
		if (!input.yes) {
			const isTty =
				input.isTty ??
				(process.stdin.isTTY === true && process.stdout.isTTY === true);
			if (!isTty || input.json) {
				io.writeErr(
					"memory --clear needs confirmation: pass --yes to clear without a prompt",
				);
				return 1;
			}
			const confirm = input.confirm ?? confirmInTerminal;
			const confirmed = await confirm(
				`Delete all ${notes.length} note${notes.length === 1 ? "" : "s"} from ${store.filePath}?`,
			);
			if (!confirmed) {
				io.writeln("Cancelled.");
				return 1;
			}
		}
		await store.clear();
		if (input.json) {
			io.writeln(
				JSON.stringify({ cleared: notes.length, path: store.filePath }),
			);
		} else {
			io.writeln(
				`Cleared ${notes.length} note${notes.length === 1 ? "" : "s"} from ${store.filePath}.`,
			);
		}
		return 0;
	}

	const summary = await loadKnowledgeVaultSummary(
		input.workspaceRoot,
		readSettings,
	);
	if (input.json) {
		io.writeln(
			JSON.stringify({
				path: summary.path,
				settings: summary.settings,
				notes: summary.notes,
				...(input.body
					? { body: renderKnowledgeVaultBody(summary.notes) }
					: {}),
			}),
		);
		return 0;
	}
	if (input.body) {
		io.writeln(formatKnowledgeVaultSettingsLine(summary.settings));
		io.writeln(`Vault: ${summary.path}`);
		io.writeln();
		io.writeln(
			summary.notes.length > 0
				? renderKnowledgeVaultBody(summary.notes)
				: "No notes yet.",
		);
		return 0;
	}
	for (const line of formatKnowledgeVaultSummaryLines(summary)) {
		io.writeln(line);
	}
	return 0;
}
