import type { AgentHooks } from "@cline/shared"
import { describe, expect, it, vi } from "vitest"
import { composeAgentHooks } from "./compose"

const ctx = { snapshot: { messages: [] } } as never

describe("composeAgentHooks", () => {
	it("returns the only bag unchanged and an empty bag for nothing", () => {
		const only: AgentHooks = { beforeRun: vi.fn() }
		expect(composeAgentHooks(undefined, only)).toBe(only)
		expect(composeAgentHooks()).toEqual({})
	})

	it("runs beforeRun hooks in order and concatenates their context", async () => {
		const order: string[] = []
		const a: AgentHooks = {
			beforeRun: async () => {
				order.push("a")
				return { appendContext: "from a" }
			},
		}
		const b: AgentHooks = {
			beforeRun: async () => {
				order.push("b")
				return { appendContext: "from b" }
			},
		}
		const c: AgentHooks = { beforeRun: async () => undefined }

		const composed = composeAgentHooks(a, b, c)
		await expect(composed.beforeRun?.(ctx)).resolves.toEqual({ appendContext: "from a\n\nfrom b" })
		expect(order).toEqual(["a", "b"])
	})

	it("stops at the first hook that stops the run", async () => {
		const second = vi.fn(async () => ({ appendContext: "never" }))
		const composed = composeAgentHooks({ beforeRun: async () => ({ stop: true, reason: "no" }) }, { beforeRun: second })
		await expect(composed.beforeRun?.(ctx)).resolves.toEqual({ stop: true, reason: "no" })
		expect(second).not.toHaveBeenCalled()
	})

	it("runs every afterRun hook and passes through, unchanged, hooks only one bag defines", async () => {
		const first = vi.fn(async () => undefined)
		const second = vi.fn(async () => undefined)
		const onEvent = vi.fn()
		const beforeModel = vi.fn()
		const composed = composeAgentHooks({ afterRun: first, onEvent, beforeModel }, { afterRun: second })
		await composed.afterRun?.(ctx)
		expect(first).toHaveBeenCalledTimes(1)
		expect(second).toHaveBeenCalledTimes(1)
		expect(composed.onEvent).toBe(onEvent)
		expect(composed.beforeModel).toBe(beforeModel)
		expect(composed.beforeTool).toBeUndefined()
	})

	it("chains tool hooks: later hooks see earlier input overrides, contexts merge, stop wins", async () => {
		const seen: unknown[] = []
		const composed = composeAgentHooks(
			{ beforeTool: async () => ({ input: { path: "b" }, appendContext: "one" }) },
			{
				beforeTool: async (toolCtx) => {
					seen.push(toolCtx.input)
					return { appendContext: "two" }
				},
			},
			{ beforeTool: async () => ({ stop: true, reason: "halt" }) },
			{ beforeTool: vi.fn(async () => ({ appendContext: "unreachable" })) },
		)
		const result = await composed.beforeTool?.({ snapshot: {}, tool: {}, toolCall: {}, input: { path: "a" } } as never)
		expect(seen).toEqual([{ path: "b" }])
		expect(result).toEqual({ input: { path: "b" }, appendContext: "one\n\ntwo", stop: true, reason: "halt" })
	})
})
