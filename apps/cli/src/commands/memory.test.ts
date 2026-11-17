import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type KnowledgeVaultGlobalSettings,
	KnowledgeVaultStore,
} from "@cline/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMemoryCommand } from "./memory";

const SETTINGS: KnowledgeVaultGlobalSettings = {
	enabled: true,
	template: "two-block",
	writer: "goodvision",
	writeMode: "separate",
};

describe("cline memory", () => {
	let dir: string;
	let lines: string[];
	let errors: string[];
	const io = {
		writeln: (text?: string) => lines.push(text ?? ""),
		writeErr: (text: string) => errors.push(text),
	};

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-memory-"));
		lines = [];
		errors = [];
		const store = KnowledgeVaultStore.forWorkspace(dir);
		await store.upsert({
			id: "a1",
			ts: Date.UTC(2026, 9, 1),
			taskId: "t1",
			task: "Fix the parser",
			note: "DID: fixed | WHERE: src/parse.ts:3 | VERIFY: bun test",
			template: "fused",
		});
		await store.upsert({
			id: "b2",
			ts: Date.UTC(2026, 9, 2),
			taskId: "t2",
			task: "Add a CLI flag",
			note: "DID: flag | WHERE: src/cli.ts:9 | VERIFY: none",
			template: "fused",
		});
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("lists notes with labels and the vault path", async () => {
		await expect(
			runMemoryCommand({
				workspaceRoot: dir,
				io,
				readSettings: () => SETTINGS,
			}),
		).resolves.toBe(0);
		expect(lines).toEqual([
			"Memory on · template two-block · writer goodvision · write mode separate",
			`Vault: ${path.join(dir, ".cline", "knowledge-vault", "notes.jsonl")}`,
			"2 notes:",
			"  a1  2026-10-01 Fix the parser",
			"  b2  2026-10-02 Add a CLI flag",
		]);
	});

	it("prints JSON with the recalled body", async () => {
		await runMemoryCommand({
			workspaceRoot: dir,
			io,
			json: true,
			body: true,
			readSettings: () => SETTINGS,
		});
		const parsed = JSON.parse(lines[0] ?? "{}");
		expect(parsed.notes).toHaveLength(2);
		expect(parsed.settings).toEqual(SETTINGS);
		expect(parsed.body).toContain("[2026-10-01 Fix the parser]");
	});

	it("deletes one note by id", async () => {
		await expect(
			runMemoryCommand({ workspaceRoot: dir, io, deleteId: "a1" }),
		).resolves.toBe(0);
		const notes = await KnowledgeVaultStore.forWorkspace(dir).list();
		expect(notes.map((note) => note.id)).toEqual(["b2"]);
		await expect(
			runMemoryCommand({ workspaceRoot: dir, io, deleteId: "zz" }),
		).resolves.toBe(1);
		expect(errors.at(-1)).toContain('no note with id "zz"');
	});

	it("clears only after confirmation or --yes", async () => {
		await expect(
			runMemoryCommand({ workspaceRoot: dir, io, clear: true, isTty: false }),
		).resolves.toBe(1);
		expect(errors.at(-1)).toContain("--yes");

		const declined = vi.fn(async () => false);
		await expect(
			runMemoryCommand({
				workspaceRoot: dir,
				io,
				clear: true,
				isTty: true,
				confirm: declined,
			}),
		).resolves.toBe(1);
		expect(declined).toHaveBeenCalledWith(
			expect.stringContaining("Delete all 2 notes"),
		);
		expect(await KnowledgeVaultStore.forWorkspace(dir).list()).toHaveLength(2);

		await expect(
			runMemoryCommand({ workspaceRoot: dir, io, clear: true, yes: true }),
		).resolves.toBe(0);
		expect(await KnowledgeVaultStore.forWorkspace(dir).list()).toEqual([]);
	});
});

describe("cline config memory", () => {
	it("prints the Knowledge Vault settings and vault path", async () => {
		const { runMemoryConfigCommand } = await import("./config");
		const lines: string[] = [];
		const code = runMemoryConfigCommand(
			"/work/repo",
			"text",
			{
				writeln: (text?: string) => lines.push(text ?? ""),
				writeErr: () => {},
			},
			() => SETTINGS,
		);
		expect(code).toBe(0);
		expect(lines).toContain("  enabled     on");
		expect(lines).toContain(
			"  writer      goodvision (GoodVision SmartRouter)",
		);
		expect(lines).toContain(
			`  vault       ${path.join("/work/repo", ".cline", "knowledge-vault", "notes.jsonl")}`,
		);
	});
});
