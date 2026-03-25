/**
 * File Index — Workspace file tree cache with polling-based refresh.
 *
 * Scans the workspace once on init(), maintains an in-memory cache of all
 * file and folder entries, and refreshes the cache incrementally via polling.
 * Designed for fast fuzzy search without recursive directory listing on every query.
 */

import { join, normalize, relative } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export interface FileIndexEntry {
	/** Relative path from workspace root (e.g. "src/utils/helper.ts") */
	path: string;
	/** File or directory name (e.g. "helper.ts") */
	name: string;
	type: 'file' | 'folder';
}

interface IgnorePattern {
	/** Glob pattern string (after stripping `!` prefix and `/` suffix) */
	pattern: string;
	negated: boolean;
	/** True if the pattern only applies to directories */
	dirOnly: boolean;
}

// Always-ignored names regardless of .gitignore
const BUILTIN_IGNORE_NAMES = new Set(['.git', 'node_modules', '.DS_Store']);

function parseGitignoreLines(lines: string[]): IgnorePattern[] {
	const patterns: IgnorePattern[] = [];

	for (const raw of lines) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;

		let pattern = line;
		const negated = pattern.startsWith('!');
		if (negated) pattern = pattern.slice(1);

		const dirOnly = pattern.endsWith('/');
		if (dirOnly) pattern = pattern.slice(0, -1);

		if (!pattern) continue;

		patterns.push({ pattern, negated, dirOnly });
	}

	return patterns;
}

/**
 * Match a single path segment against a simple glob pattern.
 * Supports: `*` (any chars except `/`), `**` (any sequence), `?` (one char).
 */
function matchSegment(pattern: string, segment: string): boolean {
	// Build a regex from the glob pattern
	let rx = '^';
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === '*' && pattern[i + 1] === '*') {
			rx += '.*';
			i += 2;
			if (pattern[i] === '/') i++;
		} else if (ch === '*') {
			rx += '[^/]*';
			i++;
		} else if (ch === '?') {
			rx += '[^/]';
			i++;
		} else {
			// Escape regex metacharacters
			rx += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
			i++;
		}
	}
	rx += '$';
	return new RegExp(rx, 'i').test(segment);
}

/**
 * Match a full relative path (with `/` separators) against a glob pattern.
 * Used when the pattern itself contains a `/`.
 */
function matchFullPath(pattern: string, relPath: string): boolean {
	let rx = '^';
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === '*' && pattern[i + 1] === '*') {
			rx += '.*';
			i += 2;
			if (pattern[i] === '/') i++;
		} else if (ch === '*') {
			rx += '[^/]*';
			i++;
		} else if (ch === '?') {
			rx += '[^/]';
			i++;
		} else {
			rx += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
			i++;
		}
	}
	rx += '$';
	const regex = new RegExp(rx, 'i');
	return regex.test(relPath);
}

function shouldIgnore(relPath: string, isDirectory: boolean, patterns: IgnorePattern[]): boolean {
	const segments = relPath.split('/');

	// Always ignore built-in names at any depth
	for (const seg of segments) {
		if (BUILTIN_IGNORE_NAMES.has(seg)) return true;
	}

	let ignored = false;

	for (const { pattern, negated, dirOnly } of patterns) {
		if (dirOnly && !isDirectory) continue;

		let matches = false;

		if (pattern.includes('/')) {
			// Anchored pattern: match against full relative path
			matches = matchFullPath(pattern, relPath);
		} else {
			// Floating pattern: match against any path segment
			matches = segments.some((seg) => matchSegment(pattern, seg));
		}

		if (matches) {
			ignored = !negated;
		}
	}

	return ignored;
}

/**
 * Score a search result. Higher is better.
 *  100 — exact name match (case-insensitive)
 *   80 — name starts with query
 *   60 — name contains query
 *   40 — any path segment contains query
 *   20 — full path contains query
 *    0 — no match
 */
function scoreEntry(entry: FileIndexEntry, lowerQuery: string): number {
	const lowerName = entry.name.toLowerCase();
	const lowerPath = entry.path.toLowerCase();

	if (lowerName === lowerQuery) return 100;
	if (lowerName.startsWith(lowerQuery)) return 80;
	if (lowerName.includes(lowerQuery)) return 60;

	// Check individual path segments
	const segments = lowerPath.split('/');
	if (segments.some((s) => s.includes(lowerQuery))) return 40;

	if (lowerPath.includes(lowerQuery)) return 20;

	return 0;
}

/**
 * Prevent path traversal: return true if the path is safe to use.
 */
function isSafePath(workspacePath: string, relPath: string): boolean {
	// Reject absolute paths
	if (relPath.startsWith('/')) return false;

	// Reject paths with .. segments
	const segments = relPath.split('/');
	if (segments.some((s) => s === '..')) return false;

	// Double-check by resolving and comparing
	const normalizedWorkspace = normalize(workspacePath);
	const resolved = normalize(join(workspacePath, relPath));
	const rel = relative(normalizedWorkspace, resolved);

	return !rel.startsWith('..') && rel !== '..';
}

export class FileIndex {
	private cache = new Map<string, FileIndexEntry>();
	private ready = false;
	private scanning = false;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private ignorePatterns: IgnorePattern[] = [];
	private extraPatterns: IgnorePattern[] = [];
	private readonly pollInterval: number;

