// LanguageModelV4 middleware that emulates tool calling through the prompt
// for gateways that refuse native tool definitions.
//
// Some routed endpoints (GoodVision's SmartRouter under its default policy)
// answer every request that carries a `tools` field with 422 `no_candidate`,
// while the same request without tools succeeds. Cline's agent loop declares
// its tools on every request, so such a gateway could never run a task. This
// middleware moves tool use into the text channel, the way text-based agents
// (mini-swe-agent, classic Cline's XML tools) have always worked:
//
//   * `transformParams`: the function tools are removed from the request and
//     described in the system prompt together with the calling convention;
//     earlier tool calls and tool results in the conversation are rewritten
//     as text so the model sees a coherent transcript.
//   * `wrapStream`: the model's text is scanned for `<tool_call>{json}</tool_call>`
//     blocks, which are turned into the native `tool-input-*` / `tool-call`
//     stream parts the runtime expects; the surrounding text streams through
//     as ordinary text. A turn that produced calls finishes with reason
//     `tool-calls`.
//
// The runtime, the gateway and the vendor adapter are unchanged: to them the
// provider simply supports tools. Only `type: "function"` tools are emulated;
// provider-defined tools cannot be and are dropped with a warning.

import type {
	LanguageModelV4CallOptions,
	LanguageModelV4FilePart,
	LanguageModelV4FunctionTool,
	LanguageModelV4Message,
	LanguageModelV4Middleware,
	LanguageModelV4StreamPart,
	LanguageModelV4StreamResult,
	LanguageModelV4ToolCallPart,
	LanguageModelV4ToolChoice,
	LanguageModelV4ToolResultPart,
} from "@ai-sdk/provider";
import { nanoid } from "nanoid";

export const TOOL_CALL_OPEN = "<tool_call>";
export const TOOL_CALL_CLOSE = "</tool_call>";

/** A call the model wrote in text, as the stream parser reports it. */
export interface ParsedTextToolCall {
	name: string;
	input: unknown;
}

export type ToolCallTextEvent =
	| { type: "text"; text: string }
	| { type: "call"; call: ParsedTextToolCall }
	/**
	 * A block that could not be parsed even leniently. `text` is the block as
	 * written, `body` its inside, `name` the tool it names if that much is
	 * legible. The stream emits it as a call with the raw body as input, so the
	 * runtime answers with a parse error the model can correct instead of the
	 * turn ending as if it were a final answer.
	 */
	| { type: "invalid"; text: string; body: string; name?: string };

/** The tool name given to a malformed block that names none. */
export const MALFORMED_TOOL_NAME = "malformed_tool_call";

// ---------------------------------------------------------------------------
// Prompt side
// ---------------------------------------------------------------------------

function compactSchema(schema: unknown): string {
	try {
		return JSON.stringify(schema ?? { type: "object" });
	} catch {
		return '{"type":"object"}';
	}
}

/** The system-prompt section that replaces native tool definitions. */
export function buildPromptToolsSection(
	tools: readonly LanguageModelV4FunctionTool[],
	toolChoice?: LanguageModelV4ToolChoice,
): string {
	const lines: string[] = [
		"# Tools",
		"",
		"Native function calling is not available on this connection, so you call tools by writing tool_call blocks in your reply. Each block is a JSON object with the tool's name and its arguments:",
		"",
		TOOL_CALL_OPEN,
		'{"name": "<tool name>", "arguments": {<arguments matching the tool\'s input schema>}}',
		TOOL_CALL_CLOSE,
		"",
		"Rules:",
		'- A reply that needs a tool MUST contain the tool_call block in that same reply. Announcing a call ("I will now read the file") without the block does nothing and ends your turn; write the block.',
		"- Write one block per call, and several blocks to make several calls in one reply. Put the blocks at the end of the reply, after any explanation.",
		'- "arguments" must be a JSON object that matches the tool\'s input schema exactly (required fields present, correct types). Escape newlines and quotes inside JSON strings.',
		"- A block holds exactly one JSON object and nothing else. Check that its braces and brackets balance: a stray closing brace after the object is the most common mistake.",
		"- Only a tool_call block runs a tool. Describing a call in prose does nothing.",
		'- Never write tool results yourself. After your reply, each call\'s result arrives in the next user message as <tool_result name="…" id="…">…</tool_result>; wait for it before continuing.',
		"",
		"Example of a complete reply that reads a file:",
		"",
		"I will check the configuration first.",
		TOOL_CALL_OPEN,
		'{"name": "read_file", "arguments": {"path": "package.json"}}',
		TOOL_CALL_CLOSE,
		"",
		"Available tools:",
		"",
	];
	for (const tool of tools) {
		lines.push(`## ${tool.name}`);
		if (tool.description?.trim()) {
			lines.push(tool.description.trim());
		}
		lines.push(`Input schema: ${compactSchema(tool.inputSchema)}`, "");
	}
	if (toolChoice?.type === "required") {
		lines.push("You MUST call at least one tool in this reply.");
	} else if (toolChoice?.type === "tool") {
		lines.push(
			`You MUST call the tool "${toolChoice.toolName}" in this reply.`,
		);
	}
	return lines.join("\n").trimEnd();
}

