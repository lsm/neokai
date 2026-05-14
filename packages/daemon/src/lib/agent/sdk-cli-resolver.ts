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

import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

/**
 * Detect whether the current Linux system uses musl libc (Alpine, etc.)
 * instead of glibc. Checks for the musl dynamic linker in /lib and /lib64.
 */
function isMusl(): boolean {
	if (process.platform !== 'linux') return false;
	// Check for musl dynamic linker
	for (const libDir of ['/lib', '/lib64']) {
		try {
			const files = readdirSync(libDir);
			if (files.some((f) => f.startsWith('ld-musl'))) return true;
		} catch {
			// Directory doesn't exist or isn't readable
		}
	}
	return false;
}

/**
 * Platform suffix for the SDK's native CLI binary package.
 * Follows the naming convention: `@anthropic-ai/claude-agent-sdk-{os}-{arch}[-musl]`
 * @public Exported for use by build scripts.
 */
export function getPlatformPackageName(): string | undefined {
	const { platform, arch } = process;
	if (platform === 'win32' && arch === 'x64') return `${SDK_PACKAGE}-win32-x64`;
	if (platform === 'win32' && arch === 'arm64') return `${SDK_PACKAGE}-win32-arm64`;
	if (platform === 'darwin' && arch === 'x64') return `${SDK_PACKAGE}-darwin-x64`;
	if (platform === 'darwin' && arch === 'arm64') return `${SDK_PACKAGE}-darwin-arm64`;
	if (platform === 'linux' && arch === 'x64')
		return isMusl() ? `${SDK_PACKAGE}-linux-x64-musl` : `${SDK_PACKAGE}-linux-x64`;
	if (platform === 'linux' && arch === 'arm64')
		return isMusl() ? `${SDK_PACKAGE}-linux-arm64-musl` : `${SDK_PACKAGE}-linux-arm64`;
	return undefined;
}

/**
 * Native CLI binary name (platform-dependent).
 * @public Exported for use by build scripts.
 */