	constructor(
		private readonly workspacePath: string,
		pollIntervalMs?: number
	) {
		this.pollInterval =
			pollIntervalMs ?? parseInt(process.env.NEOKAI_FILE_INDEX_POLL_MS ?? '10000', 10);
	}

	/** Load .gitignore from workspace root if it exists. */
	private async loadGitignore(): Promise<void> {
		const gitignorePath = join(this.workspacePath, '.gitignore');
		try {
			if (!existsSync(gitignorePath)) return;
			const content = await readFile(gitignorePath, 'utf-8');
			this.ignorePatterns = parseGitignoreLines(content.split('\n'));
		} catch {
			// Non-fatal: continue without .gitignore patterns
		}
	}

	/** Combined ignore patterns (gitignore + extra). */
	private get allPatterns(): IgnorePattern[] {
		return [...this.ignorePatterns, ...this.extraPatterns];
	}

	/** Recursively scan a directory and populate the cache. */
	private async scanDirectory(absDir: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(absDir, { withFileTypes: true });
		} catch {
			// Permission errors or missing dirs — skip silently
			return;
		}

		for (const entry of entries) {
			const absPath = join(absDir, entry.name);
			const relPath = relative(this.workspacePath, absPath);

			if (!isSafePath(this.workspacePath, relPath)) continue;

			const isDir = entry.isDirectory();

			if (shouldIgnore(relPath, isDir, this.allPatterns)) continue;

			const indexEntry: FileIndexEntry = {
				path: relPath,
				name: entry.name,
				type: isDir ? 'folder' : 'file',
			};

			this.cache.set(relPath, indexEntry);

			if (isDir) {
				await this.scanDirectory(absPath);
			}
		}
	}

	/**
	 * Incremental refresh: walk the workspace and sync the cache.
	 * Adds new entries and removes stale ones for a single directory pass.
	 * Uses readdir with withFileTypes (no stat calls) for speed.
	 */
	private async refreshDirectory(absDir: string, seen: Set<string>): Promise<void> {
		let entries;
		try {
			entries = await readdir(absDir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			const absPath = join(absDir, entry.name);
			const relPath = relative(this.workspacePath, absPath);

			if (!isSafePath(this.workspacePath, relPath)) continue;

			const isDir = entry.isDirectory();

			if (shouldIgnore(relPath, isDir, this.allPatterns)) continue;

			seen.add(relPath);

			if (!this.cache.has(relPath)) {
				this.cache.set(relPath, {
					path: relPath,
					name: entry.name,
					type: isDir ? 'folder' : 'file',
				});
			}

			if (isDir) {
				await this.refreshDirectory(absPath, seen);
			}
		}
	}

	/** Run a full incremental refresh scan. */
	private async runRefresh(): Promise<void> {
		if (this.scanning) return; // Skip if previous scan is still running
		this.scanning = true;

		try {
			const seen = new Set<string>();
			await this.refreshDirectory(this.workspacePath, seen);

			// Remove entries that no longer exist
			for (const key of this.cache.keys()) {
				if (!seen.has(key)) {
					this.cache.delete(key);
				}
			}
		} finally {
			this.scanning = false;
		}
	}

	/**
	 * Perform the initial workspace scan.
	 * Must be called before `search()`. Starts the background polling timer.
	 */
	async init(): Promise<void> {
		await this.loadGitignore();
		await this.scanDirectory(this.workspacePath);
		this.ready = true;

		// Start background polling
		this.pollTimer = setInterval(() => {
			void this.runRefresh();
		}, this.pollInterval);
	}

	/**
	 * Fuzzy-search cached entries by name and path.
	 * Returns results sorted by relevance score, highest first.
	 *
	 * @param query  Search string (case-insensitive)
	 * @param limit  Maximum number of results (default: 50)
	 */
	search(query: string, limit = 50): FileIndexEntry[] {
		if (!query) {
			// Return first `limit` entries when query is empty
			const results: FileIndexEntry[] = [];
			for (const entry of this.cache.values()) {
				results.push(entry);
				if (results.length >= limit) break;
			}
			return results;
		}

		const lowerQuery = query.toLowerCase();
		const scored: Array<{ entry: FileIndexEntry; score: number }> = [];

		for (const entry of this.cache.values()) {
			const score = scoreEntry(entry, lowerQuery);
			if (score > 0) {
				scored.push({ entry, score });
			}
		}

		scored.sort((a, b) => b.score - a.score);

		return scored.slice(0, limit).map((s) => s.entry);
	}

	/**
	 * Remove a single path from the cache.
	 * Useful when a file/folder is known to be deleted or moved.
	 */
	invalidate(path: string): void {
		this.cache.delete(path);
	}

	/** Clear the entire cache. */
	invalidateAll(): void {
		this.cache.clear();
	}

	/** Whether the initial scan has completed. */
	isReady(): boolean {
		return this.ready;
	}

	/** Number of entries currently in the cache (useful for testing). */
	size(): number {
		return this.cache.size;
	}

	/**
	 * Set additional ignore patterns at runtime.
	 * These are layered on top of .gitignore patterns.
	 */
	setIgnorePatterns(patterns: string[]): void {
		this.extraPatterns = parseGitignoreLines(patterns);
	}

	/**
	 * Stop the background polling timer and release resources.
	 * Must be called when the index is no longer needed.
	 */
	dispose(): void {
		if (this.pollTimer !== null) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}
}
