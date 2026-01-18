#!/usr/bin/env bun
import { getConfig } from '@liuboer/daemon/config';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Parse CLI arguments
interface CliOptions {
	port?: number;
	workspace?: string;
	host?: string;
	dbPath?: string;
	ipcSocket?: string;
	help?: boolean;
}

function parseArgs(): CliOptions {
	const args = process.argv.slice(2);
	const options: CliOptions = {};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === '--help' || arg === '-h') {
			options.help = true;
		} else if (arg === '--port' || arg === '-p') {
			const portValue = args[++i];
			if (portValue && !isNaN(Number(portValue))) {
				options.port = parseInt(portValue, 10);
			} else {
				console.error(`Error: Invalid port value: ${portValue}`);
				process.exit(1);
			}
		} else if (arg === '--workspace' || arg === '-w') {
			options.workspace = args[++i];
			if (!options.workspace) {
				console.error('Error: --workspace requires a path');
				process.exit(1);
			}
		} else if (arg === '--host') {
			options.host = args[++i];
			if (!options.host) {
				console.error('Error: --host requires a value');
				process.exit(1);
			}
		} else if (arg === '--db-path') {
			options.dbPath = args[++i];
			if (!options.dbPath) {
				console.error('Error: --db-path requires a path');
				process.exit(1);
			}
		} else if (arg === '--ipc-socket') {
			options.ipcSocket = args[++i];
			if (!options.ipcSocket) {
				console.error('Error: --ipc-socket requires a path');
				process.exit(1);
			}
		} else {
			console.error(`Error: Unknown option: ${arg}`);
			options.help = true;
		}
	}

	return options;
}

function printHelp() {
	console.log(`
Liuboer - Claude Agent SDK Web Interface

Usage: liuboer [options]

Options:
  -p, --port <port>         Port to listen on (default: 9283)
  -w, --workspace <path>    Workspace root directory (default: tmp/workspace in dev, cwd in prod)
  --host <host>             Host to bind to (default: 0.0.0.0)
  --db-path <path>          Database file path (default: ./data/daemon.db)
  --ipc-socket <path>       Unix socket path for IPC (enables yuanshen orchestrator connection)
  -h, --help                Show this help message

Environment Variables:
  LIUBOER_WORKSPACE_PATH    Workspace root directory (overridden by --workspace flag)

Examples:
  liuboer --port 9983 --workspace .
  liuboer -p 8080 -w /path/to/workspace
  liuboer --db-path /path/to/shared/daemon.db
  LIUBOER_WORKSPACE_PATH=/my/workspace liuboer
`);
}

const cliOptions = parseArgs();

if (cliOptions.help) {
	printHelp();
	process.exit(0);
}

const nodeEnv = process.env.NODE_ENV || 'development';
const isDev = nodeEnv === 'development';
const isTest = nodeEnv === 'test';

// Provide default workspace if not specified via CLI or LIUBOER_WORKSPACE_PATH env var
if (!cliOptions.workspace && !process.env.LIUBOER_WORKSPACE_PATH) {
	if (isDev) {
		// Development: use project_root/tmp/workspace
		const __filename = fileURLToPath(import.meta.url);
		const __dirname = dirname(__filename);
		const projectRoot = join(__dirname, '..', '..');
		cliOptions.workspace = join(projectRoot, 'tmp', 'workspace');
	} else {
		// Production/Test: use current working directory
		cliOptions.workspace = process.cwd();
	}
}

const config = getConfig(cliOptions);

const serverMode = isDev ? 'Development' : isTest ? 'Test' : 'Production';
console.log(`\n🚀 Liuboer ${serverMode} Server`);
console.log(`   Mode: ${config.nodeEnv}`);
console.log(`   Model: ${config.defaultModel}`);
console.log(`   Workspace: ${config.workspaceRoot}\n`);

if (isDev) {
	// Development mode: Vite dev server + Daemon (for local development with HMR)
	const { startDevServer } = await import('./src/dev-server');
	await startDevServer(config);
} else {
	// Production/Test mode: Static files + Daemon (production-like, no HMR)
	const { startProdServer } = await import('./src/prod-server');
	await startProdServer(config);
}
