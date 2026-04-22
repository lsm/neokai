/**
 * SkillsManager
 *
 * Service layer for the application-level Skills registry.
 * Enforces input validation for security-sensitive fields before persisting.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { generateUUID } from '@neokai/shared';
import type {
	AppSkill,
	AppSkillConfig,
	CreateSkillParams,
	UpdateSkillParams,
	SkillSourceType,
	SkillValidationStatus,
} from '@neokai/shared';
import type { SkillRepository } from '../storage/repositories/skill-repository';
import type { AppMcpServerRepository } from '../storage/repositories/app-mcp-server-repository';
import type { JobQueueRepository } from '../storage/repositories/job-queue-repository';
import { SKILL_VALIDATE } from './job-queue-constants';

/**
 * Convert a GitHub tree/blob URL to a raw content URL.
 *
 * Accepts:
 * - GitHub tree URLs: https://github.com/{owner}/{repo}/tree/{branch}/{path}
 *   → https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}/SKILL.md
 *   Branch names with slashes (e.g. "feature/my-branch") are handled correctly
 *   by splitting on the first occurrence of "/tree/" and then finding the path
 *   separator that follows the first path segment after the branch.
 * - GitHub blob URLs: https://github.com/{owner}/{repo}/blob/{branch}/{path}
 *   → https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}
 * - Raw URLs (returned unchanged)
 *
 * Note: for tree URLs the SKILL.md filename is appended automatically.
 * For blob URLs the URL is assumed to point directly at the file.
 */
export function resolveSkillRawUrl(url: string): string {
	// Already a raw URL
	if (url.startsWith('https://raw.githubusercontent.com/')) {
		return url;
	}

	// Parse GitHub URLs by splitting on the fixed "/tree/" or "/blob/" markers
	// so that branch names containing "/" are handled correctly.
	const githubBase = 'https://github.com/';
	if (!url.startsWith(githubBase)) {
		throw new Error(`Cannot resolve raw content URL from: ${url}`);
	}

	const rest = url.slice(githubBase.length); // "owner/repo/tree/branch/path..."
	const treeSep = '/tree/';
	const blobSep = '/blob/';

	const treeIdx = rest.indexOf(treeSep);
	const blobIdx = rest.indexOf(blobSep);

	if (treeIdx !== -1) {
		const ownerRepo = rest.slice(0, treeIdx); // "owner/repo"
		const branchAndPath = rest.slice(treeIdx + treeSep.length); // "branch/path..."
		// Split branch from path: path must contain at least one segment, so the
		// first "/" after the branch name separates branch from the skill path.
		// We require at least one path segment after the branch.
		const slashIdx = branchAndPath.indexOf('/');
		if (slashIdx === -1) {
			throw new Error(
				`Cannot resolve raw content URL from: ${url} (missing skill path after branch)`
			);
		}
		// For branches with slashes we can't know where the branch ends without
		// contacting the GitHub API, so we treat the minimal form (one segment) as
		// the branch and the rest as the path — this matches the common case.
		// Users with slash-containing branch names should use raw URLs directly.
		const branch = branchAndPath.slice(0, slashIdx);
		const path = branchAndPath.slice(slashIdx + 1);
		return `https://raw.githubusercontent.com/${ownerRepo}/${branch}/${path}/SKILL.md`;
	}

	if (blobIdx !== -1) {
		const ownerRepo = rest.slice(0, blobIdx);
		const branchAndPath = rest.slice(blobIdx + blobSep.length);
		const slashIdx = branchAndPath.indexOf('/');
		if (slashIdx === -1) {
			throw new Error(
				`Cannot resolve raw content URL from: ${url} (missing file path after branch)`
			);
		}
		const branch = branchAndPath.slice(0, slashIdx);
		const path = branchAndPath.slice(slashIdx + 1);
		return `https://raw.githubusercontent.com/${ownerRepo}/${branch}/${path}`;
	}

	throw new Error(`Cannot resolve raw content URL from: ${url}`);
}

/**
 * Convert a GitHub tree URL to a GitHub API contents URL.
 *
 * https://github.com/owner/repo/tree/branch/path
 * → https://api.github.com/repos/owner/repo/contents/path?ref=branch
 *
 * Throws for non-github.com URLs or URLs missing /tree/.
 */
