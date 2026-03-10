/**
 * Global Setup - Runs BEFORE all tests
 * Ensures clean state to prevent nested worktrees
 */

import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { existsSync, rmSync, readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function globalSetup() {
	// Safety check: Prevent running E2E tests when a dev server is running without
	// pointing tests at it. Skip when E2E_PORT is set (standalone random-port mode)
	// or when PLAYWRIGHT_BASE_URL is already set (external server mode).
	if (!process.env.PLAYWRIGHT_BASE_URL && !process.env.E2E_PORT) {
		let currentDir = __dirname;
		for (let i = 0; i < 5; i++) {
			const lockFile = join(currentDir, 'tmp', '.dev-server-running');
			if (existsSync(lockFile)) {
				const port = readFileSync(lockFile, 'utf-8').trim();
				console.error(`
ERROR: A development server appears to be running (lock file found).

To run E2E tests with an auto-started server on a random port, use:
  make run-e2e TEST=tests/your-test.e2e.ts

To run against your existing dev server, use:
  make self-test TEST=tests/your-test.e2e.ts     (for 'make self' on port 9983)

Or set PLAYWRIGHT_BASE_URL explicitly:
  PLAYWRIGHT_BASE_URL=http://localhost:${port || 'YOUR_PORT'} bunx playwright test tests/your-test.e2e.ts
`);
				process.exit(1);
			}
			const parentDir = dirname(currentDir);
			if (parentDir === currentDir) break;
			currentDir = parentDir;
		}
	}

	// Skip cleanup in CI - handled by fresh checkout each time
	if (process.env.CI) {
		console.log('\n🔵 CI environment detected - skipping worktree cleanup\n');
		return;
	}

	console.log('\n🧹 Pre-Test Cleanup (preventing nested worktrees)');
	console.log('================================================\n');

	try {
		const projectRoot = join(__dirname, '..', '..');
		const worktreesDir = join(projectRoot, '.worktrees');

		if (!existsSync(worktreesDir)) {
			console.log('✅ Clean state - no .worktrees directory\n');
			return;
		}

		const worktrees = readdirSync(worktreesDir);
		console.log(`⚠️  Found ${worktrees.length} existing worktree(s) - cleaning...`);

		// Prune git metadata
		execSync('git worktree prune', { cwd: projectRoot, stdio: 'inherit' });

		// Delete session branches
		try {
			execSync('git branch --list "session/*" | xargs git branch -D 2>/dev/null || true', {
				cwd: projectRoot,
				shell: '/bin/bash',
				stdio: 'inherit',
			});
		} catch {
			// Ignore - branches may not exist
		}

		// Remove directory
		rmSync(worktreesDir, { recursive: true, force: true });

		console.log('✅ Pre-test cleanup complete\n');
	} catch (error) {
		console.warn('⚠️  Pre-test cleanup failed (continuing anyway):', error);
	}
}

export default globalSetup;
