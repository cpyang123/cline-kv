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
 * Every run gets its own version and file name: `<upstream version>-kv.<n>`,
 * where `<n>` is a counter kept in `<out dir>/.build-number` and advanced only
 * when packaging succeeds. The suffix is valid semver (vsce rejects it only on
 * publish, which this script never does), the Extensions view shows it as the
 * installed version, and `<out dir>/builds.log` records which commit each
 * number was built from. `KV_BUILD_VERSION` overrides the whole version.
 *
 * The packaged file is also copied to the repository's `releases/` folder
 * (replacing any earlier `cline-kv-*.vsix` there), which is committed so the
 * build can be installed from the repository without the marketplace (see the
 * root README). `KV_RELEASE_DIR` points it elsewhere; an empty value skips it.
 *
 * Usage (after `bun run build:production`):
 *   node scripts/package-kv.mjs              # dist/cline-kv-<version>-kv.<n>.vsix
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
const releaseDir =
	process.env.KV_RELEASE_DIR === undefined ? path.join(projectRoot, "..", "..", "releases") : process.env.KV_RELEASE_DIR

const originalPackageJson = fs.readFileSync(packageJsonPath, "utf8")
const baseVersion = JSON.parse(originalPackageJson).version
const buildNumberPath = path.join(outDir, ".build-number")
const buildLogPath = path.join(outDir, "builds.log")

function readBuildNumber() {
	try {
		return Number.parseInt(fs.readFileSync(buildNumberPath, "utf8").trim(), 10) || 0
	} catch {
		return 0
	}
}

function git(...args) {
	try {
		return execFileSync("git", args, { cwd: projectRoot, stdio: ["ignore", "pipe", "ignore"] }).toString().trim()
	} catch {
		return ""
	}
}

const buildNumber = readBuildNumber() + 1
const version = process.env.KV_BUILD_VERSION || `${baseVersion}-kv.${buildNumber}`
const vsixPath = path.join(outDir, `${name}-${version}.vsix`)
// Recorded before the script touches the tree, so "dirty" means the user's own edits.
const commit = git("rev-parse", "--short", "HEAD") || "unknown"
const dirty = git("status", "--porcelain") !== ""
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

let didRewrite = false
let didRenameLink = false
let didSwapReadme = false
try {
	// Same rewrite as the nightly build: package name, command ids ("cline." prefix),
	// display name and activity bar title. src/registry.ts derives the command
	// prefix from the package name at build time, so the bundle matches. The
	// build's version goes in the same way, so the bundle and the manifest agree.
	const rewritten =
		name !== originalName
			? originalPackageJson.replaceAll(originalName, name).replaceAll('"cline.', `"${name}.`)
			: originalPackageJson
	const pkg = JSON.parse(rewritten)
	pkg.name = name
	pkg.version = version
	if (name !== originalName) {
		pkg.displayName = displayName
		// `activitybar` is an array of view containers; retitle each so the
		// activity bar tooltip distinguishes this build from marketplace Cline.
		const activitybar = pkg.contributes?.viewsContainers?.activitybar
		if (Array.isArray(activitybar)) {
			for (const container of activitybar) container.title = displayName
		}
	}
	fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, "\t"))
	didRewrite = true
	// Keep bun's workspace self-link consistent with the temporary package name
	// so vsce's dependency check does not report a missing/extraneous package.
	if (name !== originalName && isWorkspaceSelfLink(originalLink) && !fs.existsSync(renamedLink)) {
		fs.renameSync(originalLink, renamedLink)
		didRenameLink = true
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
	// Only a build that packaged consumes a number.
	fs.writeFileSync(buildNumberPath, `${buildNumber}\n`)
	fs.appendFileSync(buildLogPath, `${new Date().toISOString()} ${version} ${commit}${dirty ? "+dirty" : ""} ${vsixPath}\n`)
	console.log(`\nPackaged ${displayName} (${name} ${version}, commit ${commit}${dirty ? ", dirty tree" : ""}) -> ${vsixPath}`)
	if (releaseDir) {
		// One installable build per repository state: the newest replaces the rest.
		fs.mkdirSync(releaseDir, { recursive: true })
		for (const entry of fs.readdirSync(releaseDir)) {
			if (entry.startsWith(`${name}-`) && entry.endsWith(".vsix")) fs.rmSync(path.join(releaseDir, entry))
		}
		const releasePath = path.join(releaseDir, path.basename(vsixPath))
		fs.copyFileSync(vsixPath, releasePath)
		console.log(`Copied to ${releasePath} (commit it so the build is installable from the repository)`)
	}
} finally {
	if (didSwapReadme) restoreMarketplaceReadme()
	if (didRenameLink) fs.renameSync(renamedLink, originalLink)
	if (didRewrite) fs.writeFileSync(packageJsonPath, originalPackageJson)
}