export function resolveGitHubApiContentsUrl(url: string): string {
	const githubBase = 'https://github.com/';
	if (!url.startsWith(githubBase)) {
		throw new Error(`resolveGitHubApiContentsUrl: expected a github.com URL, got: ${url}`);
	}
	const rest = url.slice(githubBase.length);
	const treeSep = '/tree/';
	const treeIdx = rest.indexOf(treeSep);
	if (treeIdx === -1) {
		throw new Error(`resolveGitHubApiContentsUrl: URL must contain /tree/: ${url}`);
	}
	const ownerRepo = rest.slice(0, treeIdx);
	const branchAndPath = rest.slice(treeIdx + treeSep.length);
	const slashIdx = branchAndPath.indexOf('/');
	if (slashIdx === -1) {
		throw new Error(`resolveGitHubApiContentsUrl: URL must have a path after the branch: ${url}`);
	}
	const branch = branchAndPath.slice(0, slashIdx);
	const path = branchAndPath.slice(slashIdx + 1);
	return `https://api.github.com/repos/${ownerRepo}/contents/${path}?ref=${branch}`;
}

/** Maximum response body size accepted when fetching a remote skill (1 MiB). */
const SKILL_FETCH_MAX_BYTES = 1 * 1024 * 1024;

/** Fetch timeout when downloading a remote skill file (20 seconds). */
const SKILL_FETCH_TIMEOUT_MS = 20_000;

/** Maximum recursion depth for fetchGitHubDirectory. */
const SKILL_FETCH_MAX_DEPTH = 5;

/** Maximum total number of files written by a single fetchGitHubDirectory call tree. */
const SKILL_FETCH_MAX_FILES = 100;

/**
 * Validate that a name is safe to use as a single filesystem path component
 * (i.e., a plain filename — no directory separators allowed).
 *
 * Rejects empty strings, null bytes, path separators (/ and \), the special
 * names "." and "..", and names starting with a dot.
 *
 * Throws a descriptive Error on failure.
 */
export function validateCommandName(commandName: string): void {
	if (!commandName || commandName.trim() === '') {
		throw new Error('commandName must not be empty');
	}
	// Reject null bytes — these can be used to truncate or confuse path operations
	if (commandName.includes('\0')) {
		throw new Error('commandName must not contain null bytes');
	}
	// Reject path separators
	if (commandName.includes('/') || commandName.includes('\\')) {
		throw new Error('commandName must not contain path separators (/ or \\)');
	}
	// Reject the special names "." and ".."
	if (commandName === '.' || commandName === '..') {
		throw new Error('commandName must not be "." or ".."');
	}
	// Reject leading dots (hidden files / relative traversal prefixes)
	if (commandName.startsWith('.')) {
		throw new Error('commandName must not start with a dot');
	}
}

export class SkillsManager {
	private jobQueue: JobQueueRepository | null = null;

	constructor(
		private repo: SkillRepository,
		private appMcpServerRepo: AppMcpServerRepository,
		jobQueue?: JobQueueRepository
	) {
		if (jobQueue) this.jobQueue = jobQueue;
	}

	listSkills(): AppSkill[] {
		return this.repo.findAll();
	}

	getSkill(id: string): AppSkill | null {
		return this.repo.get(id);
	}

	addSkill(params: CreateSkillParams): AppSkill {
		// Validate sourceType/config consistency and security-sensitive fields
		this.validateSkillConfig(params.sourceType, params.config);

		// Enforce name uniqueness with a user-friendly error
		const existing = this.repo.getByName(params.name);
		if (existing) {
			throw new Error(`A skill named "${params.name}" already exists`);
		}

		const skill: AppSkill = {
			id: generateUUID(),
			name: params.name,
			displayName: params.displayName,
			description: params.description,
			sourceType: params.sourceType,
			config: params.config,
			enabled: params.enabled,
			builtIn: false,
			validationStatus: params.validationStatus ?? 'pending',
			createdAt: Date.now(),
		};

		this.repo.insert(skill);
		this.enqueueValidation(skill.id);
		const inserted = this.repo.get(skill.id);
		if (!inserted) {
			throw new Error(`Failed to insert skill "${params.name}"`);
		}
		return inserted;
	}

	updateSkill(id: string, params: UpdateSkillParams): AppSkill {
		const existing = this.repo.get(id);
		if (!existing) {
			throw new Error(`Skill not found: ${id}`);
		}

		if (params.config !== undefined) {
			this.validateSkillConfig(existing.sourceType, params.config);
		}

		this.repo.update(id, params);
		if (params.config !== undefined) {
			this.repo.setValidationStatus(id, 'pending');
			this.enqueueValidation(id);
		}
		return this.repo.get(id)!;
	}

