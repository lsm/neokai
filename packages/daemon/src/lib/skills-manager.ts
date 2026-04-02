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

/** Maximum response body size accepted when fetching a remote skill (1 MiB). */
const SKILL_FETCH_MAX_BYTES = 1 * 1024 * 1024;

/** Fetch timeout when downloading a remote skill file (20 seconds). */
const SKILL_FETCH_TIMEOUT_MS = 20_000;

/**
 * Validate that a commandName is safe to use as a filesystem path component.
 * Rejects empty strings, path separators, ".." traversal, null bytes, and
 * any character that would be unsafe in a filename across common platforms.
 *
 * Throws a descriptive Error on failure.
 */
export function validateCommandName(commandName: string): void {
	if (!commandName || commandName.trim() === '') {
		throw new Error('commandName must not be empty');
	}
	// Reject null bytes
	if (commandName.includes('\0')) {
		throw new Error('commandName must not contain null bytes');
	}
	// Reject path separators
	if (commandName.includes('/') || commandName.includes('\\')) {
		throw new Error('commandName must not contain path separators (/ or \\)');
	}
	// Reject ".." traversal
	if (commandName === '..' || commandName.startsWith('../') || commandName.endsWith('/..')) {
		throw new Error('commandName must not contain path traversal sequences (..)');
	}
	// Reject leading/trailing dots (hidden files, . and ..)
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
	 * Fetches the SKILL.md (converted via resolveSkillRawUrl) from the repo,
	 * stores it at ~/.neokai/skills/{commandName}/SKILL.md (only if not already present),
	 * writes it to {workspaceRoot}/.claude/commands/{commandName}.md (only if not already present),
	 * and registers a builtin skill entry in the DB.
	 *
	 * Idempotent: if a skill with the same name already exists in the DB, returns it
	 * without re-fetching or overwriting any local files.
	 */
	async installSkillFromGit(
		repoUrl: string,
		commandName: string,
		workspaceRoot?: string
	): Promise<AppSkill> {
		// Sanitize commandName before using it in any filesystem path
		validateCommandName(commandName);

		// Check DB first — if already registered, return immediately without
		// making any network requests or filesystem writes (true idempotency).
		const existing = this.repo.getByName(commandName);
		if (existing) {
			return existing;
		}

		const rawUrl = resolveSkillRawUrl(repoUrl);

		// Fetch with a timeout and size limit to prevent hangs and oversized writes
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), SKILL_FETCH_TIMEOUT_MS);
		let content: string;
		try {
			const response = await fetch(rawUrl, { signal: controller.signal });
			if (!response.ok) {
				throw new Error(
					`Failed to fetch skill from ${rawUrl}: ${response.status} ${response.statusText}`
				);
			}
			const contentLength = response.headers.get('content-length');
			if (contentLength && parseInt(contentLength, 10) > SKILL_FETCH_MAX_BYTES) {
				throw new Error(
					`Skill file at ${rawUrl} is too large (${contentLength} bytes; limit is ${SKILL_FETCH_MAX_BYTES})`
				);
			}
			const buffer = await response.arrayBuffer();
			if (buffer.byteLength > SKILL_FETCH_MAX_BYTES) {
				throw new Error(
					`Skill file at ${rawUrl} is too large (${buffer.byteLength} bytes; limit is ${SKILL_FETCH_MAX_BYTES})`
				);
			}
			content = new TextDecoder().decode(buffer);
		} finally {
			clearTimeout(timeoutId);
		}

		// Store to ~/.neokai/skills/{commandName}/ — skip if already present
		const skillsDir = join(homedir(), '.neokai', 'skills', commandName);
		await mkdir(skillsDir, { recursive: true });
		const skillFile = join(skillsDir, 'SKILL.md');
		const skillFileExists = await access(skillFile)
			.then(() => true)
			.catch(() => false);
		if (!skillFileExists) {
			await writeFile(skillFile, content, 'utf-8');
		}

		// Write to workspace .claude/commands/ — skip if already present
		if (workspaceRoot) {
			const commandsDir = join(workspaceRoot, '.claude', 'commands');
			await mkdir(commandsDir, { recursive: true });
			const cmdFile = join(commandsDir, `${commandName}.md`);
			const cmdFileExists = await access(cmdFile)
				.then(() => true)
				.catch(() => false);
			if (!cmdFileExists) {
				await writeFile(cmdFile, content, 'utf-8');
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
	 * Upsert default built-in skills on startup.
	 * For mcp_server type built-ins, ensures backing app_mcp_servers entries exist.
	 */
	initializeBuiltins(): void {
		this.initWebSearchBraveMcp();
		this.initChromeDevToolsMcp();
		this.initPlaywrightSkill();
		this.initPlaywrightInteractiveSkill();
	}

	/**
	 * Ensure the Brave Search MCP built-in skill is registered.
	 *
	 * Reuses the existing `brave-search` app_mcp_servers entry seeded by
	 * seedDefaultMcpEntries() (which always runs before initializeBuiltins()).
	 * If that entry is somehow absent, creates it as a fallback.
	 */
	private initWebSearchBraveMcp(): void {
		// Step 1: resolve the backing app_mcp_servers entry (seeded by seed-defaults.ts)
		const appMcpEntry =
			this.appMcpServerRepo.getByName('brave-search') ??
			this.appMcpServerRepo.create({
				name: 'brave-search',
				description: 'Web search via Brave Search API (requires BRAVE_API_KEY env var)',
				sourceType: 'stdio',
				command: 'npx',
				args: ['-y', '@modelcontextprotocol/server-brave-search'],
				env: {},
				enabled: false,
			});

		// Step 2: upsert the skill referencing the app MCP entry
		const existing = this.repo.getByName('web-search-mcp');
		if (!existing) {
			const skill: AppSkill = {
				id: generateUUID(),
				name: 'web-search-mcp',
				displayName: 'Web Search (MCP)',
				description: 'Web search capability via Brave Search MCP. Requires BRAVE_API_KEY env var.',
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
