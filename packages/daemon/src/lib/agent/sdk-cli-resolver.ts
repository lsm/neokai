/**
 * SDK CLI Path Resolver
 *
 * Resolves the path to the Claude Agent SDK's bundled CLI executable.
 *
 * Resolution priority:
 * 1. node_modules (dev mode) — the SDK's platform-specific optional dep
 * 2. Cache directory (~/.neokai/sdk/) — previously downloaded binary
 * 3. Auto-download — fetch the platform package from npm, extract, and cache
 *
 * In compiled binary mode (bun build --compile), the CLI is NOT embedded
 * to keep the binary small (~66 MB vs ~266 MB). Instead it's downloaded
 * on first use and cached for subsequent runs.
 */

import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	renameSync,
	unlinkSync,
} from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

/** Directory for cached SDK binaries: ~/.neokai/sdk/ */
const SDK_CACHE_DIR = join(homedir(), '.neokai', 'sdk');

/**
 * Detect whether the current Linux system uses musl libc (Alpine, etc.)
 * instead of glibc. Checks for the musl dynamic linker in /lib and /lib64.
 */
function isMusl(): boolean {
	if (process.platform !== 'linux') return false;
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

/** Cached resolved real filesystem path */
let cachedCliPath: string | undefined;

/**
 * Get the SDK version from the daemon's package.json.
 * Used to version the cache key and to know which package to download.
 */
function getSdkVersion(): string {
	try {
		// Read from the daemon package.json which has the SDK as a dependency
		const daemonPkgPath = join(
			dirname(fileURLToPath(import.meta.url)),
			'..',
			'..',
			'..',
			'..',
			'package.json'
		);
		const pkg = JSON.parse(require('fs').readFileSync(daemonPkgPath, 'utf-8'));
		const dep = pkg.dependencies?.[SDK_PACKAGE];
		if (dep) return dep.replace(/^(workspace:|npm:|\^|~)/, '');
	} catch {
		// Fallback for compiled binary where relative paths differ
	}
	// Hardcoded fallback — matches the version in daemon's package.json
	return '0.2.141';
}

/**
 * Get the cache path for the SDK binary.
 * Format: ~/.neokai/sdk/claude-<version>-<os>-<arch>[-musl]
 */
function getCachePath(): string {
	const platformPkg = getPlatformPackageName();
	if (!platformPkg) return '';
	const version = getSdkVersion();
	// Extract os-arch[-musl] from package name
	const platformPart = platformPkg.replace(`${SDK_PACKAGE}-`, '');
	const binaryName = getCliBinaryName();
	return join(SDK_CACHE_DIR, `claude-${version}-${platformPart}`, binaryName);
}

// ─── Resolution strategies ────────────────────────────────────────────────

/**
 * Try to resolve the CLI from node_modules (dev mode).
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
				const binPath = join(dirname(pkgPath), binaryName);
				if (existsSync(binPath)) return binPath;
			}
		} catch {
			// import.meta.resolve might not be available or package not installed
		}
	}

	// Strategy 2: Navigate from main SDK package to bun's hoisted platform binary.
	if (platformPkg) {
		try {
			const sdkModulePath = import.meta.resolve?.(SDK_PACKAGE);
			if (sdkModulePath) {
				const sdkPath = sdkModulePath.startsWith('file://')
					? fileURLToPath(sdkModulePath)
					: sdkModulePath;
				// Navigate up 5 levels to reach .bun directory
				const bunDir = dirname(dirname(dirname(dirname(dirname(sdkPath)))));
				const hoistedPath = join(bunDir, 'node_modules', platformPkg, binaryName);
				if (existsSync(hoistedPath)) return hoistedPath;
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
				if (existsSync(candidate)) return candidate;
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
			if (existsSync(cliPath)) return cliPath;
		}
	} catch {
		// import.meta.resolve might not be available
	}

	// Strategy 5: Walk up for legacy cli.js
	try {
		let currentDir = dirname(fileURLToPath(import.meta.url));
		for (let i = 0; i < 10; i++) {
			const candidate = join(currentDir, 'node_modules', SDK_PACKAGE, 'cli.js');
			if (existsSync(candidate)) return candidate;
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
 * Check the cache directory for a previously downloaded SDK binary.
 */
function resolveFromCache(): string | undefined {
	const cachePath = getCachePath();
	if (cachePath && existsSync(cachePath)) {
		// Verify it's a real file with content (not a broken symlink or empty file)
		try {
			const stat = lstatSync(cachePath);
			if (stat.isFile() && stat.size > 0) return cachePath;
		} catch {
			// Not accessible
		}
	}
	return undefined;
}

/**
 * Download the SDK platform package from npm, extract the binary, and cache it.
 *
 * Uses `npm pack` to download the tarball, then extracts the binary to the
 * cache directory. This avoids embedding the 200 MB binary in the compiled
 * NeoKai binary (reducing it from ~266 MB to ~66 MB).
 */
function downloadSdkBinary(): string | undefined {
	const platformPkg = getPlatformPackageName();
	if (!platformPkg) return undefined;

	const version = getSdkVersion();
	const cachePath = getCachePath();
	if (!cachePath) return undefined;

	const binaryName = getCliBinaryName();
	const cacheDir = dirname(cachePath);

	try {
		// Create a temp directory for the download
		const tmpDir = join(tmpdir(), `neokai-sdk-download-${Date.now()}`);
		mkdirSync(tmpDir, { recursive: true });

		// Download the package tarball using npm pack
		const tarball = execSync(`npm pack ${platformPkg}@${version} --pack-destination "${tmpDir}"`, {
			encoding: 'utf-8',
			timeout: 120_000,
			stdio: ['pipe', 'pipe', 'pipe'],
		}).trim();

		const tarballPath = join(tmpDir, tarball);

		// Extract the binary from the tarball
		// npm tarballs have the structure: package/<binary-name>
		const extractDir = join(tmpDir, 'extracted');
		mkdirSync(extractDir, { recursive: true });

		execSync(`tar -xzf "${tarballPath}" -C "${extractDir}"`, {
			timeout: 30_000,
			stdio: 'pipe',
		});

		// Find the binary in the extracted package
		const extractedBinary = join(extractDir, 'package', binaryName);
		if (!existsSync(extractedBinary)) {
			// Clean up
			try {
				unlinkSync(tarballPath);
			} catch {}
			return undefined;
		}

		// Move to cache
		mkdirSync(cacheDir, { recursive: true });
		renameSync(extractedBinary, cachePath);
		chmodSync(cachePath, 0o755);

		// Copy ripgrep vendor binary for sandbox mode
		copySystemRipgrepToVendor(cacheDir);

		// Clean up temp directory
		try {
			const { rmSync } = require('node:fs');
			rmSync(tmpDir, { recursive: true });
		} catch {}

		return cachePath;
	} catch {
		return undefined;
	}
}

// ─── Ripgrep vendor support ───────────────────────────────────────────────

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

const SYSTEM_RIPGREP_PATHS = [
	'/usr/bin/rg',
	'/usr/local/bin/rg',
	'/opt/homebrew/bin/rg',
	'/opt/homebrew/opt/ripgrep/bin/rg',
];

function findSystemRipgrep(): string | undefined {
	for (const p of SYSTEM_RIPGREP_PATHS) {
		if (existsSync(p)) return p;
	}
	try {
		const result = execSync('which rg', { encoding: 'utf-8', timeout: 2000 }).trim();
		if (result && existsSync(result)) return result;
	} catch {}
	return undefined;
}

/**
 * Copy the system ripgrep binary into the SDK's expected vendor directory.
 */
function copySystemRipgrepToVendor(cliDir: string): void {
	const platform = getSdkVendorPlatform();
	if (!platform) return;

	const ripgrepDir = join(cliDir, 'vendor', 'ripgrep', platform);
	const ripgrepDest = join(ripgrepDir, 'rg');

	try {
		const stat = lstatSync(ripgrepDest);
		if (stat.isFile() && stat.size > 0) return;
		unlinkSync(ripgrepDest);
	} catch {}

	const systemRg = findSystemRipgrep();
	if (!systemRg) return;

	try {
		mkdirSync(ripgrepDir, { recursive: true });
		copyFileSync(systemRg, ripgrepDest);
		chmodSync(ripgrepDest, 0o755);
	} catch {}
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Reset module state for testing.
 * @public Exported for unit tests.
 */
export function _resetForTesting(): void {
	cachedCliPath = undefined;
}

/**
 * Resolve the path to the Claude Code CLI bundled with the SDK.
 *
 * Resolution priority:
 * 1. node_modules (dev mode)
 * 2. Cache directory (~/.neokai/sdk/) — previously downloaded
 * 3. Auto-download from npm — fetch, extract, and cache
 *
 * @returns Real filesystem path to the CLI, or undefined if not found
 */
export function resolveSDKCliPath(): string | undefined {
	if (cachedCliPath !== undefined) return cachedCliPath;

	// Priority 1: Resolve from node_modules (dev mode)
	const nodeModulesPath = resolveFromNodeModules();
	if (nodeModulesPath) {
		cachedCliPath = nodeModulesPath;
		return cachedCliPath;
	}

	// Priority 2: Check cache
	const cachedPath = resolveFromCache();
	if (cachedPath) {
		cachedCliPath = cachedPath;
		return cachedCliPath;
	}

	// Priority 3: Auto-download
	const downloadedPath = downloadSdkBinary();
	if (downloadedPath) {
		cachedCliPath = downloadedPath;
		return cachedCliPath;
	}

	return undefined;
}
