import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { formatKnowledgeVaultLabel, KnowledgeVaultRow, parseKnowledgeVaultInfo } from "./KnowledgeVaultRow"

const navigateToKnowledgeVault = vi.fn()
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ navigateToKnowledgeVault }),
}))

describe("KnowledgeVaultRow", () => {
	it("formats labels for recall and write markers", () => {
		expect(formatKnowledgeVaultLabel({ kind: "recall", status: "completed", count: 3 })).toBe("Memory recalled · 3 notes")
		expect(formatKnowledgeVaultLabel({ kind: "recall", status: "completed", count: 1 })).toBe("Memory recalled · 1 note")
		expect(formatKnowledgeVaultLabel({ kind: "write", status: "running" })).toBe("Writing memory note")
		expect(formatKnowledgeVaultLabel({ kind: "write", status: "completed", mode: "inline" })).toBe(
			"Memory note written · in-session",
		)
		expect(formatKnowledgeVaultLabel({ kind: "write", status: "completed", mode: "separate", reason: "no_headroom" })).toBe(
			"Memory note written · separate · no_headroom",
		)
		expect(formatKnowledgeVaultLabel({ kind: "write", status: "failed", reason: "invalid_twice" })).toBe(
			"Memory note not written · invalid_twice",
		)
		expect(parseKnowledgeVaultInfo("not json")).toBeUndefined()
	})

	it("stays a one-line marker until clicked, then shows the note and a link to the Memory view", () => {
		const message = {
			ts: 1,
			type: "say" as const,
			say: "knowledge_vault" as const,
			text: JSON.stringify({
				kind: "write",
				status: "completed",
				mode: "inline",
				body: "FILES: src/a.ts\nDID: x | WHERE: src/a.ts:1",
				model: "m",
			}),
		}
		render(<KnowledgeVaultRow message={message} />)
		expect(screen.getByText("Memory note written · in-session")).toBeTruthy()
		expect(screen.queryByText(/FILES: src\/a.ts/)).toBeNull()

		fireEvent.click(screen.getByRole("button", { expanded: false }))
		// Structured by category: the FILES tag with its path chip, the DID text with its WHERE anchor.
		expect(screen.getByText("FILES")).toBeTruthy()
		expect(screen.getByText("src/a.ts")).toBeTruthy()
		expect(screen.getByText("x")).toBeTruthy()
		expect(screen.getByText("src/a.ts:1")).toBeTruthy()
		// The raw text stays one click away.
		fireEvent.click(screen.getByText("Show raw text"))
		expect(screen.getByText(/FILES: src\/a.ts/)).toBeTruthy()

		fireEvent.click(screen.getByText("Open Memory view"))
		expect(navigateToKnowledgeVault).toHaveBeenCalledTimes(1)
	})

	it("renders a running marker without an expander", () => {
		render(
			<KnowledgeVaultRow
				message={{
					ts: 2,
					type: "say",
					say: "knowledge_vault",
					text: JSON.stringify({ kind: "write", status: "running" }),
				}}
			/>,
		)
		expect(screen.getByText(/Writing memory note/)).toBeTruthy()
		expect(screen.queryByRole("button", { expanded: false })).toBeNull()
	})
})
