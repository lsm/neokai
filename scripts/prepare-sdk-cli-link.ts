/**
 * Prepares the SDK CLI symlink for compiled binary builds.
 *
 * SDK ≥ 0.2.141 ships native CLI binaries via platform-specific packages
 * (e.g. `@anthropic-ai/claude-agent-sdk-darwin-x64/claude`). The compiled
 * binary entry point (`packages/cli/prod-entry.ts`) imports this file with
 * `{ type: 'file' }` so Bun embeds it in the virtual filesystem.
 *
 * This script creates a symlink at `packages/daemon/.embedded-sdk-cli`
 * pointing to the correct native binary for the given build target.
 *
 * Usage:
 *   bun run scripts/prepare-sdk-cli-link.ts                          # auto-detect host platform
 *   bun run scripts/prepare-sdk-cli-link.ts --target bun-linux-x64   # explicit target
 *
 * Called by:
 *   - CI workflows (.github/workflows/main.yml, release.yml, real-api-tests.yml)
 *   - scripts/build-binary.ts
 */

import { existsSync, readdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const EMBEDDED_CLI_LINK = join(ROOT, 'packages', 'daemon', '.embedded-sdk-cli');

/**
 * Detect musl libc by checking for the musl dynamic linker.
 */
function isMusl(): boolean {
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
 * Parse a bun build target (e.g. "bun-linux-x64", "bun-linux-x64-musl") into
 * platform/arch components. Falls back to the host platform if no target is
 * specified.
 */
function parseTarget(target?: string): { os: string; arch: string; musl: boolean } {
	if (target) {
		// target format: "bun-{os}-{arch}[-musl]"
		// Bun uses "windows" but the SDK packages use "win32"
		const parts = target.replace('bun-', '').split('-');
		const os = parts[0] === 'windows' ? 'win32' : parts[0]; // win32, darwin, linux
		const arch = parts[1]; // x64, arm64
		// Explicit target is authoritative: only use -musl when the suffix
		// is present in the target string. Host musl detection only applies
		// to the auto-detect (no --target) path below.
		const musl = parts[2] === 'musl';
		return { os, arch, musl };
	}
	// Auto-detect from host
	const { platform, arch: hostArch } = process;
	return {
		os: platform === 'win32' ? 'win32' : platform,
		arch: hostArch,
		musl: platform === 'linux' && isMusl(),
	};
}

/**
 * Build the platform-specific SDK package name.
 */
function getSdkPlatformPackage(os: string, arch: string, musl: boolean): string {
	const muslSuffix = musl ? '-musl' : '';
	return `@anthropic-ai/claude-agent-sdk-${os}-${arch}${muslSuffix}`;
}

/**
 * Resolve the SDK's native CLI binary path from bun's module layout.
 *
 * Uses `createRequire` from the daemon package (which depends on the SDK)
 * so that `require.resolve` finds the SDK regardless of where this script
 * is invoked from.
 */
function resolveSdkBinary(os: string, arch: string, musl: boolean): string | undefined {
	const binaryName = os === 'win32' ? 'claude.exe' : 'claude';
	const pkgName = getSdkPlatformPackage(os, arch, musl);

	// Strategy 1: Use createRequire from daemon package to resolve SDK,
	// then navigate to bun's hoisted node_modules for the platform binary.
	try {
		const { createRequire } = require('node:module') as typeof import('node:module');
		const daemonEntry = join(ROOT, 'packages', 'daemon', 'main.ts');
		const daemonRequire = createRequire(daemonEntry);
		const sdkPath = daemonRequire.resolve('@anthropic-ai/claude-agent-sdk');
		// sdkPath = .../node_modules/.bun/@anthropic-ai+claude-agent-sdk@.../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
		// Navigate up 5 levels to reach .bun, then look in .bun/node_modules/<pkg>
		const bunDir = dirname(dirname(dirname(dirname(dirname(sdkPath)))));
		const hoistedPath = join(bunDir, 'node_modules', pkgName, binaryName);
		if (existsSync(hoistedPath)) return hoistedPath;
	} catch {
		// createRequire or resolution failed
	}

	// Strategy 2: Walk up from ROOT to find standard node_modules
	{
		const candidate = join(ROOT, 'node_modules', pkgName, binaryName);
		if (existsSync(candidate)) return candidate;
	}

	// Strategy 3: Walk up from daemon package
	{
		let currentDir = join(ROOT, 'packages', 'daemon');
		for (let i = 0; i < 10; i++) {
			const candidate = join(currentDir, 'node_modules', pkgName, binaryName);
			if (existsSync(candidate)) return candidate;
			const parentDir = dirname(currentDir);
			if (parentDir === currentDir) break;
			currentDir = parentDir;
		}
	}

	return undefined;
}

// Parse --target argument
const targetIdx = process.argv.indexOf('--target');
const targetArg = targetIdx !== -1 ? process.argv[targetIdx + 1] : null;

const { os, arch, musl } = parseTarget(targetArg ?? undefined);
const pkgName = getSdkPlatformPackage(os, arch, musl);
const binaryPath = resolveSdkBinary(os, arch, musl);

// Clean up any existing link
try {
	unlinkSync(EMBEDDED_CLI_LINK);
} catch {
	// Doesn't exist
}

if (binaryPath) {
	symlinkSync(binaryPath, EMBEDDED_CLI_LINK);
	console.log(`SDK CLI linked: ${pkgName} -> ${binaryPath}`);
} else {
	console.error(`Error: SDK native binary not found for ${pkgName}.`);
	console.error('The compile will fail because prod-entry.ts requires an embedded CLI.');
	console.error('Ensure the correct platform-specific SDK package is installed:');
	console.error(`  bun add -d ${pkgName}`);
	process.exit(1);
}