function stringifyInput(input: unknown): string {
	if (typeof input === "string") {
		return input;
	}
	try {
		return JSON.stringify(input ?? {});
	} catch {
		return String(input);
	}
}

/** The text form of an earlier tool call, for the rewritten history. */
export function renderToolCall(
	part: Pick<LanguageModelV4ToolCallPart, "toolCallId" | "toolName" | "input">,
): string {
	return `${TOOL_CALL_OPEN}\n{"id": ${JSON.stringify(part.toolCallId)}, "name": ${JSON.stringify(part.toolName)}, "arguments": ${stringifyInput(part.input)}}\n${TOOL_CALL_CLOSE}`;
}

/**
 * The text form of a tool result, for the rewritten history. Media parts of a
 * `content` result are returned separately so the caller can keep them as
 * typed file parts of the user message instead of losing them.
 */
export function renderToolResult(part: LanguageModelV4ToolResultPart): {
	text: string;
	files: LanguageModelV4FilePart[];
} {
	const files: LanguageModelV4FilePart[] = [];
	const output = part.output as {
		type: string;
		value?: unknown;
		reason?: unknown;
	};
	let body: string;
	switch (output.type) {
		case "text":
		case "error-text":
			body = String(output.value ?? "");
			break;
		case "json":
		case "error-json":
			body = stringifyInput(output.value);
			break;
		case "content": {
			const pieces: string[] = [];
			for (const item of (output.value as
				| Array<Record<string, unknown>>
				| undefined) ?? []) {
				if (item.type === "text" && typeof item.text === "string") {
					pieces.push(item.text);
				} else if (
					item.type === "file" &&
					typeof item.mediaType === "string" &&
					item.data !== undefined
				) {
					files.push({
						type: "file",
						mediaType: item.mediaType,
						data: item.data as LanguageModelV4FilePart["data"],
						...(typeof item.filename === "string"
							? { filename: item.filename }
							: {}),
					});
					pieces.push(
						`(attached ${item.mediaType}, see the file in this message)`,
					);
				} else {
					pieces.push(stringifyInput(item));
				}
			}
			body = pieces.join("\n");
			break;
		}
		case "execution-denied":
			body = `Tool execution was denied${output.reason ? `: ${String(output.reason)}` : "."}`;
			break;
		default:
			body = stringifyInput(output);
	}
	const isError = output.type === "error-text" || output.type === "error-json";
	const open = `<tool_result name=${JSON.stringify(part.toolName)} id=${JSON.stringify(part.toolCallId)}${isError ? ' error="true"' : ""}>`;
	return { text: `${open}\n${body}\n</tool_result>`, files };
}

/**
 * Rewrite the conversation for a model that must use tools through text:
 * assistant tool calls become `<tool_call>` text, and tool messages become
 * user messages carrying `<tool_result>` text (plus any media as file parts).
 */
