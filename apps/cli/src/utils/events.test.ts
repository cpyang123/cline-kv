import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentEvent, TeamEvent } from "@cline/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createServedModelTracker,
	handleEvent,
	handleKnowledgeVaultEvent,
	handleTeamEvent,
	resetServedModelAnnouncements,
	resolveStatusNoticeLabel,
} from "./events";
import { knowledgeVaultEventToNotice } from "./knowledge-vault";
import { setCurrentOutputMode } from "./output";
import type { Config } from "./types";

describe("resolveStatusNoticeLabel", () => {
	it("maps compaction status reasons to stable labels", () => {
		expect(
			resolveStatusNoticeLabel({
				type: "notice",
				noticeType: "status",
				displayRole: "status",
				message: "auto-compacting",
				reason: "auto_compaction",
			} as AgentEvent),
		).toBe("auto-compacting");
		expect(
			resolveStatusNoticeLabel({
				type: "notice",
				noticeType: "status",
				displayRole: "status",
				message: "manual",
				reason: "manual_compaction",
			} as AgentEvent),
		).toBe("compacting");
		expect(
			resolveStatusNoticeLabel({
				type: "notice",
				noticeType: "status",
				displayRole: "status",
				message: "compaction-budget-adjusted",
				reason: "compaction_budget_emergency",
			} as AgentEvent),
		).toBe("context budget adjusted");
	});
});

