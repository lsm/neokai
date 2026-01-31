/**
 * SDK CLI Path Resolver
 *
 * Resolves the path to the Claude Agent SDK's bundled CLI executable.
 *
 * In dev mode (running via bun run), the CLI is found in node_modules.
 * In bundled binary mode (bun build --compile), the CLI is embedded in
 * the binary's virtual filesystem. Since the SDK spawns cli.js as a
 * separate child process (which can't access the virtual FS), we extract
 * it to a real filesystem path.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

/**
 * Check if we're running inside a Bun compiled binary.
 * In compiled binaries, process.execPath points to the binary itself,
 * not to a JS runtime. The SDK would try to use it as the runtime
 * to spawn cli.js, which won't work.
 */
export function isBundledBinary(): boolean {
	return import.meta.url.includes('/$bunfs/root/');
}

/** Virtual path set from the embedded file import in prod-entry.ts */
let embeddedCliPath: string | undefined;

/** Cached resolved real filesystem path */
let cachedCliPath: string | undefined;

/**
 * Register the embedded CLI path from a `{ type: "file" }` import.
 * Called from prod-entry.ts at startup.
 *
 * The path points to a /$bunfs/root/ virtual path that is readable
 * within this process but not accessible by child processes.
 */
export function setEmbeddedCliPath(path: string): void {
	embeddedCliPath = path;
}

/**
 * Try to resolve cli.js from node_modules (dev mode).
 */
function resolveFromNodeModules(): string | undefined {
	// Strategy 1: import.meta.resolve
	try {
		const sdkModulePath = import.meta.resolve?.(SDK_PACKAGE);
		if (sdkModulePath) {
			const sdkPath = sdkModulePath.startsWith('file://')
				? fileURLToPath(sdkModulePath)
				: sdkModulePath;
			const cliPath = join(dirname(sdkPath), 'cli.js');
			if (existsSync(cliPath)) {
				return cliPath;
			}
		}
	} catch {
		// import.meta.resolve might not be available
	}

	// Strategy 2: Walk up from current file
	try {
		let currentDir = dirname(fileURLToPath(import.meta.url));
		for (let i = 0; i < 10; i++) {
			const candidate = join(currentDir, 'node_modules', SDK_PACKAGE, 'cli.js');
			if (existsSync(candidate)) {
				return candidate;
			}
			const parentDir = dirname(currentDir);
			if (parentDir === currentDir) break;
			currentDir = parentDir;
		}
	} catch {
		// fileURLToPath might fail for virtual paths
	}

	return undefined;
}

/**
 * Extract the embedded CLI to a real filesystem path.
 *
 * The SDK spawns cli.js as a child process using a JS runtime (node/bun).
 * Child processes can't access /$bunfs/root/ virtual paths, so we extract
 * the file to a temp directory. The path is content-hashed so SDK upgrades
 * get a fresh extraction.
 */
function extractEmbeddedCli(): string | undefined {
	if (!embeddedCliPath) return undefined;

	try {
		const content = readFileSync(embeddedCliPath);

		// Content-hash for cache busting on SDK upgrades
		const hash = createHash('md5').update(content.subarray(0, 1024)).digest('hex').slice(0, 12);
		const extractDir = join(tmpdir(), 'neokai-sdk', hash);
		const extractPath = join(extractDir, 'cli.js');

		if (existsSync(extractPath)) {
			return extractPath;
		}

		mkdirSync(extractDir, { recursive: true });
		writeFileSync(extractPath, content, { mode: 0o755 });

		return extractPath;
	} catch {
		return undefined;
	}
}

/**
 * Resolve the path to the Claude Code CLI bundled with the SDK.
 *
 * @returns Real filesystem path to cli.js, or undefined if not found
 */
export function resolveSDKCliPath(): string | undefined {
	if (cachedCliPath !== undefined) {
		return cachedCliPath;
	}

	// Priority 1: Resolve from node_modules (dev mode)
	const nodeModulesPath = resolveFromNodeModules();
	if (nodeModulesPath) {
		cachedCliPath = nodeModulesPath;
		return cachedCliPath;
	}

	// Priority 2: Extract embedded CLI to real filesystem (bundled binary mode)
	const extractedPath = extractEmbeddedCli();
	if (extractedPath) {
		cachedCliPath = extractedPath;
		return cachedCliPath;
	}

	return undefined;
}