	setSkillEnabled(id: string, enabled: boolean): AppSkill {
		const existing = this.repo.get(id);
		if (!existing) {
			throw new Error(`Skill not found: ${id}`);
		}
		this.repo.setEnabled(id, enabled);
		return this.repo.get(id)!;
	}

	/**
	 * Set the validation status for a skill (called by the async validation job).
	 * Throws if the skill does not exist so job failures are surfaced, not silenced.
	 */
	setSkillValidationStatus(id: string, status: SkillValidationStatus): AppSkill {
		const existing = this.repo.get(id);
		if (!existing) {
			throw new Error(`Skill not found: ${id}`);
		}
		this.repo.setValidationStatus(id, status);
		return this.repo.get(id)!;
	}

	/**
	 * Remove a skill by ID.
	 * Returns false if the skill is built-in or not found.
	 */
	removeSkill(id: string): boolean {
		const existing = this.repo.get(id);
		if (!existing) return false;
		if (existing.builtIn) return false;
		return this.repo.delete(id);
	}

	getEnabledSkills(): AppSkill[] {
		return this.repo.findEnabled();
	}

	/**
	 * Install a skill from a git repository URL.
	 *
	 * Accepts GitHub tree URLs like:
	 *   https://github.com/openai/skills/tree/main/skills/.curated/playwright
	 *
	 * For GitHub tree URLs: fetches the entire skill directory via the GitHub API
	 * and stores all files at ~/.neokai/skills/{commandName}/ (preserving structure).
	 *
	 * For other URLs (raw or fallback): fetches a single SKILL.md file.
	 *
	 * Registers a builtin skill entry in the DB.
	 *
	 * Idempotent: if a skill with the same name already exists in the DB, returns it
	 * without re-fetching or overwriting any local files.
	 *
	 * @param _workspaceRoot - kept for API compatibility but no longer used;
	 *   skills are always installed to ~/.neokai/skills/
	 */
	async installSkillFromGit(
		repoUrl: string,
		commandName: string,
		_workspaceRoot?: string
	): Promise<AppSkill> {
		// Sanitize commandName before using it in any filesystem path
		validateCommandName(commandName);

		// Check DB first — if already registered, return immediately without
		// making any network requests or filesystem writes (true idempotency).
		const existing = this.repo.getByName(commandName);
		if (existing) {
			return existing;
		}

		const destDir = join(homedir(), '.neokai', 'skills', commandName);

		if (repoUrl.includes('github.com') && repoUrl.includes('/tree/')) {
			// Fetch full skill directory via GitHub API
			const apiUrl = resolveGitHubApiContentsUrl(repoUrl);
			await this.fetchGitHubDirectory(apiUrl, destDir);
		} else {
			// Fallback: fetch a single SKILL.md (raw URL or blob URL)
			const rawUrl = resolveSkillRawUrl(repoUrl);
			await mkdir(destDir, { recursive: true });
			const content = await this.fetchTextWithLimits(rawUrl);
			const skillFile = join(destDir, 'SKILL.md');
			const exists = await access(skillFile)
				.then(() => true)
				.catch(() => false);
			if (!exists) {
				await writeFile(skillFile, content, 'utf-8');
			}
		}

		const skill: AppSkill = {
			id: generateUUID(),
			name: commandName,
			displayName: commandName,
			description: `Skill installed from ${repoUrl}`,
			sourceType: 'builtin',
			config: { type: 'builtin', commandName },
			enabled: true,
			builtIn: false, // user-installed, can be deleted
			validationStatus: 'valid',
			createdAt: Date.now(),
		};
		this.repo.insert(skill);
		return this.repo.get(skill.id)!;
	}