describe("handleEvent text formatting", () => {
	let output = "";
	let errorOutput = "";

	beforeEach(() => {
		output = "";
		errorOutput = "";
		setCurrentOutputMode("text");
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			output += String(chunk);
			return true;
		});
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			errorOutput += String(chunk);
			return true;
		});
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errorOutput += `${args.map(String).join(" ")}\n`;
		});
	});

	it("adds a ⎿ before text that follows a tool block", () => {
		handleEvent(
			{
				type: "content_start",
				contentType: "tool",
				toolName: "read_files",
				input: { path: "/tmp/demo.txt" },
			} as unknown as AgentEvent,
			{} as Config,
		);
		handleEvent(
			{
				type: "content_end",
				contentType: "tool",
				toolName: "read_files",
				output: "ok",
			} as unknown as AgentEvent,
			{} as Config,
		);
		handleEvent(
			{
				type: "content_start",
				contentType: "text",
				text: "Now let me check this file.",
			} as unknown as AgentEvent,
			{} as Config,
		);

		expect(output).toContain(
			`\x1b[36m[read_files]\x1b[0m {"path":"/tmp/demo.txt"}`,
		);
		expect(output).toMatch(/⎿.*ok/s);
	});

	it("prints adjacent tool starts on separate lines", () => {
		handleEvent(
			{
				type: "content_start",
				contentType: "tool",
				toolName: "run_commands",
				input: { commands: ["echo one"] },
			} as unknown as AgentEvent,
			{} as Config,
		);
		handleEvent(
			{
				type: "content_start",
				contentType: "tool",
				toolName: "read_files",
				input: { file_paths: ["/tmp/demo.txt"] },
			} as unknown as AgentEvent,
			{} as Config,
		);

		expect(output).toMatch(/\[run_commands\].*\n.*\[read_files\]/s);
	});

	it("saves generated images and prints an openable path", () => {
		handleEvent(
			{
				type: "content_end",
				contentType: "media",
				media: {
					id: "generated-1",
					modality: "image",
					mediaType: "image/png",
					source: {
						type: "base64",
						data: Buffer.from("one-shot-image").toString("base64"),
					},
				},
			} as AgentEvent,
			{} as Config,
		);

		expect(output).toContain("[generated image]");
		const suffix = "/generated.png";
		const pathEnd = output.indexOf(suffix);
		const pathStart = output.lastIndexOf(" ", pathEnd);
		const path =
			pathEnd >= 0 && pathStart >= 0
				? output.slice(pathStart + 1, pathEnd + suffix.length)
				: undefined;
		expect(path).toBeDefined();
		if (!path) throw new Error("Expected generated image path in CLI output");
		try {
			expect(readFileSync(path, "utf8")).toBe("one-shot-image");
		} finally {
			rmSync(dirname(path), { recursive: true, force: true });
		}
	});

	it("does not echo ask_question through the generic tool renderer", () => {
		handleEvent(
			{
				type: "content_start",
				contentType: "tool",
				toolName: "ask_question",
				input: {
					question: "How can I best assist you today?",
					options: [
						"Help me understand or analyze code in a repository",
						"Help me create or edit files",
					],
				},
			} as unknown as AgentEvent,
			{} as Config,
		);
		handleEvent(
			{
				type: "content_end",
				contentType: "tool",
				toolName: "ask_question",
				output: "Help me create or edit files",
			} as unknown as AgentEvent,
			{} as Config,
		);

		expect(output).toBe("");
	});

	it("prints tool errors inline", () => {
		handleEvent(
			{
				type: "content_start",
				contentType: "tool",
				toolName: "team_task",
				input: { action: "create", title: "Draft haiku" },
			} as unknown as AgentEvent,
			{} as Config,
		);
		handleEvent(
			{
				type: "content_end",
				contentType: "tool",
				toolName: "team_task",
				error:
					'✖ Field "status" is not allowed when action=create\n  → at status',
			} as unknown as AgentEvent,
			{} as Config,
		);

		expect(output).toContain(`\x1b[36m[team_task]\x1b[0m create`);
		expect(output).toContain("error:");
		expect(output).toContain(
			'Field "status" is not allowed when action=create',
		);
		expect(output).toContain("→ at status");
	});

	it("prints completed done events as finished in verbose mode", () => {
		handleEvent(
			{
				type: "done",
				reason: "completed",
				iterations: 5,
				text: "ok",
			} as unknown as AgentEvent,
			{ verbose: true } as Config,
		);

		expect(output).toContain("── finished (5 iterations) ──");
		expect(output).not.toContain("── aborted (5 iterations) ──");
	});

	it("prints aborted done events as aborted in verbose mode", () => {
		handleEvent(
			{
				type: "done",
				reason: "aborted",
				iterations: 2,
				text: "aborted",
			} as unknown as AgentEvent,
			{ verbose: true } as Config,
		);

		expect(output).toContain("── aborted (2 iterations) ──");
	});

	it("formats ClinePass limit agent errors before writing to stderr", () => {
		handleEvent(
			{
				type: "error",
				error: new Error(
					"Error: You have reached your 5-hour Clinepass limit. The limit resets in 5h, please try again later.",
				),
				recoverable: false,
			} as unknown as AgentEvent,
			{} as Config,
		);

		expect(errorOutput).toContain("ClinePass limit reached");
		expect(errorOutput).toContain("Switch to Cline usage-based billing");
		expect(errorOutput).toContain("--provider cline");
	});

	it("formats daily free model limit agent errors before writing to stderr", () => {
		handleEvent(
			{
				type: "error",
				error: new Error(
					"Error: Error 429: Daily free limit reached on model deepseek/deepseek-v4-flash. Try again in 23h 59m",
				),
				recoverable: false,
			} as unknown as AgentEvent,
			{} as Config,
		);

		expect(errorOutput).toContain("Daily free model limit reached");
		expect(errorOutput).toContain("select another model");
		expect(errorOutput).not.toContain("usage-based billing");
	});

	it("formats removed free model errors using the configured model id", () => {
		handleEvent(
			{
				type: "error",
				error: new Error("Error 404: model not found"),
				recoverable: false,
			} as unknown as AgentEvent,
			{ modelId: "cline-free/retired-model" } as Config,
		);

		expect(errorOutput).toContain("Free model promotion ended");
		expect(errorOutput).toContain("Select another model");
	});

	it("suppresses heartbeat-only team progress messages", () => {
		handleTeamEvent({
			type: "run_progress",
			run: {
				id: "run_00001",
				agentId: "worker-1",
			},
			message: "heartbeat",
		} as unknown as TeamEvent);

		expect(output).toBe("");
	});

	it("marks queued and started team runs as active", () => {
		handleTeamEvent({
			type: "run_queued",
			run: {
				id: "run_00001",
				agentId: "worker-1",
			},
		} as unknown as TeamEvent);
		handleTeamEvent({
			type: "run_started",
			run: {
				id: "run_00001",
				agentId: "worker-1",
			},
		} as unknown as TeamEvent);

		expect(output).toContain("queued");
		expect(output).toContain("started");
		expect(output).toContain("...");
		// Consecutive team events should not have blank lines between them
		expect(output).not.toMatch(/\n\n/);
	});

	it("closes inline reasoning before team events and terminates the line", () => {
		handleEvent(
			{
				type: "content_start",
				contentType: "reasoning",
				reasoning: "Investigating",
			} as unknown as AgentEvent,
			{} as Config,
		);
		handleTeamEvent({
			type: "run_started",
			run: {
				id: "run_00001",
				agentId: "worker-1",
			},
		} as unknown as TeamEvent);

		expect(output).toMatch(/Investigating.*\n.*\[team run\].*started.*\n$/s);
	});
});

