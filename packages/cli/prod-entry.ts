/**
 * Production entry point for compiled binary.
 * Does NOT import dev-server.ts or Vite — only production code.
 */

import { getConfig } from '@neokai/daemon/config';
import { parseArgs, getHelpText } from './src/cli-utils';
import { startProdServer } from './src/prod-server-embedded';

const { options: cliOptions, error } = parseArgs(process.argv.slice(2));

if (error) {
	console.error(`Error: ${error}`);
	if (!cliOptions.help) {
		process.exit(1);
	}
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

await startProdServer(config);
