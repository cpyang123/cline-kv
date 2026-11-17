import * as core from "@cline/core"
import * as shared from "@shared/knowledge-vault"
import { describe, expect, it } from "vitest"
import { knowledgeVaultEventToMessage } from "./adapter"

describe("knowledgeVaultEventToMessage", () => {
	it("renders a core event as a knowledge_vault say message keyed by its ts", () => {
		expect(
			knowledgeVaultEventToMessage({
				ts: 42,
				kind: "write",
				status: "failed",
				reason: "separate_mode",
				body: "no valid note",
				provider: undefined,
				model: "m",
			}),
		).toEqual({
			ts: 42,
			type: "say",
			say: "knowledge_vault",
			text: JSON.stringify({ kind: "write", status: "failed", reason: "separate_mode", body: "no valid note", model: "m" }),
			partial: false,
		})
	})
})

describe("@shared/knowledge-vault", () => {
	// The webview cannot import @cline/core, so the shared module keeps its own
	// copy of the settings enums and defaults; they must match the core module.
	it("matches the core Knowledge Vault settings enums, defaults and paths", () => {
		expect(shared.KNOWLEDGE_VAULT_TEMPLATES).toEqual(core.KNOWLEDGE_VAULT_TEMPLATES)
		expect(shared.KNOWLEDGE_VAULT_WRITERS).toEqual(core.KNOWLEDGE_VAULT_WRITERS)
		expect(shared.KNOWLEDGE_VAULT_WRITE_MODES).toEqual(core.KNOWLEDGE_VAULT_WRITE_MODES)
		expect(shared.DEFAULT_KNOWLEDGE_VAULT_ENABLED).toBe(core.DEFAULT_KNOWLEDGE_VAULT_ENABLED)
		expect(shared.DEFAULT_KNOWLEDGE_VAULT_TEMPLATE).toBe(core.DEFAULT_KNOWLEDGE_VAULT_TEMPLATE)
		expect(shared.DEFAULT_KNOWLEDGE_VAULT_WRITER).toBe(core.DEFAULT_KNOWLEDGE_VAULT_WRITER)
		expect(shared.DEFAULT_KNOWLEDGE_VAULT_WRITE_MODE).toBe(core.DEFAULT_KNOWLEDGE_VAULT_WRITE_MODE)
		expect(shared.KNOWLEDGE_VAULT_RELATIVE_PATH).toBe(core.KNOWLEDGE_VAULT_RELATIVE_PATH)
		expect(shared.KNOWLEDGE_VAULT_TEMPLATE_LABELS).toEqual(core.KNOWLEDGE_VAULT_TEMPLATE_LABELS)
		expect(shared.KNOWLEDGE_VAULT_WRITE_MODE_LABELS).toEqual(core.KNOWLEDGE_VAULT_WRITE_MODE_LABELS)
		expect(Object.keys(shared.KNOWLEDGE_VAULT_WRITER_LABELS)).toEqual(Object.keys(core.KNOWLEDGE_VAULT_WRITER_LABELS))
	})
})