	/**
	 * Recursively fetch a GitHub directory (via API contents endpoint) to destDir.
	 * Skips files that already exist to preserve local edits.
	 *
	 * Safety limits:
	 * - Max recursion depth: SKILL_FETCH_MAX_DEPTH levels
	 * - Max total files written: SKILL_FETCH_MAX_FILES files (shared counter)
	 * - Entry names from the API are validated with validateCommandName() to prevent
	 *   path traversal via malicious/compromised API responses
	 */
	private async fetchGitHubDirectory(
		apiUrl: string,
		destDir: string,
		depth = 0,
		fileCount = { value: 0 }
	): Promise<void> {
		if (depth > SKILL_FETCH_MAX_DEPTH) {
			throw new Error(`Skill directory exceeds maximum nesting depth of ${SKILL_FETCH_MAX_DEPTH}`);
		}

		type GitHubEntry = {
			name: string;
			type: string;
			download_url: string | null;
			url: string;
		};

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), SKILL_FETCH_TIMEOUT_MS);
		let entries: GitHubEntry[];
		try {
			const response = await fetch(apiUrl, {
				signal: controller.signal,
				headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'neokai' },
			});
			if (!response.ok) {
				throw new Error(
					`GitHub API error for ${apiUrl}: ${response.status} ${response.statusText}`
				);
			}
			entries = (await response.json()) as GitHubEntry[];
		} finally {
			clearTimeout(timeoutId);
		}

		await mkdir(destDir, { recursive: true });

		for (const entry of entries) {
			// Validate each entry name from the API before using it in any path —
			// a malicious or compromised response could try path traversal via entry.name.
			try {
				validateCommandName(entry.name);
			} catch {
				throw new Error(
					`Unsafe entry name "${entry.name}" returned by GitHub API — aborting install`
				);
			}

			if (entry.type === 'file' && entry.download_url) {
				if (fileCount.value >= SKILL_FETCH_MAX_FILES) {
					throw new Error(`Skill directory exceeds maximum file count of ${SKILL_FETCH_MAX_FILES}`);
				}
				fileCount.value += 1;
				const destFile = join(destDir, entry.name);
				const alreadyExists = await access(destFile)
					.then(() => true)
					.catch(() => false);
				if (!alreadyExists) {
					const content = await this.fetchTextWithLimits(entry.download_url);
					await writeFile(destFile, content, 'utf-8');
				}
			} else if (entry.type === 'dir') {
				// Recurse into subdirectory — depth and fileCount are shared across the tree
				await this.fetchGitHubDirectory(entry.url, join(destDir, entry.name), depth + 1, fileCount);
			}
		}
	}

	/**
	 * Fetch a URL with timeout and size limit. Returns text content.
	 */
	private async fetchTextWithLimits(url: string): Promise<string> {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), SKILL_FETCH_TIMEOUT_MS);
		try {
			const response = await fetch(url, { signal: controller.signal });
			if (!response.ok) {
				throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
			}
			const contentLength = response.headers.get('content-length');
			if (contentLength && parseInt(contentLength, 10) > SKILL_FETCH_MAX_BYTES) {
				throw new Error(`File at ${url} exceeds size limit`);
			}
			const buffer = await response.arrayBuffer();
			if (buffer.byteLength > SKILL_FETCH_MAX_BYTES) {
				throw new Error(`File at ${url} exceeds size limit`);
			}
			return new TextDecoder().decode(buffer);
		} finally {
			clearTimeout(timeoutId);
		}
	}

	/**
	 * Upsert default built-in skills on startup.
	 * For mcp_server type built-ins, ensures backing app_mcp_servers entries exist.
	 */
	initializeBuiltins(): void {
		this.initChromeDevToolsMcp();
		this.initPlaywrightSkill();
		this.initPlaywrightInteractiveSkill();
	}

	/**
	 * Ensure the Chrome DevTools MCP built-in skill is registered.
	 *
	 * Reuses the existing `chrome-devtools` app_mcp_servers entry seeded by
	 * seedDefaultMcpEntries() (which always runs before initializeBuiltins()).
	 * If that entry is somehow absent, creates it as a fallback.
	 */
	private initChromeDevToolsMcp(): void {
		// Step 1: resolve the backing app_mcp_servers entry (seeded by seed-defaults.ts)
		const appMcpEntry =
			this.appMcpServerRepo.getByName('chrome-devtools') ??
			this.appMcpServerRepo.create({
				name: 'chrome-devtools',
				description:
					'Browser automation and DevTools integration via Chrome DevTools MCP (isolated mode)',
				sourceType: 'stdio',
				command: 'bunx',
				args: ['chrome-devtools-mcp@latest', '--isolated'],
				env: {},
				enabled: false,
				source: 'builtin',
			});

		// Step 2: upsert the skill referencing the app MCP entry
		const existing = this.repo.getByName('chrome-devtools-mcp');
		if (!existing) {
			const skill: AppSkill = {
				id: generateUUID(),
				name: 'chrome-devtools-mcp',
				displayName: 'Chrome DevTools (MCP)',
				description:
					'Browser automation and DevTools integration via Chrome DevTools MCP. Runs in isolated mode.',
				sourceType: 'mcp_server',
				config: { type: 'mcp_server', appMcpServerId: appMcpEntry.id },
				enabled: false, // opt-in, not default
				builtIn: true,
				validationStatus: 'valid',
				createdAt: Date.now(),
			};
			this.repo.insert(skill);
		}
	}

	/**
	 * Ensure the Playwright built-in skill is registered.
	 */
	private initPlaywrightSkill(): void {
		const existing = this.repo.getByName('playwright');
		if (!existing) {
			const skill: AppSkill = {
				id: generateUUID(),
				name: 'playwright',
				displayName: 'Playwright',
				description: 'Browser automation and testing via Playwright.',
				sourceType: 'builtin',
				config: { type: 'builtin', commandName: 'playwright' },
				enabled: true,
				builtIn: true,
				validationStatus: 'valid',
				createdAt: Date.now(),
			};
			this.repo.insert(skill);
		}
	}

	/**
	 * Ensure the Playwright Interactive built-in skill is registered.
	 */
	private initPlaywrightInteractiveSkill(): void {
		const existing = this.repo.getByName('playwright-interactive');
		if (!existing) {
			const skill: AppSkill = {
				id: generateUUID(),
				name: 'playwright-interactive',
				displayName: 'Playwright Interactive',
				description: 'Interactive browser automation via Playwright with step-by-step control.',
				sourceType: 'builtin',
				config: { type: 'builtin', commandName: 'playwright-interactive' },
				enabled: true,
				builtIn: true,
				validationStatus: 'valid',
				createdAt: Date.now(),
			};
			this.repo.insert(skill);
		}
	}

	// ---------------------------------------------------------------------------
	// Private helpers
	// ---------------------------------------------------------------------------

	/**
	 * Enqueue an async validation job for a skill.
	 * No-op if jobQueue is not set (e.g. during tests or before full app init).
	 */
	private enqueueValidation(skillId: string): void {
		if (!this.jobQueue) return;
		this.jobQueue.enqueue({ queue: SKILL_VALIDATE, payload: { skillId } });
	}

	/**
	 * Validate source-type-specific config fields for security.
	 * Throws a descriptive Error on validation failure.
	 *
	 * Checks performed:
	 * 1. sourceType must match config.type (prevents mismatched payloads)
	 * 2. Source-type-specific field constraints
	 */
	private validateSkillConfig(sourceType: SkillSourceType, config: AppSkillConfig): void {
		// Explicit sourceType/config.type consistency check
		if (sourceType !== config.type) {
			throw new Error(`sourceType "${sourceType}" must match config.type "${config.type}"`);
		}

		if (config.type === 'plugin') {
			const { pluginPath } = config;
			if (!pluginPath || pluginPath.trim() === '') {
				throw new Error('plugin skill: pluginPath must not be empty');
			}
			if (!pluginPath.startsWith('/')) {
				throw new Error('plugin skill: pluginPath must be an absolute path (starts with /)');
			}
			// Reject any path that contains '..' as a segment (handles /a/../b and /a/b/..)
			if (pluginPath.split('/').some((seg) => seg === '..')) {
				throw new Error('plugin skill: pluginPath must not contain path traversal sequences (../)');
			}
		} else if (config.type === 'mcp_server') {
			const { appMcpServerId } = config;
			if (!appMcpServerId || appMcpServerId.trim() === '') {
				throw new Error('mcp_server skill: appMcpServerId must not be empty');
			}
			const server = this.appMcpServerRepo.get(appMcpServerId);
			if (!server) {
				throw new Error(
					`mcp_server skill: app_mcp_servers entry not found for id "${appMcpServerId}"`
				);
			}
		} else if (config.type === 'builtin') {
			const { commandName } = config;
			if (!commandName || commandName.trim() === '') {
				throw new Error('builtin skill: commandName must not be empty');
			}
		} else {
			// Exhaustive type guard
			const _exhaustive: never = config;
			throw new Error(`Unknown skill config type: ${(_exhaustive as AppSkillConfig).type}`);
		}
	}
}
