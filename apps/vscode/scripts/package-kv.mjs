#!/usr/bin/env node

/**
 * Package this fork as the "Cline KV" extension (`<publisher>.cline-kv`), a
 * separate extension id from marketplace Cline (`saoudrizwan.claude-dev`), so
 * the VSIX installs side by side and a marketplace auto-update of Cline never
 * replaces it.
 *
 * Mirrors scripts/publish-nightly.mjs without the publish step: package.json
 * is rewritten (name, display name, command prefix) for the duration of
 * `vsce package` and restored afterwards, so the repository's own package.json
 * is untouched.
 *
 * Usage (after `bun run build:production`):
 *   node scripts/package-kv.mjs              # dist/cline-kv-<version>.vsix
 *   KV_VSIX_DIR=/some/dir node scripts/package-kv.mjs
 *   KV_EXTENSION_NAME=claude-dev node scripts/package-kv.mjs   # keep Cline's own id (replaces Cline)
 */

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { restore as restoreMarketplaceReadme, swapIn as swapInMarketplaceReadme } from "./marketplace-readme.mjs"

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const packageJsonPath = path.join(projectRoot, "package.json")
const originalName = "claude-dev"
const name = process.env.KV_EXTENSION_NAME || "cline-kv"
const displayName = process.env.KV_EXTENSION_DISPLAY_NAME || "Cline KV"
const outDir = process.env.KV_VSIX_DIR || path.join(projectRoot, "dist")

const originalPackageJson = fs.readFileSync(packageJsonPath, "utf8")
const version = JSON.parse(originalPackageJson).version
const vsixPath = path.join(outDir, `${name}-${version}.vsix`)
const nodeModules = path.join(projectRoot, "node_modules")
const originalLink = path.join(nodeModules, originalName)
const renamedLink = path.join(nodeModules, name)

function isWorkspaceSelfLink(linkPath) {
	try {
		if (!fs.lstatSync(linkPath).isSymbolicLink()) return false
		return path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath)) === path.resolve(projectRoot)
	} catch {
		return false
	}
}

let didRename = false
let didRenameLink = false
let didSwapReadme = false
try {
	if (name !== originalName) {
		// Same rewrite as the nightly build: package name, command ids ("cline." prefix),
		// display name and activity bar title. src/registry.ts derives the command
		// prefix from the package name at build time, so the bundle matches.
		const rewritten = originalPackageJson.replaceAll(originalName, name).replaceAll('"cline.', `"${name}.`)
		const pkg = JSON.parse(rewritten)
		pkg.name = name
		pkg.displayName = displayName
		// `activitybar` is an array of view containers; retitle each so the
		// activity bar tooltip distinguishes this build from marketplace Cline.
		const activitybar = pkg.contributes?.viewsContainers?.activitybar
		if (Array.isArray(activitybar)) {
			for (const container of activitybar) container.title = displayName
		}
		fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, "\t"))
		didRename = true
		// Keep bun's workspace self-link consistent with the temporary package name
		// so vsce's dependency check does not report a missing/extraneous package.
		if (isWorkspaceSelfLink(originalLink) && !fs.existsSync(renamedLink)) {
			fs.renameSync(originalLink, renamedLink)
			didRenameLink = true
		}
	}
	didSwapReadme = Boolean(swapInMarketplaceReadme())
	fs.mkdirSync(outDir, { recursive: true })
	execFileSync(
		"vsce",
		[
			"package",
			"--no-dependencies",
			"--no-update-package-json",
			"--no-git-tag-version",
			"--allow-package-secrets",
			"sendgrid",
			"--out",
			vsixPath,
		],
		{ stdio: "inherit", cwd: projectRoot, env: { ...process.env, PATH: `${path.join(nodeModules, ".bin")}${path.delimiter}${process.env.PATH ?? ""}` } },
	)
	console.log(`\nPackaged ${displayName} (${name} ${version}) -> ${vsixPath}`)
} finally {
	if (didSwapReadme) restoreMarketplaceReadme()
	if (didRenameLink) fs.renameSync(renamedLink, originalLink)
	if (didRename) fs.writeFileSync(packageJsonPath, originalPackageJson)
}
