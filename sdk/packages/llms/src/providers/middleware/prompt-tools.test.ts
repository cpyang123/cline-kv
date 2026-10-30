import type {
	LanguageModelV4CallOptions,
	LanguageModelV4FunctionTool,
	LanguageModelV4Message,
	LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
	buildPromptToolsSection,
	createPromptToolsStream,
	guessToolName,
	MALFORMED_TOOL_NAME,
	parseToolCallBlock,
	promptToolsMiddleware,
	renderToolResult,
	rewritePromptForPromptTools,
	TOOL_CALL_CLOSE,
	TOOL_CALL_OPEN,
	ToolCallTextParser,
	transformParamsForPromptTools,
} from "./prompt-tools";

const readFile: LanguageModelV4FunctionTool = {
	type: "function",
	name: "read_file",
	description: "Read a file from the workspace.",
	inputSchema: {
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
	},
};
const runCommands: LanguageModelV4FunctionTool = {
	type: "function",
	name: "run_commands",
	inputSchema: { type: "object", properties: { command: { type: "string" } } },
};

const finish = (
	unified: "stop" | "length" = "stop",
): LanguageModelV4StreamPart => ({
	type: "finish",
	finishReason: { unified, raw: unified },
	usage: {
		inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 1, text: 1, reasoning: 0 },
		raw: undefined,
	} as never,
});

function streamOf(
	parts: LanguageModelV4StreamPart[],
): ReadableStream<LanguageModelV4StreamPart> {
	return new ReadableStream({
		start(controller) {
			for (const part of parts) controller.enqueue(part);
			controller.close();
		},
	});
}

async function collect(
	stream: ReadableStream<LanguageModelV4StreamPart>,
): Promise<LanguageModelV4StreamPart[]> {
	const out: LanguageModelV4StreamPart[] = [];
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return out;
		out.push(value);
	}
}

function textDeltas(parts: LanguageModelV4StreamPart[]): string {
	return parts
		.filter(
			(p): p is Extract<LanguageModelV4StreamPart, { type: "text-delta" }> =>
				p.type === "text-delta",
		)
		.map((p) => p.delta)
		.join("");
}

describe("buildPromptToolsSection", () => {
	it("describes every tool with its schema and the calling convention", () => {
		const section = buildPromptToolsSection([readFile, runCommands]);
		expect(section).toContain("## read_file");
		expect(section).toContain("Read a file from the workspace.");
		expect(section).toContain('"required":["path"]');
		expect(section).toContain("## run_commands");
		expect(section).toContain(TOOL_CALL_OPEN);
		expect(section).not.toContain("MUST call");
	});

	it("adds the obligation for required and named tool choices", () => {
		expect(buildPromptToolsSection([readFile], { type: "required" })).toContain(
			"MUST call at least one tool",
		);
		expect(
			buildPromptToolsSection([readFile], {
				type: "tool",
				toolName: "read_file",
			}),
		).toContain('MUST call the tool "read_file"');
	});
});

describe("rewritePromptForPromptTools", () => {
	const prompt: LanguageModelV4Message[] = [
		{ role: "system", content: "You are Cline." },
		{ role: "user", content: [{ type: "text", text: "Read a.ts" }] },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "Reading it." },
				{
					type: "tool-call",
					toolCallId: "call_1",
					toolName: "read_file",
					input: { path: "a.ts" },
				},
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "call_1",
					toolName: "read_file",
					output: { type: "text", value: "const a = 1" },
				},
			],
		},
	];

	it("appends the tool section to the system prompt and rewrites calls and results as text", () => {
		const out = rewritePromptForPromptTools(prompt, [readFile]);
		expect(out).toHaveLength(4);
		expect(out[0]).toMatchObject({ role: "system" });
		expect((out[0] as { content: string }).content).toMatch(
			/^You are Cline\.\n\n# Tools/,
		);
		expect(out[2]).toEqual({
			role: "assistant",
			content: [
				{ type: "text", text: "Reading it." },
				{
					type: "text",
					text: `${TOOL_CALL_OPEN}\n{"id": "call_1", "name": "read_file", "arguments": {"path":"a.ts"}}\n${TOOL_CALL_CLOSE}`,
				},
			],
		});
		expect(out[3]).toEqual({
			role: "user",
			content: [
				{
					type: "text",
					text: '<tool_result name="read_file" id="call_1">\nconst a = 1\n</tool_result>',
				},
			],
		});
	});

	it("inserts a system message when the prompt has none and keeps media from tool results as file parts", () => {
		const out = rewritePromptForPromptTools(
			[
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: "c",
							toolName: "browser",
							output: {
								type: "content",
								value: [
									{ type: "text", text: "screenshot taken" },
									{ type: "file", mediaType: "image/png", data: "AAAA" },
								],
							},
						},
					],
				},
			],
			[readFile],
		);
		expect(out[0]).toMatchObject({ role: "system" });
		expect(out[1]).toMatchObject({
			role: "user",
			content: [
				{ type: "text", text: expect.stringContaining("screenshot taken") },
				{ type: "file", mediaType: "image/png", data: "AAAA" },
			],
		});
	});

	it("marks error results", () => {
		const { text } = renderToolResult({
			type: "tool-result",
			toolCallId: "c",
			toolName: "t",
			output: { type: "error-text", value: "boom" },
		});
		expect(text).toBe(
			'<tool_result name="t" id="c" error="true">\nboom\n</tool_result>',
		);
	});
});

