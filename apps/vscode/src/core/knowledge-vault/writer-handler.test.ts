import { describe, expect, it } from "vitest"
import { writerHandlerOptions } from "./writer-handler"

describe("writerHandlerOptions", () => {
	it("pins temperature 0 and 900 output tokens for the task model, without extended thinking", () => {
		expect(writerHandlerOptions("task", "claude-sonnet-4-5")).toEqual({
			disableReasoning: true,
			maxOutputTokens: 900,
			temperature: 0,
		})
		expect(writerHandlerOptions("task", "qwen3-27b")).toMatchObject({ temperature: 0 })
	})

	it("omits the temperature for models that reject it and for the GoodVision gateway", () => {
		expect(writerHandlerOptions("task", "gpt-5.4-mini")).toEqual({ disableReasoning: true, maxOutputTokens: 900 })
		expect(writerHandlerOptions("task", "o3-mini")).not.toHaveProperty("temperature")
		expect(writerHandlerOptions("goodvision", "claude-sonnet-5")).toEqual({ disableReasoning: true, maxOutputTokens: 900 })
		expect(writerHandlerOptions("goodvision", "auto")).not.toHaveProperty("temperature")
	})

	it("omits the temperature when the task itself runs on GoodVision or on a router's auto alias", () => {
		// The actor doubles as the writer: the request still goes through the router,
		// whose `auto` route refuses a pinned temperature with 502s.
		expect(writerHandlerOptions("task", "auto", "goodvision")).toEqual({ disableReasoning: true, maxOutputTokens: 900 })
		expect(writerHandlerOptions("task", "claude-opus-5", "goodvision")).not.toHaveProperty("temperature")
		expect(writerHandlerOptions("task", "auto", "openrouter")).not.toHaveProperty("temperature")
		expect(writerHandlerOptions("task", "claude-sonnet-4-5", "anthropic")).toMatchObject({ temperature: 0 })
	})
})
