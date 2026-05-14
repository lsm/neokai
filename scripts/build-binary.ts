/**
 * Orchestrates the full binary build pipeline:
 * 1. Build web frontend (Vite)
 * 2. Generate embedded assets module
 * 3. Resolve SDK native CLI binary for embedding
 * 4. Compile binary with bun build --compile
 *
 * Usage:
 *   bun run scripts/build-binary.ts                         # All platforms
 *   bun run scripts/build-binary.ts --target bun-darwin-arm64  # Single platform
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(import.meta.dir, '..');
const OUTPUT_DIR = join(ROOT, 'dist', 'bin');
const EMBEDDED_CLI_LINK = join(ROOT, 'packages', 'daemon', '.embedded-sdk-cli');

const ALL_TARGETS = [
	'bun-darwin-arm64',
	'bun-darwin-x64',
	'bun-linux-x64',
	'bun-linux-arm64',
	'bun-windows-x64',
];

// Parse --target argument
const targetIdx = process.argv.indexOf('--target');
const targetArg = targetIdx !== -1 ? process.argv[targetIdx + 1] : null;

if (targetArg && !ALL_TARGETS.includes(targetArg)) {
	console.error(`Unknown target: ${targetArg}`);
	console.error(`Valid targets: ${ALL_TARGETS.join(', ')}`);
	process.exit(1);
}

const targets = targetArg ? [targetArg] : ALL_TARGETS;

function run(cmd: string) {
	execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
}

/**
 * Resolve the SDK's native CLI binary path from bun's module layout.
 * The main SDK package is at node_modules/.bun/@anthropic-ai+claude-agent-sdk@.../
 * and platform-specific binaries are symlinked at node_modules/.bun/node_modules/.
 */
function resolveSdkNativeBinary(): string | undefined {
	const { platform, arch } = process;
	const binaryName = platform === 'win32' ? 'claude.exe' : 'claude';

	// Build platform package name (without musl detection — build host uses its own libc)
	const os = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux';
	const pkgName = `@anthropic-ai/claude-agent-sdk-${os}-${arch}`;

	// Resolve main SDK package to navigate to bun's hoisted modules
	try {
		const sdkModulePath = import.meta.resolve('@anthropic-ai/claude-agent-sdk');
		const sdkPath = sdkModulePath.startsWith('file://')
			? fileURLToPath(sdkModulePath)
			: sdkModulePath;
		// Navigate up 4 levels: @anthropic-ai/claude-agent-sdk -> node_modules -> @anthropic-ai+... -> .bun
		const bunDir = dirname(dirname(dirname(dirname(sdkPath))));
		const hoistedPath = join(bunDir, 'node_modules', pkgName, binaryName);
		if (existsSync(hoistedPath)) return hoistedPath;
	} catch {
		// import.meta.resolve failed
	}
	return undefined;
}

// Step 1: Build web frontend
console.log('Step 1: Building web frontend...\n');
run('cd packages/web && bun run build');

// Step 2: Generate embedded assets
console.log('\nStep 2: Generating embedded assets...\n');
run('bun run scripts/generate-embedded-assets.ts');

// Step 3: Resolve SDK native CLI for embedding
console.log('\nStep 3: Resolving SDK native CLI binary...\n');
const nativeBinaryPath = resolveSdkNativeBinary();
if (nativeBinaryPath) {
	// Create a symlink at a known location for prod-entry.ts to import
	try {
		unlinkSync(EMBEDDED_CLI_LINK);
	} catch {
		// File doesn't exist, that's fine
	}
	symlinkSync(nativeBinaryPath, EMBEDDED_CLI_LINK);
	console.log(`  Linked: ${EMBEDDED_CLI_LINK} -> ${nativeBinaryPath}`);
} else {
	console.warn('  Warning: Could not resolve SDK native CLI binary.');
	console.warn('  The compiled binary will not have an embedded CLI.');
	console.warn('  The runtime resolver will attempt to find it at startup.');
}

// Step 4: Compile binaries
mkdirSync(OUTPUT_DIR, { recursive: true });

for (const target of targets) {
	const platformArch = target.replace('bun-', '');
	const outputPath = join(OUTPUT_DIR, `kai-${platformArch}`);

	console.log(`\nStep 4: Compiling binary for ${target}...`);
	run(`bun build --compile --target=${target} --outfile=${outputPath} packages/cli/prod-entry.ts`);
	console.log(`  -> ${outputPath}`);
}

// Clean up the symlink
try {
	unlinkSync(EMBEDDED_CLI_LINK);
} catch {
	// Already gone
}

console.log('\nBuild complete!');
