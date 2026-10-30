import { describe, expect, it } from "vitest"
import { shouldShowServedModel } from "./served-model"

describe("shouldShowServedModel", () => {
	it("labels routed answers and anything served under a different id", () => {
		expect(shouldShowServedModel("gpt-5.2-2025-12-11", "auto")).toBe(true)
		expect(shouldShowServedModel("claude-opus-5", "AUTO")).toBe(true)
		expect(shouldShowServedModel("gpt-5.2-2025-12-11", "gpt-5.4-mini")).toBe(true)
		expect(shouldShowServedModel("gpt-5.2", undefined)).toBe(true)
	})

	it("stays quiet for a dated variant of the selected model and for missing data", () => {
		expect(shouldShowServedModel("gpt-4o-2024-08-06", "gpt-4o")).toBe(false)
		expect(shouldShowServedModel("claude-sonnet-4-5-20250929", "anthropic/claude-sonnet-4-5")).toBe(false)
		expect(shouldShowServedModel(undefined, "auto")).toBe(false)
		expect(shouldShowServedModel("   ", "auto")).toBe(false)
	})
})
