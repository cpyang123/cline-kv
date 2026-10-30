#!/usr/bin/env node

/**
 * Publish a packaged Cline KV build as a GitHub Release, with the VSIX as
 * the release asset, so it can be installed from the repository's Releases
 * page without the marketplace and without committing a binary.
 *
 * Usage:
 *   node scripts/release-kv.mjs [path/to/cline-kv-<version>.vsix]
 *
 * Without a path the newest build in `KV_VSIX_DIR` (default: dist/) is used.
 * The release is tagged `v<version>` (for example v4.1.26-kv.4) at the commit
 * the build was made from (`KV_RELEASE_TARGET` overrides; default: HEAD),
 * which must already be pushed. Re-running for the same version replaces the
 * asset on the existing release.
 *
 * Authentication, one of:
 *   - the GitHub CLI (`gh`) logged in: used when present on PATH;
 *   - `GH_TOKEN` / `GITHUB_TOKEN`: a fine-grained token with "Contents:
 *     read and write" on the repository, used through the REST API.
 * The repository comes from `KV_GITHUB_REPO` (owner/name) or the `origin` remote.
 */

import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = path.join(projectRoot, "..", "..")
const outDir = process.env.KV_VSIX_DIR || path.join(projectRoot, "dist")

function git(...args) {
	return execFileSync("git", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] }).toString().trim()
}

function fail(message) {
	console.error(`release-kv: ${message}`)
	process.exit(1)
}

function resolveVsixPath() {
	const given = process.argv[2]
	if (given) {
		if (!fs.existsSync(given)) fail(`no such file: ${given}`)
		return path.resolve(given)
	}
	const candidates = fs
		.readdirSync(outDir)
		.filter((entry) => /^cline-kv-.*\.vsix$/.test(entry))
		.map((entry) => ({ entry, mtime: fs.statSync(path.join(outDir, entry)).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime)
	if (candidates.length === 0) fail(`no cline-kv-*.vsix in ${outDir}; run scripts/package-kv.mjs first`)
	return path.join(outDir, candidates[0].entry)
}

function resolveRepo() {
	const explicit = process.env.KV_GITHUB_REPO
	if (explicit) return explicit
	const url = git("remote", "get-url", "origin")
	const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?\/?$/)
	if (!match) fail(`cannot read owner/repo from origin url "${url}"; set KV_GITHUB_REPO=owner/name`)
	return `${match[1]}/${match[2]}`
}

function buildRecord(version) {
	try {
		const lines = fs.readFileSync(path.join(outDir, "builds.log"), "utf8").trim().split("\n")
		const line = lines.reverse().find((entry) => entry.split(" ")[1] === version)
		if (!line) return undefined
		const [at, , commit] = line.split(" ")
		return { at, commit: commit.replace(/\+dirty$/, ""), dirty: commit.endsWith("+dirty") }
	} catch {
		return undefined
	}
}

const vsixPath = resolveVsixPath()
const fileName = path.basename(vsixPath)
const version = fileName.match(/^cline-kv-(.+)\.vsix$/)?.[1]
if (!version) fail(`unexpected file name ${fileName}; expected cline-kv-<version>.vsix`)
const tag = `v${version}`
const repo = resolveRepo()
const record = buildRecord(version)
const target = process.env.KV_RELEASE_TARGET || git("rev-parse", "HEAD")
if (record?.dirty) {
	console.warn(`release-kv: build ${version} was packaged from a tree with uncommitted changes (commit ${record.commit}+dirty)`)
}

const notes = [
	`Cline KV ${version}: the Cline fork with the Knowledge Vault memory and the GoodVision SmartRouter provider.`,
	"",
	`Built ${record?.at ?? "(time unknown)"} from commit ${record?.commit ?? target.slice(0, 9)}${record?.dirty ? " (with uncommitted changes)" : ""}.`,
	"",
	"**Install**: download the `.vsix` below, then in VS Code open the Extensions view → `···` → **Install from VSIX...**, or run",
	"",
	"```sh",
	`code --install-extension ${fileName} --force`,
	"```",
	"",
	"and reload the window. In a VS Code Server / Remote-SSH window run the command in that remote's integrated terminal with the file on the remote machine. `--force` lets it replace an already installed build. See the README section \"Install from the VSIX\".",
].join("\n")

const title = `Cline KV ${version}`
const size = fs.statSync(vsixPath).size

function hasGh() {
	return spawnSync("gh", ["--version"], { stdio: "ignore" }).status === 0
}

async function releaseWithGh() {
	const notesFile = path.join(os.tmpdir(), `release-kv-${version}.md`)
	fs.writeFileSync(notesFile, notes)
	const exists = spawnSync("gh", ["release", "view", tag, "--repo", repo], { stdio: "ignore" }).status === 0
	const args = exists
		? ["release", "upload", tag, vsixPath, "--repo", repo, "--clobber"]
		: ["release", "create", tag, vsixPath, "--repo", repo, "--target", target, "--title", title, "--notes-file", notesFile]
	const result = spawnSync("gh", args, { stdio: "inherit" })
	fs.rmSync(notesFile, { force: true })
	if (result.status !== 0) fail("gh failed (see above)")
	console.log(`${exists ? "Updated" : "Created"} release ${tag} on ${repo}: https://github.com/${repo}/releases/tag/${tag}`)
}

async function api(token, url, init = {}) {
	const response = await fetch(url, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			...(init.headers ?? {}),
		},
	})
	const text = await response.text()
	let body
	try {
		body = text ? JSON.parse(text) : undefined
	} catch {
		body = text
	}
	return { status: response.status, body }
}

