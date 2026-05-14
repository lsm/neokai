/**
 * Production entry point for compiled binary.
 * Does NOT import dev-server.ts or Vite — only production code.
 */

import { getConfig } from '@neokai/daemon/config';
import { parseArgs, getHelpText } from './src/cli-utils';
import { startProdServer } from './src/prod-server-embedded';
import { version } from './package.json';

// Embed the Claude Agent SDK's native CLI binary into the compiled binary.
// The { type: "file" } attribute tells Bun to include this file in its
// virtual filesystem (/$bunfs/root/), making it accessible at runtime.
// Without this, the SDK cannot find its CLI executable in bundled binaries.
//
// SDK ≥ 0.2.141 ships platform-specific native binaries instead of cli.js.
// The build script (scripts/build-binary.ts) creates a symlink at
// packages/daemon/.embedded-sdk-cli pointing to the native binary for the
// current platform before invoking bun build --compile.
//
// @ts-ignore -- Bun-specific import attribute; file only exists during builds
import embeddedSdkCliPath from '../daemon/.embedded-sdk-cli' with { type: 'file' };
import { setEmbeddedCliPath } from '@neokai/daemon/sdk-cli-resolver';
setEmbeddedCliPath(embeddedSdkCliPath);

// Handle uncaught errors to prevent silent crashes
process.on('unhandledRejection', (reason, promise) => {
	console.error('[Fatal] Unhandled Promise Rejection:', reason);
	console.error('Promise:', promise);
	process.exit(1);
});

process.on('uncaughtException', (error) => {
	console.error('[Fatal] Uncaught Exception:', error);
	process.exit(1);
});

const { options: cliOptions, error } = parseArgs(process.argv.slice(2));

if (error) {
	console.error(`Error: ${error}`);
	if (!cliOptions.help) {
		process.exit(1);
	}
}

if (cliOptions.version) {
	console.log(version);
	process.exit(0);
}

if (cliOptions.help) {
	console.log(getHelpText());
	process.exit(0);
}

// Production binary always runs in production mode
process.env.NODE_ENV = 'production';

const config = getConfig(cliOptions);

console.log(`\nNeoKai Server`);
console.log(`   Database: ${config.dbPath}\n`);

try {
	await startProdServer(config);
} catch (error) {
	console.error('[Fatal] Server startup failed:', error);
	process.exit(1);
}
