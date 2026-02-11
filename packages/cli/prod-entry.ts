/**
 * Production entry point for compiled binary.
 * Does NOT import dev-server.ts or Vite — only production code.
 */

import { getConfig } from '@neokai/daemon/config';
import { parseArgs, getHelpText } from './src/cli-utils';
import { startProdServer } from './src/prod-server-embedded';
import { version } from './package.json';

// Embed the Claude Agent SDK's CLI into the compiled binary.
// The { type: "file" } attribute tells Bun to include this file in its
// virtual filesystem (/$bunfs/root/), making it accessible at runtime.
// Without this, the SDK cannot find its CLI executable in bundled binaries.
// @ts-ignore -- Bun-specific import attribute
import embeddedSdkCliPath from '../daemon/node_modules/@anthropic-ai/claude-agent-sdk/cli.js' with {
	type: 'file',
};
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

if (!cliOptions.workspace && !process.env.NEOKAI_WORKSPACE_PATH) {
	cliOptions.workspace = process.cwd();
}

const config = getConfig(cliOptions);

console.log(`\nNeoKai Server`);
console.log(`   Workspace: ${config.workspaceRoot}\n`);

try {
	await startProdServer(config);
} catch (error) {
	console.error('[Fatal] Server startup failed:', error);
	process.exit(1);
}