export function rewriteToolHistory(
	prompt: LanguageModelV4Prompt,
): LanguageModelV4Message[] {
	const out: LanguageModelV4Message[] = [];
	for (const message of prompt) {
		if (message.role === "assistant") {
			out.push({
				...message,
				content: message.content.flatMap((part) => {
					if (part.type === "tool-call") {
						return [{ type: "text" as const, text: renderToolCall(part) }];
					}
					if (part.type === "tool-result") {
						return [
							{ type: "text" as const, text: renderToolResult(part).text },
						];
					}
					return [part];
				}),
			});
			continue;
		}
		if (message.role === "tool") {
			const texts: string[] = [];
			const files: LanguageModelV4FilePart[] = [];
			for (const part of message.content) {
				if (part.type === "tool-result") {
					const rendered = renderToolResult(part);
					texts.push(rendered.text);
					files.push(...rendered.files);
				} else if (part.type === "tool-approval-response") {
					texts.push(
						`<tool_approval id=${JSON.stringify(part.approvalId)}>${part.approved ? "approved" : "denied"}${part.reason ? `: ${part.reason}` : ""}</tool_approval>`,
					);
				}
			}
			out.push({
				role: "user",
				content: [{ type: "text", text: texts.join("\n\n") }, ...files],
				...(message.providerOptions
					? { providerOptions: message.providerOptions }
					: {}),
			});
			continue;
		}
		out.push(message);
	}
	return out;
}

/**
 * Rewrite a prompt for a model that must use tools through text: the tool
 * section is added to the system prompt (or becomes one), and the tool
 * history is rewritten as text.
 */
export function rewritePromptForPromptTools(
	prompt: LanguageModelV4Prompt,
	tools: readonly LanguageModelV4FunctionTool[],
	toolChoice?: LanguageModelV4ToolChoice,
): LanguageModelV4Message[] {
	const section = buildPromptToolsSection(tools, toolChoice);
	const out = rewriteToolHistory(prompt);
	const systemIndex = out.findIndex((message) => message.role === "system");
	if (systemIndex === -1) {
		out.unshift({ role: "system", content: section });
		return out;
	}
	const system = out[systemIndex] as Extract<
		LanguageModelV4Message,
		{ role: "system" }
	>;
	out[systemIndex] = {
		...system,
		content: `${system.content}\n\n${section}`,
	};
	return out;
}

type LanguageModelV4Prompt = LanguageModelV4CallOptions["prompt"];

// ---------------------------------------------------------------------------
// Response side
// ---------------------------------------------------------------------------

function stripFences(text: string): string {
	return text
		.trim()
		.replace(/^```[a-zA-Z]*\s*/, "")
		.replace(/\s*```$/, "")
		.trim();
}

/**
 * Scan from the first `{` to its matching `}`, honouring strings, and return
 * the object text with whatever follows it. An object the text never closes
 * (a truncated reply) is not completed: running a call with cut-off arguments
 * is worse than reporting it.
 */
function scanJsonObject(
	text: string,
): { object: string; rest: string } | undefined {
	const start = text.indexOf("{");
	if (start === -1) {
		return undefined;
	}
	const closers: string[] = [];
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
		} else if (char === "{" || char === "[") {
			closers.push(char === "{" ? "}" : "]");
		} else if (char === "}" || char === "]") {
			if (closers.pop() !== char) {
				return undefined;
			}
			if (closers.length === 0) {
				return { object: text.slice(start, index + 1), rest: text.slice(index + 1) };
			}
		}
	}
	return undefined;
}