export function getCliBinaryName(): string {
	return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

/**
 * Check if we're running inside a Bun compiled binary.
 * In compiled binaries, process.execPath points to the binary itself,
 * not to a JS runtime. The SDK would try to use it as the runtime
 * to spawn cli.js, which won't work.
 */
export function isBundledBinary(): boolean {
	return import.meta.url.includes('/$bunfs/root/');
}

/**
 * Check if we're running under the Bun runtime (dev, test, or compiled binary mode).
 *
 * When running under Bun, SDK subprocesses should also use Bun to avoid
 * Node.js version mismatches. For example, `node:sqlite` was added in
 * Node.js v22.5.0 but is available in Bun via its Node.js compat layer.
 * CI runners may have an older Node.js (e.g. v20) on PATH; using 'bun'
 * ensures the subprocess gets the same compat surface as the parent process.
 */
export function isRunningUnderBun(): boolean {
	return typeof globalThis.Bun !== 'undefined';
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
 * @public Used by packages/cli/prod-entry.ts in compiled binaries.
 */
export function setEmbeddedCliPath(path: string): void {
	embeddedCliPath = path;
}

/**
 * Try to resolve the CLI from node_modules (dev mode).
 *
 * SDK ≥ 0.2.141 ships platform-specific native binaries (`claude`) via
 * optional dependency packages (e.g. `@anthropic-ai/claude-agent-sdk-darwin-x64`).
 * Older versions shipped `cli.js` in the main package.
 */
function resolveFromNodeModules(): string | undefined {
	const binaryName = getCliBinaryName();
	const platformPkg = getPlatformPackageName();

	// Strategy 1: import.meta.resolve for platform-specific native binary
	if (platformPkg) {
		try {
			const resolved = import.meta.resolve?.(platformPkg);
			if (resolved) {
				const pkgPath = resolved.startsWith('file://') ? fileURLToPath(resolved) : resolved;
				// The platform package has the binary at its root
				const binPath = join(dirname(pkgPath), binaryName);
				if (existsSync(binPath)) {
					return binPath;
				}
			}
		} catch {
			// import.meta.resolve might not be available or package not installed
		}
	}

	// Strategy 2: Navigate from main SDK package to bun's hoisted platform binary.
	// Bun installs the main SDK at node_modules/.bun/@anthropic-ai+claude-agent-sdk@.../node_modules/@anthropic-ai/claude-agent-sdk/
	// and symlinks the platform package at node_modules/.bun/node_modules/@anthropic-ai/claude-agent-sdk-{os}-{arch}/.
	if (platformPkg) {
		try {
			const sdkModulePath = import.meta.resolve?.(SDK_PACKAGE);
			if (sdkModulePath) {
				const sdkPath = sdkModulePath.startsWith('file://')
					? fileURLToPath(sdkModulePath)
					: sdkModulePath;
				// Navigate up 4 levels: @anthropic-ai/claude-agent-sdk -> node_modules -> @anthropic-ai+claude-agent-sdk@... -> .bun
				const bunDir = dirname(dirname(dirname(dirname(sdkPath))));
				const hoistedPath = join(bunDir, 'node_modules', platformPkg, binaryName);
				if (existsSync(hoistedPath)) {
					return hoistedPath;
				}
			}
		} catch {
			// import.meta.resolve might not be available
		}
	}

	// Strategy 3: Walk up from current file to find platform-specific binary
	if (platformPkg) {
		try {
			let currentDir = dirname(fileURLToPath(import.meta.url));
			for (let i = 0; i < 10; i++) {
				const candidate = join(currentDir, 'node_modules', platformPkg, binaryName);
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
	}

	// Strategy 4: Legacy cli.js (SDK < 0.2.141)
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

	// Strategy 5: Walk up for legacy cli.js
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
 * The SDK CLI is a native binary (or legacy cli.js). Child processes can't
 * access /$bunfs/root/ virtual paths, so we extract the file to a temp
 * directory. The path is content-hashed so SDK upgrades get a fresh extraction.
 *
 * After extraction, attempts to link system ripgrep into the SDK's expected
 * vendor path so that sandbox mode works on Linux/macOS CI environments.
 */
function extractEmbeddedCli(): string | undefined {
	if (!embeddedCliPath) return undefined;

	try {
		const content = readFileSync(embeddedCliPath);

		// Content-hash for cache busting on SDK upgrades
		const hash = createHash('md5').update(content.subarray(0, 1024)).digest('hex').slice(0, 12);
		const extractDir = join(tmpdir(), 'neokai-sdk', hash);
		// Use the embedded path's filename to detect native binary vs legacy cli.js
		const baseName = embeddedCliPath.endsWith('.js') ? 'cli.js' : getCliBinaryName();
		const extractPath = join(extractDir, baseName);

		if (!existsSync(extractPath)) {
			mkdirSync(extractDir, { recursive: true });
			writeFileSync(extractPath, content, { mode: 0o755 });
		}

		// Ensure vendor ripgrep binary exists for sandbox mode.
		// The SDK checks for ripgrep at vendor/ripgrep/<platform>/rg relative to the CLI.
		// In compiled binary mode the vendor directory is not bundled, so we copy
		// the system-installed ripgrep (from apt-get / brew) if available.
		copySystemRipgrepToVendor(extractDir);

		return extractPath;
	} catch {
		return undefined;
	}
}

/**
 * Return the SDK vendor platform string (e.g. "x64-linux") matching the
 * directory names inside @anthropic-ai/claude-agent-sdk/vendor/ripgrep/.
 * Returns undefined on unsupported platforms (Windows).
 */
function getSdkVendorPlatform(): string | undefined {
	const { platform, arch } = process;
	if (platform === 'win32') return undefined;
	const os = platform === 'darwin' ? 'darwin' : 'linux';
	const cpu = arch === 'arm64' ? 'arm64' : 'x64';
	return `${cpu}-${os}`;
}

/**
 * Common locations for a system-installed ripgrep binary.
 * Checked in order; the first existing path wins.
 */
const SYSTEM_RIPGREP_PATHS = [
	'/usr/bin/rg',
	'/usr/local/bin/rg',
	'/opt/homebrew/bin/rg',
	'/opt/homebrew/opt/ripgrep/bin/rg',
];

/**
 * Locate the system ripgrep executable, or return undefined if not found.
 *
 * Checks well-known install paths first; falls back to `which rg` for
 * non-standard installations (e.g. nix, asdf, custom prefix).
 */
function findSystemRipgrep(): string | undefined {
	for (const p of SYSTEM_RIPGREP_PATHS) {
		if (existsSync(p)) return p;
	}
	// Fallback: ask the shell where rg lives
	try {
		const result = execSync('which rg', { encoding: 'utf-8', timeout: 2000 }).trim();
		if (result && existsSync(result)) return result;
	} catch {
		// `which` not available or rg not found on PATH — ignore
	}
	return undefined;
}

/**
 * Copy the system ripgrep binary into the SDK's expected vendor directory.
 *
 * When the compiled binary extracts cli.js to extractDir, the SDK will look
 * for ripgrep at `<extractDir>/vendor/ripgrep/<platform>/rg`.  This function
 * copies the system-installed ripgrep binary there so that sandbox mode works
 * without needing the full vendor bundle embedded in the binary.
 *
 * We intentionally COPY (not symlink) the binary so that it is accessible
 * inside bubblewrap sandbox environments.  The SDK mounts the extract
 * directory into the sandbox, but the symlink target (e.g. /usr/bin/rg) may
 * live outside the sandbox mount and therefore appear as ENOENT.
 *
 * No-op if:
 *  - Platform is Windows (unsupported)
 *  - System ripgrep is not installed
 *  - The vendor binary already exists as a valid, non-empty regular file
 *
 * Replaces broken symlinks or empty files left by previous binary versions.
 */
function copySystemRipgrepToVendor(extractDir: string): void {
	const platform = getSdkVendorPlatform();
	if (!platform) return;

	const ripgrepDir = join(extractDir, 'vendor', 'ripgrep', platform);
	const ripgrepDest = join(ripgrepDir, 'rg');

	// Use lstatSync (not existsSync) so broken symlinks are detected — existsSync
	// follows symlinks and returns false for a dangling one, preventing re-creation.
	try {
		const stat = lstatSync(ripgrepDest);
		if (stat.isFile() && stat.size > 0) return; // Already a real, non-empty file
		// Broken symlink or zero-size file from a previous run — remove it so
		// copyFileSync can write to this path (on Linux, copying to a dangling
		// symlink target fails because the OS tries to dereference it).
		unlinkSync(ripgrepDest);
	} catch {
		// Path doesn't exist at all — proceed to copy
	}

	const systemRg = findSystemRipgrep();
	if (!systemRg) return;

	try {
		mkdirSync(ripgrepDir, { recursive: true });
		copyFileSync(systemRg, ripgrepDest);
		chmodSync(ripgrepDest, 0o755);
	} catch {
		// Race condition: another process created it, or filesystem error.
		// Silently ignore — the SDK will either find the binary or report its own error.
	}
}

/**
 * Reset module state for testing.
 * @public Exported for unit tests.
 */
export function _resetForTesting(): void {
	embeddedCliPath = undefined;
	cachedCliPath = undefined;
}

/**
 * Resolve the path to the Claude Code CLI bundled with the SDK.
 *
 * SDK ≥ 0.2.141 ships a native binary (e.g. `claude`); older versions
 * shipped `cli.js`. This function handles both.
 *
 * @returns Real filesystem path to the CLI, or undefined if not found
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
