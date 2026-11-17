import type { AgentEvent } from "@cline/core";
import { describe, expect, it } from "vitest";
import { knowledgeVaultEventToNotice } from "../../utils/knowledge-vault";
import {
	formatServedModelStatusText,
	resolveStatusNoticeEntry,
} from "./status-notice-entry";

describe("resolveStatusNoticeEntry", () => {
	it("styles provider notices as warnings", () => {
		for (const kind of [
			"responses_unavailable",
			"reasoning_disabled_for_tools",
			"reasoning_replay_dropped",
		]) {
			expect(
				resolveStatusNoticeEntry({
					type: "notice",
					noticeType: "status",
					displayRole: "status",
					message: `notice ${kind}`,
					metadata: { kind, modelId: "m", endpointHost: "h" },
				} as AgentEvent),
			).toEqual({ kind: "status", text: `notice ${kind}`, tone: "warning" });
		}
	});

	it("keeps other status notices plain", () => {
		expect(
			resolveStatusNoticeEntry({
				type: "notice",
				noticeType: "status",
				displayRole: "status",
				message: "plugin issue",
			} as AgentEvent),
		).toEqual({ kind: "status", text: "plugin issue" });
	});

	it("turns Knowledge Vault reports into memory entries keyed by write ts", () => {
		expect(
			resolveStatusNoticeEntry(
				knowledgeVaultEventToNotice({
					ts: 1,
					kind: "recall",
					status: "completed",
					count: 4,
				}) as AgentEvent,
			),
		).toEqual({
			kind: "status",
			text: "Memory: recalled 4 notes",
			tone: "memory",
		});
		expect(
			resolveStatusNoticeEntry(
				knowledgeVaultEventToNotice({
					ts: 7,
					kind: "write",
					status: "running",
				}) as AgentEvent,
			),
		).toEqual({
			kind: "status",
			text: "Memory: saving note…",
			tone: "memory",
			memoryTs: 7,
		});
		expect(
			resolveStatusNoticeEntry(
				knowledgeVaultEventToNotice({
					ts: 7,
					kind: "write",
					status: "failed",
					body: "no GoodVision provider",
				}) as AgentEvent,
			),
		).toEqual({
			kind: "status",
			text: "Memory: note failed: no GoodVision provider",
			tone: "warning",
			memoryTs: 7,
		});
	});

	it("formats the served model status", () => {
		expect(formatServedModelStatusText("gpt-5.4-mini")).toBe(
			"Answered by gpt-5.4-mini",
		);
	});
});
