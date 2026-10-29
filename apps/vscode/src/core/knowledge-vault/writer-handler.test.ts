import { describe, expect, it } from "vitest"
import { modelRejectsTemperature, writerHandlerOptions } from "./writer-handler"

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

	it("recognises the OpenAI reasoning-era ids the SDK renames max_tokens for", () => {
		for (const id of ["gpt-5", "gpt-5.5", "openai/gpt-6-astra", "o1", "o3", "o4-mini", "GPT-5.2"]) {
			expect(modelRejectsTemperature(id)).toBe(true)
		}
		for (const id of ["gpt-4o", "gpt-4.1", "claude-opus-5", "deepseek-v3", undefined, ""]) {
			expect(modelRejectsTemperature(id)).toBe(false)
		}
	})
})
