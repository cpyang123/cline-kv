import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { ProviderNoticeRow } from "./ProviderNoticeRow"

describe("ProviderNoticeRow", () => {
	it("shows the provider warning text under a warning header", () => {
		const text =
			"example.openai.azure.com doesn't support the Responses API for gpt-6-luna, so Cline is using Chat Completions instead."
		render(<ProviderNoticeRow message={{ ts: 1, type: "say", say: "provider_notice", text }} />)

		const row = screen.getByRole("status")
		expect(row).toHaveTextContent("Warning")
		expect(row).toHaveTextContent(text)
		expect(row.className).toContain("bg-warning")
	})
})
