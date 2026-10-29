import type { AgentHooks } from "@cline/shared"

type BeforeRun = NonNullable<AgentHooks["beforeRun"]>
type AfterRun = NonNullable<AgentHooks["afterRun"]>
type BeforeModel = NonNullable<AgentHooks["beforeModel"]>
type AfterModel = NonNullable<AgentHooks["afterModel"]>
type BeforeTool = NonNullable<AgentHooks["beforeTool"]>
type AfterTool = NonNullable<AgentHooks["afterTool"]>
type OnEvent = NonNullable<AgentHooks["onEvent"]>

function joinContext(...parts: Array<string | undefined>): string | undefined {
	const kept = parts.filter((part): part is string => Boolean(part?.trim()))
	return kept.length > 0 ? kept.join("\n\n") : undefined
}

function defined<T>(hooks: Array<T | undefined>): T[] {
	return hooks.filter((hook): hook is T => Boolean(hook))
}

/**
 * Run several hook bags as one. The runtime config carries a single `hooks`
 * object, so independent features (file-based hook scripts, the Knowledge
 * Vault) are merged here: run hooks run in order and their context blocks are
 * concatenated; the first hook that stops a run or a tool wins; model hooks see
 * the previous hook's overrides. A callback only one bag defines is passed
 * through unchanged.
 */
export function composeAgentHooks(...bags: Array<AgentHooks | undefined>): AgentHooks {
	const present = defined(bags)
	if (present.length === 0) {
		return {}
	}
	if (present.length === 1) {
		return present[0]
	}

	const composed: AgentHooks = {}

	const beforeRuns = defined(present.map((bag) => bag.beforeRun))
	if (beforeRuns.length === 1) {
		composed.beforeRun = beforeRuns[0]
	} else if (beforeRuns.length > 1) {
		const run: BeforeRun = async (ctx) => {
			const contexts: Array<string | undefined> = []
			for (const hook of beforeRuns) {
				const result = await hook(ctx)
				if (result?.stop) {
					return result
				}
				contexts.push(result?.appendContext)
			}
			const appendContext = joinContext(...contexts)
			return appendContext ? { appendContext } : undefined
		}
		composed.beforeRun = run
	}

	const afterRuns = defined(present.map((bag) => bag.afterRun))
	if (afterRuns.length === 1) {
		composed.afterRun = afterRuns[0]
	} else if (afterRuns.length > 1) {
		const run: AfterRun = async (ctx) => {
			for (const hook of afterRuns) {
				await hook(ctx)
			}
		}
		composed.afterRun = run
	}

	const beforeModels = defined(present.map((bag) => bag.beforeModel))
	if (beforeModels.length === 1) {
		composed.beforeModel = beforeModels[0]
	} else if (beforeModels.length > 1) {
		const run: BeforeModel = async (ctx) => {
			let merged: Awaited<ReturnType<BeforeModel>> | undefined
			let current = ctx
			for (const hook of beforeModels) {
				const result = await hook(current)
				if (!result) {
					continue
				}
				if (result.stop) {
					return { ...merged, ...result }
				}
				merged = { ...merged, ...result }
				current = {
					...current,
					...(result.messages ? { messages: result.messages } : {}),
					...(result.tools ? { tools: result.tools } : {}),
				}
			}
			return merged
		}
		composed.beforeModel = run
	}

	const afterModels = defined(present.map((bag) => bag.afterModel))
	if (afterModels.length === 1) {
		composed.afterModel = afterModels[0]
	} else if (afterModels.length > 1) {
		const run: AfterModel = async (ctx) => {
			for (const hook of afterModels) {
				const result = await hook(ctx)
				if (result?.stop) {
					return result
				}
			}
			return undefined
		}
		composed.afterModel = run
	}

	const beforeTools = defined(present.map((bag) => bag.beforeTool))
	if (beforeTools.length === 1) {
		composed.beforeTool = beforeTools[0]
	} else if (beforeTools.length > 1) {
		const run: BeforeTool = async (ctx) => {
			let merged: Awaited<ReturnType<BeforeTool>> | undefined
			let current = ctx
			for (const hook of beforeTools) {
				const result = await hook(current)
				if (!result) {
					continue
				}
				const appendContext = joinContext(merged?.appendContext, result.appendContext)
				merged = { ...merged, ...result, ...(appendContext ? { appendContext } : {}) }
				if (result.stop || result.skip) {
					return merged
				}
				if (result.input !== undefined) {
					current = { ...current, input: result.input }
				}
			}
			return merged
		}
		composed.beforeTool = run
	}

	const afterTools = defined(present.map((bag) => bag.afterTool))
	if (afterTools.length === 1) {
		composed.afterTool = afterTools[0]
	} else if (afterTools.length > 1) {
		const run: AfterTool = async (ctx) => {
			let merged: Awaited<ReturnType<AfterTool>> | undefined
			let current = ctx
			for (const hook of afterTools) {
				const result = await hook(current)
				if (!result) {
					continue
				}
				const appendContext = joinContext(merged?.appendContext, result.appendContext)
				merged = { ...merged, ...result, ...(appendContext ? { appendContext } : {}) }
				if (result.stop) {
					return merged
				}
				if (result.result !== undefined) {
					current = { ...current, result: result.result }
				}
			}
			return merged
		}
		composed.afterTool = run
	}

	const onEvents = defined(present.map((bag) => bag.onEvent))
	if (onEvents.length === 1) {
		composed.onEvent = onEvents[0]
	} else if (onEvents.length > 1) {
		const run: OnEvent = async (event) => {
			for (const hook of onEvents) {
				await hook(event)
			}
		}
		composed.onEvent = run
	}

	return composed
}
