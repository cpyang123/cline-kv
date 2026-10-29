import { describe, expect, it, vi } from "vitest";
import { createUpstreamRetryFetch } from "./openai-compatible";

const respond = (status: number) =>
	new Response(
		status === 200 ? "ok" : '{"error":{"code":"upstream_unavailable"}}',
		{ status },
	);

describe("createUpstreamRetryFetch", () => {
	it("retries 502 responses with backoff until one succeeds", async () => {
		const base = vi.fn(async () => respond(502));
		base
			.mockResolvedValueOnce(respond(502))
			.mockResolvedValueOnce(respond(503))
			.mockResolvedValueOnce(respond(200));
		const delays: number[] = [];
		const sleep = vi.fn(async (ms: number) => {
			delays.push(ms);
		});
		const fetchWithRetry = createUpstreamRetryFetch(
			base as never,
			{ attempts: 5, baseDelayMs: 1000, maxDelayMs: 3000 },
			sleep,
		);

		const response = await fetchWithRetry(
			"https://gw.example/v1/chat/completions",
			{ method: "POST", body: "{}" },
		);

		expect(response.status).toBe(200);
		expect(base).toHaveBeenCalledTimes(3);
		expect(delays).toEqual([1000, 2000]);
	});

	it("caps the delay, stops after the configured attempts, and returns the last response", async () => {
		const base = vi.fn(async () => respond(504));
		const delays: number[] = [];
		const fetchWithRetry = createUpstreamRetryFetch(
			base as never,
			{ attempts: 4, baseDelayMs: 1000, maxDelayMs: 2500 },
			async (ms) => {
				delays.push(ms);
			},
		);

		const response = await fetchWithRetry(
			"https://gw.example/v1/chat/completions",
			{ method: "POST", body: "{}" },
		);

		expect(response.status).toBe(504);
		expect(base).toHaveBeenCalledTimes(4);
		expect(delays).toEqual([1000, 2000, 2500]);
	});

	it("does not retry other statuses, non-replayable bodies, or after an abort", async () => {
		const sleep = vi.fn(async () => {});
		const unauthorized = vi.fn(async () => respond(401));
		await createUpstreamRetryFetch(
			unauthorized as never,
			{ attempts: 3, baseDelayMs: 1 },
			sleep,
		)("https://gw.example/x", { body: "{}" });
		expect(unauthorized).toHaveBeenCalledTimes(1);

		const streamBody = vi.fn(async () => respond(502));
		await createUpstreamRetryFetch(
			streamBody as never,
			{ attempts: 3, baseDelayMs: 1 },
			sleep,
		)("https://gw.example/x", {
			body: new Blob(["{}"]) as never,
		});
		expect(streamBody).toHaveBeenCalledTimes(1);

		const controller = new AbortController();
		const aborted = vi.fn(async () => {
			controller.abort();
			return respond(502);
		});
		const response = await createUpstreamRetryFetch(
			aborted as never,
			{ attempts: 3, baseDelayMs: 1 },
			sleep,
		)("https://gw.example/x", {
			body: "{}",
			signal: controller.signal,
		});
		expect(aborted).toHaveBeenCalledTimes(1);
		expect(response.status).toBe(502);
		expect(sleep).not.toHaveBeenCalled();
	});
});