describe("provider notices, memory and served model", () => {
	let output = "";
	const stripAnsi = (text: string) =>
		// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
		text.replace(/\x1b\[[0-9;]*m/g, "");

	beforeEach(() => {
		output = "";
		setCurrentOutputMode("text");
		resetServedModelAnnouncements();
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			output += String(chunk);
			return true;
		});
	});

	it("prints provider notices as warnings and other notices as status", () => {
		handleEvent(
			{
				type: "notice",
				noticeType: "status",
				displayRole: "status",
				message: "The endpoint has no Responses API; using Chat Completions.",
				metadata: { kind: "responses_unavailable", modelId: "m" },
			} as AgentEvent,
			{} as Config,
		);
		handleEvent(
			{
				type: "notice",
				noticeType: "status",
				displayRole: "status",
				message: "plugin warning",
			} as AgentEvent,
			{} as Config,
		);
		const plain = stripAnsi(output);
		expect(plain).toContain(
			"[warning] The endpoint has no Responses API; using Chat Completions.",
		);
		expect(plain).toContain("[status] plugin warning");
		expect(plain).not.toContain("[status] The endpoint");
	});

	it("prints memory events as [memory] lines and JSON objects", () => {
		handleKnowledgeVaultEvent({
			ts: 1,
			kind: "recall",
			status: "completed",
			count: 2,
		});
		handleKnowledgeVaultEvent({ ts: 2, kind: "write", status: "running" });
		handleKnowledgeVaultEvent({ ts: 2, kind: "write", status: "completed" });
		handleKnowledgeVaultEvent({
			ts: 3,
			kind: "write",
			status: "failed",
			body: "401 Unauthorized",
		});
		expect(stripAnsi(output).split("\n").filter(Boolean)).toEqual([
			"[memory] recalled 2 notes",
			"[memory] saving note…",
			"[memory] note saved",
			"[memory] note failed: 401 Unauthorized",
		]);

		output = "";
		setCurrentOutputMode("json");
		handleKnowledgeVaultEvent({ ts: 4, kind: "write", status: "completed" });
		expect(JSON.parse(output.trim())).toMatchObject({
			type: "knowledge_vault",
			event: { ts: 4, kind: "write", status: "completed" },
		});
		setCurrentOutputMode("text");
	});

	it("routes vault notices from the event stream to the memory line", () => {
		handleEvent(
			knowledgeVaultEventToNotice({
				ts: 1,
				kind: "recall",
				status: "completed",
				count: 1,
			}) as AgentEvent,
			{} as Config,
		);
		expect(stripAnsi(output)).toContain("[memory] recalled 1 note");
		expect(stripAnsi(output)).not.toContain("[status]");
	});

	it("announces the served model once per change", () => {
		const usage = (responseModelId?: string) =>
			({
				type: "usage",
				inputTokens: 1,
				outputTokens: 1,
				totalInputTokens: 1,
				totalOutputTokens: 1,
				responseModelId,
			}) as AgentEvent;
		const config = { modelId: "auto" } as Config;
		handleEvent(usage("gpt-5.4-mini"), config);
		handleEvent(usage("gpt-5.4-mini"), config);
		handleEvent(usage(undefined), config);
		handleEvent(usage("claude-sonnet-4-5"), config);
		handleEvent(usage("auto"), config);
		expect(stripAnsi(output).split("\n").filter(Boolean)).toEqual([
			"[model] answered by gpt-5.4-mini",
			"[model] answered by claude-sonnet-4-5",
		]);
	});
});

describe("createServedModelTracker", () => {
	it("ignores the requested model and repeats", () => {
		const tracker = createServedModelTracker();
		expect(tracker.next("x", "x")).toBeUndefined();
		expect(tracker.next("y", "x")).toBe("y");
		expect(tracker.next("y", "x")).toBeUndefined();
		expect(tracker.next("z", "x")).toBe("z");
		expect(tracker.next("y", "x")).toBe("y");
	});
});