/** What may follow the object inside a block without making it unreadable: whitespace, stray closers, fences. */
const TRAILING_JUNK = /^[\s}\],;`]*$/;

/**
 * Parse the JSON of a block leniently: strict JSON first, else the first
 * balanced object in the text, provided nothing but stray closing brackets
 * follows it. Models slip in an extra `}` after a nested object often enough
 * that refusing the call would end the turn over a single character.
 */
function parseBlockJson(body: string): unknown {
	const text = stripFences(body);
	try {
		return JSON.parse(text);
	} catch {
		// Fall through to the lenient scan.
	}
	const scanned = scanJsonObject(text);
	if (!scanned || !TRAILING_JUNK.test(scanned.rest)) {
		return undefined;
	}
	try {
		return JSON.parse(scanned.object);
	} catch {
		return undefined;
	}
}

/** The tool a malformed block names, when that much of it is legible. */
export function guessToolName(body: string): string | undefined {
	const match = /"(?:name|tool|function)"\s*:\s*"([^"\\]+)"/.exec(body);
	const name = match?.[1]?.trim();
	return name || undefined;
}

/** Parse the JSON inside one tool_call block; tolerant of fences, stray closers, and `input`/`tool` spellings. */
export function parseToolCallBlock(
	body: string,
): ParsedTextToolCall | undefined {
	const parsed = parseBlockJson(body);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return undefined;
	}
	const record = parsed as Record<string, unknown>;
	const name = record.name ?? record.tool ?? record.function;
	if (typeof name !== "string" || !name.trim()) {
		return undefined;
	}
	let input =
		record.arguments ?? record.input ?? record.parameters ?? record.args ?? {};
	if (typeof input === "string") {
		try {
			input = JSON.parse(input);
		} catch {
			// A plain string argument stays a string; the runtime's schema check reports it.
		}
	}
	return { name: name.trim(), input };
}

function partialTagSuffixLength(buffer: string, tag: string): number {
	const max = Math.min(buffer.length, tag.length - 1);
	for (let length = max; length > 0; length -= 1) {
		if (tag.startsWith(buffer.slice(buffer.length - length))) {
			return length;
		}
	}
	return 0;
}

/**
 * Incremental scanner for `<tool_call>…</tool_call>` blocks in streamed text.
 * Text outside blocks is released as soon as it cannot be the start of a tag;
 * a block is released as a call once its closing tag arrives.
 */
export class ToolCallTextParser {
	private buffer = "";
	private inCall = false;

	feed(delta: string): ToolCallTextEvent[] {
		this.buffer += delta;
		const events: ToolCallTextEvent[] = [];
		for (;;) {
			if (!this.inCall) {
				const start = this.buffer.indexOf(TOOL_CALL_OPEN);
				if (start === -1) {
					const hold = partialTagSuffixLength(this.buffer, TOOL_CALL_OPEN);
					const release = this.buffer.slice(0, this.buffer.length - hold);
					if (release) {
						events.push({ type: "text", text: release });
					}
					this.buffer = this.buffer.slice(this.buffer.length - hold);
					return events;
				}
				const before = this.buffer.slice(0, start);
				if (before) {
					events.push({ type: "text", text: before });
				}
				this.buffer = this.buffer.slice(start + TOOL_CALL_OPEN.length);
				this.inCall = true;
			}
			const end = this.buffer.indexOf(TOOL_CALL_CLOSE);
			if (end === -1) {
				return events;
			}
			const body = this.buffer.slice(0, end);
			this.buffer = this.buffer.slice(end + TOOL_CALL_CLOSE.length);
			this.inCall = false;
			const call = parseToolCallBlock(body);
			events.push(
				call
					? { type: "call", call }
					: {
							type: "invalid",
							text: `${TOOL_CALL_OPEN}${body}${TOOL_CALL_CLOSE}`,
							body,
							...(guessToolName(body) ? { name: guessToolName(body) } : {}),
						},
			);
		}
	}

	/** Whether the text so far opened a tool_call block that has not closed yet. */
	isInsideCall(): boolean {
		return this.inCall;
	}

	/**
	 * Release whatever is pending at the end of the text: an unclosed block is
	 * parsed if it is complete JSON, reported as malformed otherwise, or, with
	 * `unclosedAsText` (the reply was cut off by an output limit), released as
	 * text so the runtime's cut-off recovery applies instead of a parse error.
	 */
	flush(options?: { unclosedAsText?: boolean }): ToolCallTextEvent[] {
		const events: ToolCallTextEvent[] = [];
		if (this.inCall && options?.unclosedAsText) {
			events.push({ type: "text", text: `${TOOL_CALL_OPEN}${this.buffer}` });
		} else if (this.inCall) {
			const call = parseToolCallBlock(this.buffer);
			events.push(
				call
					? { type: "call", call }
					: {
							type: "invalid",
							text: `${TOOL_CALL_OPEN}${this.buffer}`,
							body: this.buffer,
							...(guessToolName(this.buffer)
								? { name: guessToolName(this.buffer) }
								: {}),
						},
			);
		} else if (this.buffer) {
			events.push({ type: "text", text: this.buffer });
		}
		this.buffer = "";
		this.inCall = false;
		return events;
	}
}

/**
 * Turn a text stream that may contain tool_call blocks into a stream with
 * native tool-call parts. Text blocks are closed before a call is emitted and
 * reopened (with a fresh id) if text follows, so every part sequence stays
 * well-formed for `streamText`.
 */
export function createPromptToolsStream(
	source: ReadableStream<LanguageModelV4StreamPart>,
): ReadableStream<LanguageModelV4StreamPart> {
	const parser = new ToolCallTextParser();
	let textOpen: string | undefined;
	let flushed = false;
	let calls = 0;

	const emitEvents = (
		events: ToolCallTextEvent[],
		controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
	) => {
		const emitCall = (toolName: string, input: string) => {
			if (textOpen !== undefined) {
				controller.enqueue({ type: "text-end", id: textOpen });
				textOpen = undefined;
			}
			const id = `call_${nanoid()}`;
			calls += 1;
			controller.enqueue({ type: "tool-input-start", id, toolName });
			controller.enqueue({ type: "tool-input-delta", id, delta: input });
			controller.enqueue({ type: "tool-input-end", id });
			controller.enqueue({ type: "tool-call", toolCallId: id, toolName, input });
		};
		for (const event of events) {
			if (event.type === "call") {
				emitCall(event.call.name, stringifyInput(event.call.input));
				continue;
			}
			if (event.type === "invalid") {
				// The model meant to call a tool. Hand the runtime the block as the
				// call's (unparseable) input: it answers with a parse error the model
				// can fix on its next turn, which beats ending the task here.
				emitCall(event.name ?? MALFORMED_TOOL_NAME, event.body.trim());
				continue;
			}
			if (!event.text) {
				continue;
			}
			if (textOpen === undefined) {
				textOpen = `text_${nanoid()}`;
				controller.enqueue({ type: "text-start", id: textOpen });
			}
			controller.enqueue({
				type: "text-delta",
				id: textOpen,
				delta: event.text,
			});
		}
	};

	return source.pipeThrough(
		new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
			transform(part, controller) {
				switch (part.type) {
					case "text-start":
						// Opened lazily, when the first visible text is released.
						return;
					case "text-delta":
						emitEvents(parser.feed(part.delta), controller);
						return;
					case "text-end":
						// An unclosed block waits for the finish reason: cut off by an
						// output limit it is text to continue, otherwise a malformed call.
						if (parser.isInsideCall()) {
							return;
						}
						emitEvents(parser.flush(), controller);
						flushed = true;
						if (textOpen !== undefined) {
							controller.enqueue({ type: "text-end", id: textOpen });
							textOpen = undefined;
						}
						return;
					case "finish": {
						if (!flushed) {
							emitEvents(
								parser.flush({
									unclosedAsText: part.finishReason.unified === "length",
								}),
								controller,
							);
							flushed = true;
						}
						if (textOpen !== undefined) {
							controller.enqueue({ type: "text-end", id: textOpen });
							textOpen = undefined;
						}
						const finishReason =
							calls > 0 && part.finishReason.unified === "stop"
								? { ...part.finishReason, unified: "tool-calls" as const }
								: part.finishReason;
						controller.enqueue({ ...part, finishReason });
						return;
					}
					default:
						controller.enqueue(part);
				}
			},
			flush(controller) {
				if (!flushed) {
					emitEvents(parser.flush(), controller);
					flushed = true;
				}
				if (textOpen !== undefined) {
					controller.enqueue({ type: "text-end", id: textOpen });
					textOpen = undefined;
				}
			},
		}),
	);
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/** Requests whose tools were moved into the prompt; their streams need parsing. */
const emulatedRequests = new WeakSet<LanguageModelV4CallOptions>();

export function transformParamsForPromptTools(
	params: LanguageModelV4CallOptions,
): LanguageModelV4CallOptions {
	const functionTools = (params.tools ?? []).filter(
		(tool): tool is LanguageModelV4FunctionTool => tool.type === "function",
	);
	const { tools: _tools, toolChoice, ...rest } = params;
	if (functionTools.length === 0 || toolChoice?.type === "none") {
		// Nothing to emulate: still rewrite any tool history to text, since the
		// endpoint cannot receive tool messages either.
		const prompt = params.prompt.some((message) => message.role === "tool")
			? rewriteToolHistory(params.prompt)
			: params.prompt;
		return { ...rest, prompt };
	}
	const transformed: LanguageModelV4CallOptions = {
		...rest,
		prompt: rewritePromptForPromptTools(
			params.prompt,
			functionTools,
			toolChoice,
		),
	};
	emulatedRequests.add(transformed);
	return transformed;
}

export const promptToolsMiddleware: LanguageModelV4Middleware = {
	specificationVersion: "v4",
	async transformParams({ params }) {
		return transformParamsForPromptTools(params);
	},
	async wrapStream({ doStream, params }): Promise<LanguageModelV4StreamResult> {
		const result = await doStream();
		if (!emulatedRequests.has(params)) {
			return result;
		}
		return { ...result, stream: createPromptToolsStream(result.stream) };
	},
};
