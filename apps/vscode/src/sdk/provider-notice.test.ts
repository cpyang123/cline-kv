import { beforeEach, describe, expect, it, vi } from "vitest"

const hostMocks = vi.hoisted(() => ({ showMessage: vi.fn(async () => ({})) }))

vi.mock("@/hosts/host-provider", () => ({
	HostProvider: {
		get window() {
			return { showMessage: hostMocks.showMessage }
		},
	},
}))

import { parseProviderNotice, resetProviderNoticeToastsForTests, showProviderNoticeToastOnce } from "./provider-notice"

describe("provider notices", () => {
	beforeEach(() => {
		hostMocks.showMessage.mockReset()
		hostMocks.showMessage.mockResolvedValue({})
		resetProviderNoticeToastsForTests()
	})

	it("recognizes only the SDK's provider notice kinds", () => {
		expect(parseProviderNotice("fell back", { kind: "responses_unavailable", modelId: "gpt-6-luna" })).toEqual({
			kind: "responses_unavailable",
			message: "fell back",
			modelId: "gpt-6-luna",
		})
		expect(parseProviderNotice("fell back", { kind: "auto_compaction" })).toBeUndefined()
		expect(parseProviderNotice("fell back", undefined)).toBeUndefined()
		// Without copy there is nothing to warn with.
		expect(parseProviderNotice("", { kind: "reasoning_replay_dropped" })).toBeUndefined()
	})

	it("survives a host that cannot show the toast", async () => {
		hostMocks.showMessage.mockRejectedValueOnce(new Error("no window"))

		expect(() => showProviderNoticeToastOnce({ kind: "reasoning_replay_dropped", message: "dropped" })).not.toThrow()
		await Promise.resolve()
		expect(hostMocks.showMessage).toHaveBeenCalledTimes(1)
	})
})
