import { join } from 'path';
import { homedir } from 'os';

// Bun automatically loads .env files from the current working directory at startup
// Files loaded: .env, .env.local (later files override earlier)
// No dotenv package needed - this is built into Bun runtime

// Discover credentials from Claude Code storage and ~/.claude/settings.json
// This enriches process.env BEFORE any other code reads it.
// Never overwrites existing env vars (explicit config always wins).
import { discoverCredentials } from './lib/credential-discovery';

// Discover credentials and enrich process.env at module load time
discoverCredentials();

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
	anthropicAuthToken?: string; // Bearer token for third-party proxies
	defaultModel: string;
	maxTokens: number;
	temperature: number;
	maxSessions: number;
	nodeEnv: string;
	workspaceRoot?: string;
	disableWorktrees?: boolean; // For testing - disables git worktree creation
	disableGoalProcessing?: boolean; // For testing/CI - disables automatic goal processing (tick loop)
	// GitHub integration
	githubWebhookSecret?: string; // Secret for verifying webhook signatures
	githubPollingInterval?: number; // Polling interval in seconds (0 = disabled)
	githubDefaultFilter?: string; // Default filter config as JSON string
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
	// 2. NEOKAI_WORKSPACE_PATH environment variable
	// 3. undefined — daemon can start without a workspace (e.g. headless/API-only mode)
	let workspaceRoot: string | undefined;
	if (overrides?.workspace) {
		// CLI override has highest priority
		workspaceRoot = overrides.workspace;
	} else if (process.env.NEOKAI_WORKSPACE_PATH) {
		// Environment variable
		workspaceRoot = process.env.NEOKAI_WORKSPACE_PATH;
	} else {
		// No workspace provided — this is intentionally allowed.
		// The daemon can operate without a global workspace root; rooms provide
		// their own defaultPath for all room-scoped operations.
		workspaceRoot = undefined;
	}

	// Default database path:
	//   - With workspace: ~/.neokai/projects/{encoded-workspace-path}/database/daemon.db
	//     (each workspace gets its own isolated database)
	//   - Without workspace: ~/.neokai/data/daemon.db
	//     (global fallback that does not collide with any workspace-derived path)
	const defaultDbPath =
		workspaceRoot !== undefined
			? join(
					homedir(),
					'.neokai',
					'projects',
					encodeRepoPath(workspaceRoot),
					'database',
					'daemon.db'
				)
			: join(homedir(), '.neokai', 'data', 'daemon.db');

	return {
		port: overrides?.port ?? parseInt(process.env.NEOKAI_PORT || '9283'),
		host: overrides?.host ?? (process.env.HOST || '0.0.0.0'),
		dbPath: overrides?.dbPath ?? (process.env.DB_PATH || defaultDbPath),
		anthropicApiKey: process.env.ANTHROPIC_API_KEY,
		claudeCodeOAuthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
		anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN,
		// Use 'default' which maps to Sonnet 4.5 in the SDK
		// This matches the SDK's supportedModels() response
		defaultModel: process.env.DEFAULT_MODEL || 'default',
		maxTokens: parseInt(process.env.MAX_TOKENS || '8192'),
		temperature: parseFloat(process.env.TEMPERATURE || '1.0'),
		maxSessions: parseInt(process.env.MAX_SESSIONS || '10'),
		nodeEnv,
		workspaceRoot,
		disableWorktrees: process.env.NEOKAI_DISABLE_WORKTREES === '1',
		disableGoalProcessing: process.env.NEOKAI_DISABLE_GOAL_PROCESSING === '1',
		// GitHub integration
		githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
		githubPollingInterval: parseInt(process.env.GITHUB_POLLING_INTERVAL || '0'),
		githubDefaultFilter: process.env.GITHUB_DEFAULT_FILTER,
	};
}