async function releaseWithToken(token) {
	const base = `https://api.github.com/repos/${repo}`
	let release
	const existing = await api(token, `${base}/releases/tags/${tag}`)
	if (existing.status === 200) {
		release = existing.body
		console.log(`Release ${tag} exists; replacing its asset`)
		for (const asset of release.assets ?? []) {
			if (asset.name === fileName) {
				const removed = await api(token, `${base}/releases/assets/${asset.id}`, { method: "DELETE" })
				if (removed.status !== 204) fail(`could not delete the existing asset (${removed.status}): ${JSON.stringify(removed.body)}`)
			}
		}
	} else {
		const created = await api(token, `${base}/releases`, {
			method: "POST",
			body: JSON.stringify({ tag_name: tag, target_commitish: target, name: title, body: notes, draft: false, prerelease: false, make_latest: "true" }),
		})
		if (created.status !== 201) {
			const detail = JSON.stringify(created.body)
			if (created.status === 422 && /target_commitish|not found|Invalid value/i.test(detail)) {
				fail(`GitHub rejected the tag target ${target.slice(0, 9)} (${detail}); push that commit first or set KV_RELEASE_TARGET`)
			}
			fail(`could not create the release (${created.status}): ${detail}`)
		}
		release = created.body
		console.log(`Created release ${tag} at ${target.slice(0, 9)}`)
	}
	const uploadUrl = `${release.upload_url.replace(/\{\?.*\}$/, "")}?name=${encodeURIComponent(fileName)}`
	const uploaded = await api(token, uploadUrl, {
		method: "POST",
		headers: { "Content-Type": "application/octet-stream", "Content-Length": String(size) },
		body: fs.readFileSync(vsixPath),
	})
	if (uploaded.status !== 201) fail(`asset upload failed (${uploaded.status}): ${JSON.stringify(uploaded.body)}`)
	console.log(`Uploaded ${fileName} (${(size / 1024 / 1024).toFixed(1)} MB): ${release.html_url}`)
}

console.log(`Publishing ${fileName} as ${tag} on ${repo} (target ${target.slice(0, 9)})`)
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
if (token) {
	await releaseWithToken(token)
} else if (hasGh()) {
	await releaseWithGh()
} else {
	fail("no GitHub credentials: set GH_TOKEN (a token with Contents: read and write on the repository) or install and log in to the GitHub CLI")
}