describe("transformParamsForPromptTools", () => {
	it("removes tools and toolChoice from the request and rewrites the prompt", () => {
		const params: LanguageModelV4CallOptions = {
			prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			tools: [readFile],
			toolChoice: { type: "auto" },
			temperature: 0,
		};
		const out = transformParamsForPromptTools(params);
		expect(out.tools).toBeUndefined();
		expect(out.toolChoice).toBeUndefined();
		expect(out.temperature).toBe(0);
		expect(out.prompt[0]).toMatchObject({ role: "system" });
	});

	it("passes a request without tools through, still rewriting leftover tool history", () => {
		const plain: LanguageModelV4CallOptions = {
			prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
		};
		expect(transformParamsForPromptTools(plain).prompt).toEqual(plain.prompt);
		const withHistory: LanguageModelV4CallOptions = {
			prompt: [
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: "c",
							toolName: "t",
							output: { type: "text", value: "x" },
						},
					],
				},
			],
			toolChoice: { type: "none" },
			tools: [readFile],
		};
		const out = transformParamsForPromptTools(withHistory);
		expect(out.tools).toBeUndefined();
		expect(out.prompt).toEqual([
			{
				role: "user",
				content: [
					{
						type: "text",
						text: '<tool_result name="t" id="c">\nx\n</tool_result>',
					},
				],
			},
		]);
	});
});

describe("parseToolCallBlock", () => {
	it("accepts the documented form, fenced JSON, and string-encoded arguments", () => {
		expect(
			parseToolCallBlock(
				'{"name": "read_file", "arguments": {"path": "a.ts"}}',
			),
		).toEqual({ name: "read_file", input: { path: "a.ts" } });
		expect(
			parseToolCallBlock('```json\n{"name":"t","input":{"a":1}}\n```'),
		).toEqual({ name: "t", input: { a: 1 } });
		expect(
			parseToolCallBlock('{"name":"t","arguments":"{\\"a\\":1}"}'),
		).toEqual({ name: "t", input: { a: 1 } });
		expect(parseToolCallBlock('{"name":"t"}')).toEqual({
			name: "t",
			input: {},
		});
	});

	it("tolerates a stray closing brace, trailing fences, and a label before the object", () => {
		// Seen live from GoodVision's auto route: one `}` too many after the arguments.
		expect(
			parseToolCallBlock(
				'{"name":"search_codebase","arguments":{"queries":["const restaurants\\\\s*=","cuisine:\\\\s*\\"([^\\"]+)\\""]}}}',
			),
		).toEqual({
			name: "search_codebase",
			input: {
				queries: ['const restaurants\\s*=', 'cuisine:\\s*"([^"]+)"'],
			},
		});
		expect(parseToolCallBlock('{"name":"t","arguments":{"a":1}} }\n')).toEqual(
			{ name: "t", input: { a: 1 } },
		);
		expect(parseToolCallBlock('json\n{"name":"t","arguments":{}}')).toEqual({
			name: "t",
			input: {},
		});
		expect(parseToolCallBlock('{"name":"t","arguments":{"s":"}}"}}}')).toEqual(
			{ name: "t", input: { s: "}}" } },
		);
	});

	it("rejects malformed blocks, including a truncated object and text after the object", () => {
		expect(parseToolCallBlock("not json")).toBeUndefined();
		expect(parseToolCallBlock('{"arguments": {}}')).toBeUndefined();
		expect(parseToolCallBlock("[1,2]")).toBeUndefined();
		// Never complete a cut-off object: the call would run with partial arguments.
		expect(
			parseToolCallBlock('{"name":"write_to_file","arguments":{"content":"abc'),
		).toBeUndefined();
		expect(
			parseToolCallBlock('{"name":"t","arguments":{}} and then more'),
		).toBeUndefined();
	});
});

