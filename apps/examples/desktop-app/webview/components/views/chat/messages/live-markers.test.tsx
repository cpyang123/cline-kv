// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/lib/chat-schema";
import { ChatMessages } from "../chat-messages";

CSSStyleSheet.prototype.replaceSync ??= function replaceSync() {} as never;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	HTMLElement.prototype.scrollTo = vi.fn() as never;
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.restoreAllMocks();
});

async function renderMessages(messages: ChatMessage[]) {
	await act(async () => {
		root.render(
			<ChatMessages
				chatTransportState="connected"
				error={null}
				messages={messages}
				onAnswerAskQuestion={vi.fn()}
				onApproveToolApproval={vi.fn()}
				onRejectToolApproval={vi.fn()}
				onForkSession={vi.fn()}
				pendingAskQuestions={[]}
				pendingToolApprovals={[]}
				sessionId="session-1"
				status="completed"
			/>,
		);
	});
}

const prompt: ChatMessage = {
	id: "user-1",
	sessionId: "session-1",
	role: "user",
	content: "Add a retry",
	createdAt: 1_000,
};

function memoryRow(
	id: string,
	marker: NonNullable<NonNullable<ChatMessage["meta"]>["knowledgeVault"]>,
	content: string,
	createdAt = 2_000,
): ChatMessage {
	return {
		id,
		sessionId: "session-1",
		role: "status",
		content,
		createdAt,
		meta: { messageKind: "knowledge_vault", knowledgeVault: marker },
	};
}

describe("memory rows", () => {
	it("shows a recall row that expands to the recalled notes", async () => {
		await renderMessages([
			prompt,
			memoryRow(
				"memory-1",
				{
					ts: 1,
					kind: "recall",
					status: "completed",
					count: 2,
					body: "[2026-01-02 Fix login]\nFILES: src/login.ts",
				},
				"Recalled 2 notes from memory",
			),
		]);
		const row = container.querySelector('[data-kind="knowledge_vault"]');
		expect(row?.getAttribute("data-role")).toBe("status");
		expect(row?.textContent).toContain("Recalled 2 notes from memory");
		expect(row?.textContent).not.toContain("FILES: src/login.ts");

		const toggle = row?.querySelector("button");
		expect(toggle?.getAttribute("aria-expanded")).toBe("false");
		await act(async () => toggle?.click());
		expect(toggle?.getAttribute("aria-expanded")).toBe("true");
		expect(row?.querySelector("pre")?.textContent).toContain(
			"FILES: src/login.ts",
		);
	});

	it("renders saving, saved and failed write states", async () => {
		await renderMessages([
			prompt,
			memoryRow(
				"memory-running",
				{ ts: 2, kind: "write", status: "running" },
				"Saving note to memory…",
			),
		]);
		const running = container.querySelector('[data-memory-status="running"]');
		expect(running?.textContent).toContain("Saving note to memory…");
		expect(running?.querySelector(".animate-spin")).not.toBeNull();
		// Nothing to expand while the note is being written.
		expect(running?.querySelector("button")).toBeNull();

		await renderMessages([
			prompt,
			memoryRow(
				"memory-running",
				{
					ts: 2,
					kind: "write",
					status: "completed",
					body: "DID: added retry",
					model: "gpt-5.4-mini",
				},
				"Note saved to memory",
			),
		]);
		const saved = container.querySelector('[data-memory-status="completed"]');
		expect(saved?.textContent).toContain("Note saved to memory");
		expect(saved?.textContent).toContain("gpt-5.4-mini");

		await renderMessages([
			prompt,
			memoryRow(
				"memory-failed",
				{ ts: 3, kind: "write", status: "failed", body: "no credentials" },
				"Note failed: no credentials",
			),
		]);
		const failed = container.querySelector('[data-memory-status="failed"]');
		expect(failed?.textContent).toContain("Note failed: no credentials");
		expect(failed?.querySelector("button")).toBeNull();
		expect(failed?.firstElementChild?.className).toContain("text-destructive");
	});
});

describe("provider notice rows", () => {
	it("renders provider notices as warnings", async () => {
		await renderMessages([
			prompt,
			{
				id: "notice-1",
				sessionId: "session-1",
				role: "status",
				content:
					"llm.example doesn't support the Responses API for gpt-x, so Cline is using Chat Completions instead.",
				createdAt: 2_000,
				meta: {
					messageKind: "provider_notice",
					noticeKind: "responses_unavailable",
				},
			},
		]);
		const row = container.querySelector('[data-kind="provider_notice"]');
		expect(row?.querySelector("output")?.className).toContain("amber");
		expect(row?.querySelector(".lucide-triangle-alert")).not.toBeNull();
		expect(row?.textContent).toContain("Cline is using Chat Completions");
	});
});

describe("served model label", () => {
	const answer = (meta: ChatMessage["meta"]): ChatMessage => ({
		id: "assistant-1",
		sessionId: "session-1",
		role: "assistant",
		content: "Added the retry.",
		createdAt: 3_000,
		meta,
	});

	it("names the model a router answered with", async () => {
		await renderMessages([
			prompt,
			answer({ modelId: "auto", responseModelId: "gpt-5.4-mini" }),
		]);
		expect(container.querySelector("[data-served-model]")?.textContent).toBe(
			"answered by gpt-5.4-mini",
		);
	});

	it("stays quiet when the served model is the selected one", async () => {
		for (const meta of [
			{
				modelId: "anthropic/claude-sonnet-4.6",
				responseModelId: "claude-sonnet-4.6",
			},
			{ modelId: "gpt-4o", responseModelId: "gpt-4o-2024-08-06" },
			{ modelId: "gpt-4o" },
		]) {
			await renderMessages([prompt, answer(meta)]);
			expect(container.querySelector("[data-served-model]")).toBeNull();
		}
	});
});
