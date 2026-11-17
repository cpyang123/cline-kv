// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeWorkspaceSelectionToWindow } from "@/lib/workspace-paths";
import {
	type KnowledgeVaultSettingsResponse,
	MemorySettingsContent,
} from "./memory-view";
import { SETTINGS_SECTIONS } from "./sections";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/desktop-client", () => ({
	desktopClient: { invoke },
	isTauriAvailable: vi.fn(() => false),
	openExternalUrl: vi.fn(),
}));

class ResizeObserverStub {
	disconnect() {}
	observe() {}
	unobserve() {}
}

const option = (value: string, label: string) => ({
	value,
	label,
	description: `${label} description`,
});

function settingsResponse(
	settings: Partial<KnowledgeVaultSettingsResponse["settings"]> = {},
): KnowledgeVaultSettingsResponse {
	return {
		settings: {
			enabled: true,
			template: "two-block",
			writer: "task",
			writeMode: "separate",
			...settings,
		},
		options: {
			templates: [
				option("fused", "Fused notes"),
				option("two-block", "Two-block note"),
			],
			writers: [
				option("task", "Task model"),
				option("goodvision", "GoodVision SmartRouter"),
			],
			writeModes: [
				option("inline", "In-session"),
				option("separate", "Separate writer call"),
			],
		},
	};
}

const notesResponse = (ids: string[]) => ({
	workspaceRoot: "/work/app",
	path: "/work/app/.cline/knowledge-vault/notes.jsonl",
	notes: ids.map((id, index) => ({
		id,
		ts: index,
		label: `2026-01-0${index + 1} Task ${id}`,
		note: `FILES: ${id}.ts`,
	})),
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	Object.assign(globalThis, {
		IS_REACT_ACT_ENVIRONMENT: true,
		ResizeObserver: ResizeObserverStub,
	});
	if (typeof window.localStorage.clear !== "function") {
		Object.defineProperty(window, "localStorage", {
			configurable: true,
			value: window.sessionStorage,
		});
	}
	window.localStorage.clear();
	writeWorkspaceSelectionToWindow("local", {
		lastWorkspace: "/work/app",
		workspaces: ["/work/app", "/work/lib"],
	});
	invoke.mockReset();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}

async function render() {
	await act(async () => root.render(<MemorySettingsContent />));
}

function memorySwitch() {
	return container.querySelector<HTMLInputElement>(
		'input[aria-label="Workspace memory"]',
	);
}

describe("Memory settings", () => {
	it("is a settings section", () => {
		expect(SETTINGS_SECTIONS).toContain("Memory");
	});

	it("loads the settings with core's labels and the workspace's notes", async () => {
		invoke.mockImplementation(async (command: string) => {
			if (command === "get_knowledge_vault_settings") return settingsResponse();
			if (command === "list_knowledge_vault_notes") {
				return notesResponse(["a", "b"]);
			}
			throw new Error(`unexpected ${command}`);
		});
		await render();

		expect(memorySwitch()?.checked).toBe(true);
		const writer = container.querySelector<HTMLSelectElement>(
			'select[aria-label="Note writer"]',
		);
		expect(writer?.value).toBe("task");
		expect([...(writer?.options ?? [])].map((item) => item.text)).toEqual([
			"Task model",
			"GoodVision SmartRouter",
		]);
		expect(container.textContent).toContain("Task model description");
		expect(invoke).toHaveBeenCalledWith("list_knowledge_vault_notes", {
			workspacePath: "/work/app",
		});
		expect(container.textContent).toContain(
			"/work/app/.cline/knowledge-vault/notes.jsonl",
		);
		expect(container.textContent).toContain("Task a");
		expect(container.textContent).not.toContain("FILES: a.ts");
	});

	it("toggles optimistically and rolls back when saving fails", async () => {
		const save = deferred<KnowledgeVaultSettingsResponse>();
		invoke.mockImplementation(async (command: string) => {
			if (command === "get_knowledge_vault_settings") return settingsResponse();
			if (command === "set_knowledge_vault_settings") return save.promise;
			return notesResponse([]);
		});
		await render();

		await act(async () => memorySwitch()?.click());
		expect(invoke).toHaveBeenCalledWith("set_knowledge_vault_settings", {
			enabled: false,
		});
		expect(memorySwitch()?.checked).toBe(false);

		await act(async () => save.reject(new Error("disk full")));
		expect(memorySwitch()?.checked).toBe(true);
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			"disk full",
		);
	});

	it("saves a select change and applies the sidecar's answer", async () => {
		invoke.mockImplementation(
			async (command: string, args?: Record<string, unknown>) => {
				if (command === "get_knowledge_vault_settings") {
					return settingsResponse();
				}
				if (command === "set_knowledge_vault_settings") {
					return settingsResponse(args as never);
				}
				return notesResponse([]);
			},
		);
		await render();
		const mode = container.querySelector<HTMLSelectElement>(
			'select[aria-label="Write mode"]',
		);
		await act(async () => {
			if (!mode) return;
			mode.value = "inline";
			mode.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(invoke).toHaveBeenCalledWith("set_knowledge_vault_settings", {
			writeMode: "inline",
		});
		expect(mode?.value).toBe("inline");
		expect(container.textContent).toContain("In-session description");
	});

	it("deletes one note and clears all after confirmation", async () => {
		invoke.mockImplementation(
			async (command: string, args?: Record<string, unknown>) => {
				if (command === "get_knowledge_vault_settings") {
					return settingsResponse();
				}
				if (command === "list_knowledge_vault_notes") {
					return notesResponse(["a", "b"]);
				}
				if (command === "delete_knowledge_vault_note") {
					return notesResponse(["a", "b"].filter((id) => id !== args?.id));
				}
				if (command === "clear_knowledge_vault_notes") return notesResponse([]);
				throw new Error(`unexpected ${command}`);
			},
		);
		await render();

		const expand = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Task a"),
		);
		await act(async () => expand?.click());
		expect(container.textContent).toContain("FILES: a.ts");

		await act(async () =>
			container
				.querySelector<HTMLButtonElement>(
					'[aria-label^="Delete note"][aria-label$="Task b"]',
				)
				?.click(),
		);
		expect(invoke).toHaveBeenCalledWith("delete_knowledge_vault_note", {
			workspacePath: "/work/app",
			id: "b",
		});
		expect(container.textContent).not.toContain("Task b");

		const clearAll = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "Clear all",
		);
		await act(async () => clearAll?.click());
		expect(invoke).not.toHaveBeenCalledWith(
			"clear_knowledge_vault_notes",
			expect.anything(),
		);
		const confirm = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "Delete 1 note",
		);
		await act(async () => confirm?.click());
		expect(invoke).toHaveBeenCalledWith("clear_knowledge_vault_notes", {
			workspacePath: "/work/app",
		});
		expect(container.textContent).toContain("No notes yet for this workspace.");
	});

	it("lists another known workspace's notes", async () => {
		invoke.mockImplementation(
			async (command: string, args?: Record<string, unknown>) => {
				if (command === "get_knowledge_vault_settings") {
					return settingsResponse();
				}
				return {
					...notesResponse([]),
					workspaceRoot: String(args?.workspacePath),
				};
			},
		);
		await render();
		const picker = container.querySelector<HTMLSelectElement>(
			'select[aria-label="Workspace"]',
		);
		await act(async () => {
			if (!picker) return;
			picker.value = "/work/lib";
			picker.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(invoke).toHaveBeenLastCalledWith("list_knowledge_vault_notes", {
			workspacePath: "/work/lib",
		});
	});
});
