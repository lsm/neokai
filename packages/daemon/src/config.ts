import { config } from 'dotenv';
import { join } from 'path';
import { homedir } from 'os';

// Load environment variables from .env file in the current working directory
// This allows each instance (dev, self-hosting, production) to have its own configuration
config({ path: join(process.cwd(), '.env') });

/**
 * Encode an absolute path to a filesystem-safe directory name
 * Uses the same approach as Claude Code (~/.claude/projects/)
 */
function encodeRepoPath(repoPath: string): string {
	// Normalize path separators (handle both Unix and Windows)
	const normalizedPath = repoPath.replace(/\\/g, '/');

	// Strip leading slash (if any) and replace remaining slashes with dashes
	// Then prepend a dash to indicate it was an absolute path
	const encoded = normalizedPath.startsWith('/')
		? '-' + normalizedPath.slice(1).replace(/\//g, '-')
		: '-' + normalizedPath.replace(/\//g, '-');

	return encoded;
}

export interface Config {
	port: number;
	host: string;
	dbPath: string;
	anthropicApiKey?: string; // Optional - can use CLAUDE_CODE_OAUTH_TOKEN instead
	claudeCodeOAuthToken?: string; // Long-lived OAuth token
	defaultModel: string;
	maxTokens: number;
	temperature: number;
	maxSessions: number;
	nodeEnv: string;
	workspaceRoot: string;
	disableWorktrees?: boolean; // For testing - disables git worktree creation
	ipcSocketPath?: string; // Optional IPC socket path for yuanshen orchestrator
}

export interface ConfigOverrides {
	port?: number;
	host?: string;
	workspace?: string;
	dbPath?: string;
}

export function getConfig(overrides?: ConfigOverrides): Config {
	const nodeEnv = process.env.NODE_ENV || 'development';

	// Workspace root priority:
	// 1. CLI --workspace flag (overrides parameter)
	// 2. LIUBOER_WORKSPACE_PATH environment variable
	// Note: No default fallback - caller (CLI package) must provide workspace path
	let workspaceRoot: string;
	if (overrides?.workspace) {
		// CLI override has highest priority
		workspaceRoot = overrides.workspace;
	} else if (process.env.LIUBOER_WORKSPACE_PATH) {
		// Environment variable
		workspaceRoot = process.env.LIUBOER_WORKSPACE_PATH;
	} else {
		// No workspace provided - this is an error
		throw new Error(
			'Workspace path must be explicitly provided via --workspace flag or LIUBOER_WORKSPACE_PATH environment variable. ' +
				'The daemon does not provide default workspace paths.'
		);
	}

	// Default database path: ~/.liuboer/projects/{encoded-workspace-path}/database/daemon.db
	// This ensures each workspace/project gets its own isolated database
	const defaultDbPath = join(
		homedir(),
		'.liuboer',
		'projects',
		encodeRepoPath(workspaceRoot),
		'database',
		'daemon.db'
	);

	return {
		port: overrides?.port ?? parseInt(process.env.PORT || '9283'),
		host: overrides?.host ?? (process.env.HOST || '0.0.0.0'),
		dbPath: overrides?.dbPath ?? (process.env.DB_PATH || defaultDbPath),
		anthropicApiKey: process.env.ANTHROPIC_API_KEY,
		claudeCodeOAuthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
		// Use 'default' which maps to Sonnet 4.5 in the SDK
		// This matches the SDK's supportedModels() response
		defaultModel: process.env.DEFAULT_MODEL || 'default',
		maxTokens: parseInt(process.env.MAX_TOKENS || '8192'),
		temperature: parseFloat(process.env.TEMPERATURE || '1.0'),
		maxSessions: parseInt(process.env.MAX_SESSIONS || '10'),
		nodeEnv,
		workspaceRoot,
		ipcSocketPath: process.env.IPC_SOCKET_PATH,
	};
}
