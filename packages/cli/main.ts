#!/usr/bin/env bun
import { getConfig } from "@liuboer/daemon/config";

// Parse CLI arguments
interface CliOptions {
  port?: number;
  workspace?: string;
  host?: string;
  dbPath?: string;
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
  -h, --help                Show this help message

Examples:
  liuboer --port 9983 --workspace .
  liuboer -p 8080 -w /path/to/workspace
  liuboer --db-path /path/to/shared/daemon.db
`);
}

const cliOptions = parseArgs();

if (cliOptions.help) {
  printHelp();
  process.exit(0);
}

const isDev = process.env.NODE_ENV !== "production";
const config = getConfig(cliOptions);

console.log(`\n🚀 Liuboer ${isDev ? "Development" : "Production"} Server`);
console.log(`   Mode: ${config.nodeEnv}`);
console.log(`   Model: ${config.defaultModel}`);
console.log(`   Workspace: ${config.workspaceRoot}\n`);

if (isDev) {
  // Development mode: Vite dev server + Daemon
  const { startDevServer } = await import("./src/dev-server");
  await startDevServer(config);
} else {
  // Production mode: Static files + Daemon
  const { startProdServer } = await import("./src/prod-server");
  await startProdServer(config);
}
