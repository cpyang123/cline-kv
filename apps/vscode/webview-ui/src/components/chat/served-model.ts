/**
 * Whether to label a request with the model that actually served it.
 *
 * Providers report the concrete model in each response: a dated id for a
 * pinned model (`gpt-4o-2024-08-06` for `gpt-4o`), or the router's choice when
 * the request named `auto` (GoodVision's SmartRouter answers `auto` with e.g.
 * `gpt-5.2-2025-12-11`). The label is shown for `auto` and whenever the served
 * id is not a dated variant of the selected one, so a routed answer is visible
 * per response without labelling every ordinary request.
 */
export function shouldShowServedModel(servedModel: string | undefined, selectedModelId: string | undefined): boolean {
	const served = servedModel?.trim()
	if (!served) {
		return false
	}
	const selected = selectedModelId?.trim()
	if (!selected || selected.toLowerCase() === "auto") {
		return true
	}
	const normalize = (id: string) => id.toLowerCase().split("/").pop() ?? id.toLowerCase()
	return !normalize(served).startsWith(normalize(selected))
}
