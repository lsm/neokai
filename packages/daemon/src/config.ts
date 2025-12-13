import { config } from 'dotenv';
import { join } from 'path';

// Load environment variables from .env file in the current working directory
// This allows each instance (dev, self-hosting, production) to have its own configuration
config({ path: join(process.cwd(), '.env') });

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
}

export interface ConfigOverrides {
	port?: number;
	host?: string;
	workspace?: string;
	dbPath?: string;
}

export function getConfig(overrides?: ConfigOverrides): Config {
	const nodeEnv = process.env.NODE_ENV || 'development';

	// Workspace root MUST be explicitly provided via CLI --workspace flag
	// No fallback to relative paths - this ensures correct behavior in all environments
	let workspaceRoot: string;
	if (overrides?.workspace) {
		// CLI override (required for dev/production)
		workspaceRoot = overrides.workspace;
	} else if (nodeEnv === 'test') {
		// Test mode: use a temp directory that will be cleaned up
		// This is the only case where we compute a path, as it's controlled test env
		const projectRoot = join(__dirname, '..', '..', '..');
		workspaceRoot = join(projectRoot, 'tmp', 'workspace');
	} else {
		// No workspace provided - this is an error in dev/production
		throw new Error(
			'Workspace path must be explicitly provided via --workspace flag. ' +
				'Do not rely on automatic path detection.'
		);
	}

	return {
		port: overrides?.port ?? parseInt(process.env.PORT || '9283'),
		host: overrides?.host ?? (process.env.HOST || '0.0.0.0'),
		dbPath: overrides?.dbPath ?? (process.env.DB_PATH || './data/daemon.db'),
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
	};
}