describe("guessToolName", () => {
	it("reads the tool name out of a block that is otherwise unreadable", () => {
		expect(guessToolName('{"name":"run_commands","arguments":{"commands":[')).toBe(
			"run_commands",
		);
		expect(guessToolName('{"tool": "read_file", oops')).toBe("read_file");
		expect(guessToolName("garbage")).toBeUndefined();
	});
});

describe("ToolCallTextParser", () => {
	it("releases plain text immediately and holds back only a possible tag prefix", () => {
		const parser = new ToolCallTextParser();
		expect(parser.feed("Hello wor")).toEqual([
			{ type: "text", text: "Hello wor" },
		]);
		expect(parser.feed("ld <tool")).toEqual([{ type: "text", text: "ld " }]);
		expect(parser.feed("box>")).toEqual([{ type: "text", text: "<toolbox>" }]);
		expect(parser.flush()).toEqual([]);
	});

	it("parses a block split across deltas and text on both sides", () => {
		const parser = new ToolCallTextParser();
		const events = [
			...parser.feed("I'll read it.\n<tool_ca"),
			...parser.feed('ll>{"name": "read_file", "argu'),
			...parser.feed('ments": {"path": "a.ts"}}</tool_call>\nDone'),
			...parser.flush(),
		];
		expect(events).toEqual([
			{ type: "text", text: "I'll read it.\n" },
			{ type: "call", call: { name: "read_file", input: { path: "a.ts" } } },
			{ type: "text", text: "\nDone" },
		]);
	});

	it("handles several blocks, an unparseable block, and an unclosed block at the end", () => {
		const parser = new ToolCallTextParser();
		const events = [
			...parser.feed(
				'<tool_call>{"name":"a","arguments":{}}</tool_call><tool_call>garbage</tool_call>',
			),
			...parser.feed('<tool_call>{"name":"b","arguments":{"x":1}}'),
			...parser.flush(),
		];
		expect(events).toEqual([
			{ type: "call", call: { name: "a", input: {} } },
			{ type: "invalid", text: "<tool_call>garbage</tool_call>", body: "garbage" },
			{ type: "call", call: { name: "b", input: { x: 1 } } },
		]);
	});

	it("names the tool of a malformed block when it can", () => {
		const parser = new ToolCallTextParser();
		const body = '{"name":"run_commands","arguments":{"commands":[';
		expect([
			...parser.feed(`<tool_call>${body}</tool_call>`),
			...parser.flush(),
		]).toEqual([
			{
				type: "invalid",
				text: `<tool_call>${body}</tool_call>`,
				body,
				name: "run_commands",
			},
		]);
	});
});

