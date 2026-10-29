import { agentMessagesToMessages } from "@cline/core"
import type {
	AgentBeforeModelContext,
	AgentHooks,
	AgentMessage,
	AgentRunLifecycleContext,
	AgentRunResult,
	AgentRunStartResult,
	AgentToolDefinition,
} from "@cline/shared"
import type { ClineMessage } from "@shared/ExtensionMessage"
import type { KnowledgeVaultTemplate, KnowledgeVaultWriteMode, KnowledgeVaultWriter } from "@shared/knowledge-vault"
import { Logger } from "@shared/services/Logger"
import { lastActorPromptTokens, runInlineNoteTurn } from "./inline"
import { buildSessionMaterial, firstUserPrompt, hasAssistantMessage, hasToolCall } from "./material"
import { NOTE_TEMPLATES } from "./note"
import { type KnowledgeVaultNote, type KnowledgeVaultStore, renderVaultBody, wrapMemoryContext } from "./store"
import { distillNote, type NoteWriterHandler } from "./writer"

/** Hook name shown in the chat's hook rows. */
export const KNOWLEDGE_VAULT_HOOK_NAME = "KnowledgeVault"
/** Separator the chat's hook row uses between the status JSON and its output. */
const HOOK_OUTPUT_SEPARATOR = "__HOOK_OUTPUT__"

export type KnowledgeVaultStatus = "running" | "completed" | "failed"

export interface KnowledgeVaultHooksOptions {
	isEnabled: () => boolean
	getTemplate: () => KnowledgeVaultTemplate
	getWriter: () => KnowledgeVaultWriter
	getWriteMode: () => KnowledgeVaultWriteMode
	store: KnowledgeVaultStore
	/** Builds the handler the writer runs on (the task's model, or the GoodVision router). */
	createWriterHandler: () => Promise<NoteWriterHandler>
	emitHookMessage?: (message: ClineMessage) => void
	/** Observer for the detached write (tests, telemetry). */
	onNoteWritten?: (result: { note?: KnowledgeVaultNote; error?: string }) => void
	now?: () => number
}

export interface KnowledgeVaultHooks {
	hooks: AgentHooks
	/** Settles once every detached note write started so far has finished. */
	waitForWrites(): Promise<void>
}

/** What the in-session note turn needs from the actor's last model request. */
interface CapturedRequest {
	systemPrompt: string
	tools: readonly AgentToolDefinition[]
}

export function buildKnowledgeVaultStatusMessage(options: {
	status: KnowledgeVaultStatus
	action: string
	ts: number
	output?: string
}): ClineMessage {
	const metadata = JSON.stringify({
		hookName: KNOWLEDGE_VAULT_HOOK_NAME,
		toolName: options.action,
		status: options.status,
	})
	return {
		ts: options.ts,
		type: "say",
		say: "hook_status",
		text: options.output ? `${metadata}\n${HOOK_OUTPUT_SEPARATOR}\n${options.output}` : metadata,
		partial: false,
	}
}

function sessionIdOf(ctx: AgentRunLifecycleContext): string {
	return ctx.snapshot.conversationId ?? ctx.snapshot.runId ?? ctx.snapshot.agentId
}

function describeModel(handler: NoteWriterHandler): { id?: string; providerId?: string; contextWindow?: number } {
	try {
		const model = handler.getModel()
		return { id: model.id, providerId: model.providerId, contextWindow: model.info?.contextWindow }
	} catch {
		return {}
	}
}

/**
 * The Knowledge Vault as runtime hooks.
 *
 * - `beforeRun` (recall): on the first run of a session, inject the workspace's
 *   notes as a `<memory_context>` block so the task starts from what earlier
 *   sessions established. Follow-up runs of the same session, and sessions
 *   resumed from history, already carry the block.
 * - `beforeModel` (capture): remember the system prompt and tools of the
 *   actor's latest request, so the in-session note turn can replay the same
 *   prefix.
 * - `afterRun` (write): when a run completes and the session used at least one
 *   tool, write one note for the session, replacing its earlier note. In the
 *   v5inline mode the actor writes the note itself as a final turn of its own
 *   conversation; otherwise, or when that turn is skipped or invalid, a
 *   separate writer call distills the transcript. The write is detached: the
 *   runtime awaits `afterRun` before it reports the run as finished, and a
 *   writer call takes seconds.
 */
