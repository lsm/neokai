/**
 * Standalone daemon server for online daemon tests
 *
 * This server runs as a separate process for true process isolation.
 * Used for online tests that need to verify real WebSocket communication.
 *
 * CREDENTIAL HANDLING:
 * - Supports GLM_API_KEY (sets ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL)
 * - Supports CLAUDE_CODE_OAUTH_TOKEN
 * - Supports ANTHROPIC_API_KEY
 *
 * The SDK reads these environment variables directly, so we set them here
 * before importing createDaemonApp (which initializes the SDK).
 */

const PORT = parseInt(process.env.PORT || '19400', 10);

// Handle GLM credentials - tests set GLM_API_KEY or environment variables
// We need to set ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL for the SDK
const GLM_API_KEY = process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY;
const ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;

// If GLM credentials are set via ANTHROPIC_AUTH_TOKEN (test pattern),
// they're already set in the environment, so we don't need to do anything.
//
// If GLM_API_KEY is set directly (CI pattern), set up the GLM environment
// for the SDK to read.
if (GLM_API_KEY && !ANTHROPIC_AUTH_TOKEN && !ANTHROPIC_BASE_URL) {
	process.env.ANTHROPIC_AUTH_TOKEN = GLM_API_KEY;
	process.env.ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';
	process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'glm-4.5-air';
	process.env.API_TIMEOUT_MS = '3000000';
}

// Now import createDaemonApp - it will pick up the environment variables we just set
import { createDaemonApp } from '../../../src/app';

async function main() {
	const { cleanup } = await createDaemonApp({
		config: {
			host: '127.0.0.1',
			port: PORT,
			defaultModel: 'claude-sonnet-4.5-20250929',
			maxTokens: 8192,
			temperature: 1.0,
			anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
			claudeCodeOAuthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
			dbPath: ':memory:',
			maxSessions: 10,
			nodeEnv: 'test',
			workspaceRoot: `${process.env.TMPDIR || '/tmp'}/liuboer-daemon-test-${Date.now()}`,
			disableWorktrees: true,
		},
		standalone: true,
	});

	// Handle graceful shutdown on SIGINT
	process.on('SIGINT', async () => {
		console.error('[DAEMON-SERVER] Received SIGINT, cleaning up...');
		await cleanup();
		console.error('[DAEMON-SERVER] Cleanup complete, exiting...');
		process.exit(0);
	});

	// Also handle SIGTERM for cleanup
	process.on('SIGTERM', async () => {
		console.error('[DAEMON-SERVER] Received SIGTERM, cleaning up...');
		await cleanup();
		console.error('[DAEMON-SERVER] Cleanup complete, exiting...');
		process.exit(0);
	});

	console.error(`[DAEMON-SERVER] Running on port ${PORT}, PID: ${process.pid}`);
}

main().catch((error) => {
	console.error('[DAEMON-SERVER] Fatal error:', error);
	process.exit(1);
});
