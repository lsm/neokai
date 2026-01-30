/**
 * CLI argument parsing utilities
 * Extracted from main.ts for testability
 */

export interface CliOptions {
	port?: number;
	workspace?: string;
	host?: string;
	dbPath?: string;
	help?: boolean;
}

export interface ParseArgsResult {
	options: CliOptions;
	error?: string;
}

/**
 * Parse CLI arguments into options
 * Returns an error message instead of exiting for testability
 */
export function parseArgs(args: string[]): ParseArgsResult {
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
				return { options, error: `Invalid port value: ${portValue}` };
			}
		} else if (arg === '--workspace' || arg === '-w') {
			if (options.workspace) {
				options.help = true;
				return { options, error: `Workspace already set to: ${options.workspace}` };
			}
			options.workspace = args[++i];
			if (!options.workspace) {
				return { options, error: '--workspace requires a path' };
			}
		} else if (arg === '--host') {
			options.host = args[++i];
			if (!options.host) {
				return { options, error: '--host requires a value' };
			}
		} else if (arg === '--db-path') {
			options.dbPath = args[++i];
			if (!options.dbPath) {
				return { options, error: '--db-path requires a path' };
			}
		} else if (!arg.startsWith('-')) {
			// Positional argument: treat as workspace path
			if (options.workspace) {
				options.help = true;
				return { options, error: `Unexpected argument: ${arg} (workspace already set)` };
			}
			options.workspace = arg;
		} else {
			// Unknown option - set help flag and return error
			options.help = true;
			return { options, error: `Unknown option: ${arg}` };
		}
	}

	return { options };
}

/**
 * Get the help text for the CLI
 */
export function getHelpText(): string {
	return `
NeoKai - Claude Agent SDK Web Interface

Usage: kai [path] [options]

Arguments:
  path                      Workspace directory (default: current directory)

Options:
  -p, --port <port>         Port to listen on (default: 9283)
  -w, --workspace <path>    Alias for path argument
  --host <host>             Host to bind to (default: 0.0.0.0)
  --db-path <path>          Database file path (default: ./data/daemon.db)
  -h, --help                Show this help message

Environment Variables:
  NEOKAI_WORKSPACE_PATH    Workspace root directory (overridden by path/--workspace)

Examples:
  kai                           Start in current directory
  kai /path/to/project          Start with specific workspace
  kai . -p 8080                 Start on port 8080
  kai --db-path /shared/db.db   Use a shared database
`;
}

/**
 * Resolve default workspace path based on environment
 */
export function resolveDefaultWorkspace(
	nodeEnv: string,
	projectRoot: string,
	cwd: string,
	envWorkspacePath?: string
): string {
	// CLI or env workspace takes priority
	if (envWorkspacePath) {
		return envWorkspacePath;
	}

	const isDev = nodeEnv === 'development';
	if (isDev) {
		// Development: use project_root/tmp/workspace
		return `${projectRoot}/tmp/workspace`;
	}

	// Production/Test: use current working directory
	return cwd;
}

// ============================================================
// Server Utilities
// ============================================================

/**
 * CORS headers for preflight responses
 */
export const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
} as const;

/**
 * Create a CORS preflight response
 */
export function createCorsPreflightResponse(): Response {
	return new Response(null, { headers: CORS_HEADERS });
}

/**
 * Check if a file extension should have immutable cache headers
 * These are typically content-hashed assets
 */
export function shouldHaveImmutableCache(path: string): boolean {
	return /\.(js|css|woff2?|ttf|svg|png|jpg|jpeg|gif|ico)$/.test(path);
}

/**
 * Check if a path is an HTML file that should not be cached
 */
export function isHtmlFile(path: string): boolean {
	return path.endsWith('.html');
}

/**
 * Get appropriate cache control header for a static file
 */
export function getCacheControlHeader(path: string): string {
	if (shouldHaveImmutableCache(path)) {
		return 'public, max-age=31536000, immutable';
	}
	if (isHtmlFile(path)) {
		return 'no-cache';
	}
	// Default: short cache
	return 'public, max-age=3600';
}

/**
 * Check if a request path is the WebSocket endpoint
 */
export function isWebSocketPath(pathname: string): boolean {
	return pathname === '/ws';
}

/**
 * Create a JSON error response
 */
export function createJsonErrorResponse(message: string, status: number = 500): Response {
	return new Response(
		JSON.stringify({
			error: status >= 500 ? 'Internal server error' : 'Error',
			message,
		}),
		{
			status,
			headers: { 'Content-Type': 'application/json' },
		}
	);
}

/**
 * Find an available port by creating a temporary server
 * Uses Node.js net module to bind to port 0 (OS assigns available port)
 */
export async function findAvailablePort(): Promise<number> {
	// Import net dynamically to avoid issues in browser builds
	const net = await import('net');

	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.listen(0, () => {
			const address = server.address();
			if (address && typeof address === 'object') {
				const port = address.port;
				server.close(() => resolve(port));
			} else {
				server.close(() => reject(new Error('Failed to get port')));
			}
		});
		server.on('error', reject);
	});
}