export function buildKnowledgeVaultHooks(options: KnowledgeVaultHooksOptions): KnowledgeVaultHooks {
	const now = options.now ?? (() => Date.now())
	const pending = new Set<Promise<void>>()
	let captured: CapturedRequest | undefined

	const beforeRun = async (ctx: AgentRunLifecycleContext): Promise<AgentRunStartResult | undefined> => {
		try {
			if (!options.isEnabled()) {
				return undefined
			}
			if (hasAssistantMessage(ctx.snapshot.messages)) {
				return undefined
			}
			const notes = await options.store.list()
			if (notes.length === 0) {
				return undefined
			}
			const body = renderVaultBody(notes)
			options.emitHookMessage?.(
				buildKnowledgeVaultStatusMessage({
					status: "completed",
					action: `recall ${notes.length} note${notes.length === 1 ? "" : "s"}`,
					ts: now(),
					output: body,
				}),
			)
			return { appendContext: wrapMemoryContext(body) }
		} catch (error) {
			Logger.error("[KnowledgeVault] recall failed:", error)
			return undefined
		}
	}

	const beforeModel = async (ctx: AgentBeforeModelContext): Promise<undefined> => {
		captured = { systemPrompt: ctx.request.systemPrompt ?? "", tools: ctx.request.tools }
		return undefined
	}

	const writeNote = async (taskId: string, messages: readonly AgentMessage[]): Promise<void> => {
		const ts = now()
		options.emitHookMessage?.(buildKnowledgeVaultStatusMessage({ status: "running", action: "write note", ts }))
		try {
			const template = NOTE_TEMPLATES[options.getTemplate()] ?? NOTE_TEMPLATES["two-block"]
			const writer = options.getWriter()
			const handler = await options.createWriterHandler()
			const model = describeModel(handler)

			let note = ""
			let mode: KnowledgeVaultNote["mode"] = "separate"
			let reason: string
			// The in-session turn is the actor's own: it needs the task model as the
			// writer, the two-block grammar it was built for, and a captured request.
			const inlineEligible =
				options.getWriteMode() === "inline" && writer === "task" && template.id === "two-block" && captured !== undefined
			if (inlineEligible && captured) {
				const inline = await runInlineNoteTurn({
					handler,
					systemPrompt: captured.systemPrompt,
					conversation: agentMessagesToMessages(messages),
					tools: captured.tools,
					prevPromptTokens: lastActorPromptTokens(messages),
					contextWindow: model.contextWindow,
					noteCap: template.noteCap,
				})
				reason = inline.reason
				if (inline.mode === "inline") {
					note = inline.note
					mode = "inline"
				}
			} else {
				reason =
					options.getWriteMode() !== "inline"
						? "separate_mode"
						: writer !== "task"
							? "writer_not_actor"
							: template.id !== "two-block"
								? "fused_template"
								: "no_request"
			}

			if (!note) {
				const result = await distillNote({ handler, material: buildSessionMaterial(messages), template })
				if (!result.note) {
					const detail = result.error ?? "the writer produced no valid note"
					options.emitHookMessage?.(
						buildKnowledgeVaultStatusMessage({ status: "failed", action: "write note", ts, output: detail }),
					)
					options.onNoteWritten?.({ error: detail })
					return
				}
				note = result.note
				mode = "separate"
			}

			const record: KnowledgeVaultNote = {
				id: `${ts.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
				ts,
				taskId,
				task: firstUserPrompt(messages).slice(0, 200),
				note,
				template: template.id,
				...(model.providerId ? { provider: model.providerId } : {}),
				...(model.id ? { model: model.id } : {}),
				mode,
				reason,
			}
			await options.store.upsert(record)
			options.emitHookMessage?.(
				buildKnowledgeVaultStatusMessage({
					status: "completed",
					action: mode === "inline" ? "write note (in-session)" : `write note (separate: ${reason})`,
					ts,
					output: note,
				}),
			)
			options.onNoteWritten?.({ note: record })
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			options.emitHookMessage?.(
				buildKnowledgeVaultStatusMessage({ status: "failed", action: "write note", ts, output: message }),
			)
			options.onNoteWritten?.({ error: message })
			Logger.error("[KnowledgeVault] write failed:", error)
		}
	}

	const afterRun = async (ctx: AgentRunLifecycleContext & { result: AgentRunResult }): Promise<void> => {
		if (!options.isEnabled() || ctx.result.status !== "completed") {
			return
		}
		const messages = ctx.snapshot.messages
		if (!hasToolCall(messages)) {
			return
		}
		const write = writeNote(sessionIdOf(ctx), messages)
		pending.add(write)
		void write.finally(() => pending.delete(write))
	}

	return {
		hooks: { beforeRun, beforeModel, afterRun },
		async waitForWrites() {
			await Promise.allSettled([...pending])
		},
	}
}
