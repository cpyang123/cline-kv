import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import {
	createStreamTimeLimitMiddleware,
	limitStreamTime,
	STREAM_TIME_LIMIT_RAW_REASON,
} from "./stream-time-limit";

const finish: LanguageModelV4StreamPart = {
	type: "finish",
	finishReason: { unified: "stop", raw: "stop" },
	usage: {
		inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 1, text: 1, reasoning: 0 },
		raw: undefined,
	},
};

/** A source whose parts arrive when `release(i)` is called, and that records cancellation. */
function controlledSource(parts: LanguageModelV4StreamPart[]) {
	let controller!: ReadableStreamDefaultController<LanguageModelV4StreamPart>;
	const cancelled = vi.fn();
	const stream = new ReadableStream<LanguageModelV4StreamPart>({
		start(c) {
			controller = c;
		},
		cancel: cancelled,
	});
	return {
		stream,
		cancelled,
		push: (index: number) => controller.enqueue(parts[index]),
		end: () => controller.close(),
	};
}

async function readAll(
	stream: ReadableStream<LanguageModelV4StreamPart>,
): Promise<LanguageModelV4StreamPart[]> {
	const out: LanguageModelV4StreamPart[] = [];
	const reader = stream.getReader();
	for (;;) {
		const { value, done } = await reader.read();
		if (done) return out;
		out.push(value);
	}
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("limitStreamTime", () => {
	it("passes a stream that finishes in time through untouched", async () => {
		const parts: LanguageModelV4StreamPart[] = [
			{ type: "text-start", id: "t" },
			{ type: "text-delta", id: "t", delta: "hello" },
			{ type: "text-end", id: "t" },
			finish,
		];
		const source = new ReadableStream<LanguageModelV4StreamPart>({
			start(c) {
				for (const part of parts) c.enqueue(part);
				c.close();
			},
		});
		const out = await readAll(
			limitStreamTime(source, { limitMs: 10_000, startedAt: Date.now() }),
		);
		expect(out).toEqual(parts);
	});

	it("ends a long stream with a length finish, closing open text and cancelling the source", async () => {
		const parts: LanguageModelV4StreamPart[] = [
			{ type: "text-start", id: "t" },
			{ type: "text-delta", id: "t", delta: "partial " },
			{ type: "text-delta", id: "t", delta: "too late" },
		];
		const source = controlledSource(parts);
		const onCut = vi.fn();
		const limited = limitStreamTime(source.stream, {
			limitMs: 50,
			startedAt: Date.now(),
			onCut,
		});
		const collected = readAll(limited);
		source.push(0);
		source.push(1);
		await wait(120);
		// The source was cancelled at the cut; a late part cannot even be queued.
		expect(() => source.push(2)).toThrow();
		const out = await collected;
		expect(out.map((p) => p.type)).toEqual([
			"text-start",
			"text-delta",
			"text-end",
			"finish",
		]);
		const last = out.at(-1) as Extract<
			LanguageModelV4StreamPart,
			{ type: "finish" }
		>;
		expect(last.finishReason).toEqual({
			unified: "length",
			raw: STREAM_TIME_LIMIT_RAW_REASON,
		});
		expect(onCut).toHaveBeenCalledTimes(1);
		expect(onCut.mock.calls[0][0].limitMs).toBe(50);
		expect(onCut.mock.calls[0][0].elapsedMs).toBeGreaterThanOrEqual(50);
		expect(source.cancelled).toHaveBeenCalled();
	});

	it("drops a half-built tool input at the cut and keeps nothing it cannot run", async () => {
		const parts: LanguageModelV4StreamPart[] = [
			{ type: "text-start", id: "t" },
			{ type: "text-delta", id: "t", delta: "Writing the file." },
			{ type: "text-end", id: "t" },
			{ type: "tool-input-start", id: "c", toolName: "write_to_file" },
			{ type: "tool-input-delta", id: "c", delta: '{"path":"a.ts","content":"' },
		];
		const source = controlledSource(parts);
		const limited = limitStreamTime(source.stream, {
			limitMs: 50,
			startedAt: Date.now(),
		});
		const collected = readAll(limited);
		for (let i = 0; i < parts.length; i += 1) source.push(i);
		await wait(120);
		const out = await collected;
		expect(out.map((p) => p.type)).toEqual([
			"text-start",
			"text-delta",
			"text-end",
			"tool-input-start",
			"tool-input-delta",
			"finish",
		]);
		expect(out.filter((p) => p.type === "tool-call")).toHaveLength(0);
	});

	it("leaves a stream with no content alone past the deadline", async () => {
		const parts: LanguageModelV4StreamPart[] = [
			{ type: "reasoning-start", id: "r" },
			{ type: "reasoning-delta", id: "r", delta: "thinking" },
			{ type: "reasoning-end", id: "r" },
			{ type: "text-start", id: "t" },
			{ type: "text-delta", id: "t", delta: "late answer" },
			{ type: "text-end", id: "t" },
			finish,
		];
		const source = controlledSource(parts);
		const limited = limitStreamTime(source.stream, {
			limitMs: 50,
			startedAt: Date.now(),
		});
		const collected = readAll(limited);
		source.push(0);
		source.push(1);
		source.push(2);
		await wait(120);
		// Nothing to keep at the deadline: the provider's stream continues untouched.
		for (let i = 3; i < parts.length; i += 1) source.push(i);
		source.end();
		const out = await collected;
		expect(out.map((p) => p.type)).toEqual(parts.map((p) => p.type));
		expect(source.cancelled).not.toHaveBeenCalled();
	});

	it("never cuts on the first token itself when the timer lagged behind the clock", async () => {
		let clock = 0;
		const parts: LanguageModelV4StreamPart[] = [
			{ type: "text-start", id: "t" },
			{ type: "text-delta", id: "t", delta: "first" },
			{ type: "text-delta", id: "t", delta: "second" },
			{ type: "text-end", id: "t" },
			finish,
		];
		const source = controlledSource(parts);
		const limited = limitStreamTime(source.stream, {
			limitMs: 1000,
			startedAt: 0,
			now: () => clock,
		});
		const collected = readAll(limited);
		clock = 1500; // past the deadline before any content
		for (let i = 0; i < parts.length; i += 1) source.push(i);
		source.end();
		const out = await collected;
		expect(out.map((p) => p.type)).toEqual(parts.map((p) => p.type));
	});

	it("propagates a source error that happens before the deadline", async () => {
		const source = new ReadableStream<LanguageModelV4StreamPart>({
			start(c) {
				c.enqueue({ type: "text-start", id: "t" });
				c.error(new Error("terminated"));
			},
		});
		await expect(
			readAll(limitStreamTime(source, { limitMs: 10_000, startedAt: Date.now() })),
		).rejects.toThrow("terminated");
	});
});

describe("createStreamTimeLimitMiddleware", () => {
	it("measures from before the request is issued and cuts on the first delta past the deadline", async () => {
		let clock = 0;
		const parts: LanguageModelV4StreamPart[] = [
			{ type: "text-start", id: "t" },
			{ type: "text-delta", id: "t", delta: "a" },
			{ type: "text-delta", id: "t", delta: "b" },
			{ type: "text-end", id: "t" },
			finish,
		];
		const source = controlledSource(parts);
		const middleware = createStreamTimeLimitMiddleware({
			limitMs: 1000,
			now: () => clock,
		});
		const result = await middleware.wrapStream!({
			doStream: async () => {
				clock = 900; // slow time to first byte counts against the limit
				return { stream: source.stream };
			},
			doGenerate: () => Promise.reject(new Error("n/a")),
			params: { prompt: [] },
			model: {} as never,
		});
		const collected = readAll(result.stream);
		source.push(0);
		source.push(1);
		await wait(10);
		clock = 1000;
		source.push(2);
		const out = await collected;
		expect(out.map((p) => p.type)).toEqual([
			"text-start",
			"text-delta",
			"text-end",
			"finish",
		]);
		expect(
			(out.at(-1) as Extract<LanguageModelV4StreamPart, { type: "finish" }>)
				.finishReason.unified,
		).toBe("length");
	});
});