describe("createPromptToolsStream", () => {
	it("turns tool_call text into native tool-call parts and finishes with tool-calls", async () => {
		const parts = await collect(
			createPromptToolsStream(
				streamOf([
					{ type: "stream-start", warnings: [] },
					{ type: "text-start", id: "t1" },
					{ type: "text-delta", id: "t1", delta: "Let me look.\n<tool_call>" },
					{
						type: "text-delta",
						id: "t1",
						delta: '{"name": "read_file", "arguments": {"path": "a.ts"}}',
					},
					{ type: "text-delta", id: "t1", delta: "</tool_call>" },
					{ type: "text-end", id: "t1" },
					finish("stop"),
				]),
			),
		);
		const types = parts.map((p) => p.type);
		expect(types).toEqual([
			"stream-start",
			"text-start",
			"text-delta",
			"text-end",
			"tool-input-start",
			"tool-input-delta",
			"tool-input-end",
			"tool-call",
			"finish",
		]);
		expect(textDeltas(parts)).toBe("Let me look.\n");
		const call = parts.find(
			(p): p is Extract<LanguageModelV4StreamPart, { type: "tool-call" }> =>
				p.type === "tool-call",
		);
		expect(call).toMatchObject({
			toolName: "read_file",
			input: '{"path":"a.ts"}',
		});
		expect(call?.toolCallId).toMatch(/^call_/);
		const finishPart = parts.at(-1) as Extract<
			LanguageModelV4StreamPart,
			{ type: "finish" }
		>;
		expect(finishPart.finishReason.unified).toBe("tool-calls");
	});

	it("streams plain text unchanged and keeps the original finish reason", async () => {
		const parts = await collect(
			createPromptToolsStream(
				streamOf([
					{ type: "text-start", id: "t1" },
					{ type: "text-delta", id: "t1", delta: "Just an answer." },
					{ type: "text-end", id: "t1" },
					finish("stop"),
				]),
			),
		);
		expect(parts.map((p) => p.type)).toEqual([
			"text-start",
			"text-delta",
			"text-end",
			"finish",
		]);
		expect(textDeltas(parts)).toBe("Just an answer.");
		expect(
			(parts.at(-1) as Extract<LanguageModelV4StreamPart, { type: "finish" }>)
				.finishReason.unified,
		).toBe("stop");
	});

	it("turns a malformed block into a call with the raw body, so the runtime reports a parse error", async () => {
		const body = '{"name":"run_commands","arguments":{"commands":[';
		const parts = await collect(
			createPromptToolsStream(
				streamOf([
					{ type: "text-start", id: "t1" },
					{
						type: "text-delta",
						id: "t1",
						delta: `Plan first.\n<tool_call>${body}</tool_call><tool_call>garbage</tool_call>`,
					},
					{ type: "text-end", id: "t1" },
					finish("stop"),
				]),
			),
		);
		const calls = parts.filter(
			(p): p is Extract<LanguageModelV4StreamPart, { type: "tool-call" }> =>
				p.type === "tool-call",
		);
		expect(calls.map((c) => [c.toolName, c.input])).toEqual([
			["run_commands", body],
			[MALFORMED_TOOL_NAME, "garbage"],
		]);
		expect(textDeltas(parts)).toBe("Plan first.\n");
		expect(
			(parts.at(-1) as Extract<LanguageModelV4StreamPart, { type: "finish" }>)
				.finishReason.unified,
		).toBe("tool-calls");
	});

	it("emits two calls from one turn and reopens text between them", async () => {
		const parts = await collect(
			createPromptToolsStream(
				streamOf([
					{ type: "text-start", id: "t1" },
					{
						type: "text-delta",
						id: "t1",
						delta:
							'<tool_call>{"name":"a","arguments":{}}</tool_call> and <tool_call>{"name":"b","arguments":{}}</tool_call>',
					},
					{ type: "text-end", id: "t1" },
					finish("stop"),
				]),
			),
		);
		expect(
			parts
				.filter((p) => p.type === "tool-call")
				.map((p) => (p as { toolName: string }).toolName),
		).toEqual(["a", "b"]);
		expect(textDeltas(parts)).toBe(" and ");
		const textStarts = parts.filter((p) => p.type === "text-start");
		expect(textStarts).toHaveLength(1);
	});
});

describe("promptToolsMiddleware", () => {
	it("only parses streams of requests whose tools it moved into the prompt", async () => {
		const model = {
			specificationVersion: "v4",
			provider: "test",
			modelId: "m",
			supportedUrls: {},
		} as never;
		const params: LanguageModelV4CallOptions = {
			prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			tools: [readFile],
		};
		const transformed = await promptToolsMiddleware.transformParams!({
			type: "stream",
			params,
			model,
		});
		const source = () =>
			Promise.resolve({
				stream: streamOf([
					{ type: "text-start", id: "t" },
					{
						type: "text-delta",
						id: "t",
						delta:
							'<tool_call>{"name":"read_file","arguments":{"path":"x"}}</tool_call>',
					},
					{ type: "text-end", id: "t" },
					finish(),
				]),
			});
		const wrapped = await promptToolsMiddleware.wrapStream!({
			doStream: source,
			doGenerate: () => Promise.reject(new Error("n/a")),
			params: transformed,
			model,
		});
		expect(
			(await collect(wrapped.stream)).some((p) => p.type === "tool-call"),
		).toBe(true);

		const untouched = await promptToolsMiddleware.wrapStream!({
			doStream: source,
			doGenerate: () => Promise.reject(new Error("n/a")),
			params: { prompt: [] },
			model,
		});
		expect(
			(await collect(untouched.stream)).some((p) => p.type === "tool-call"),
		).toBe(false);
	});
});
