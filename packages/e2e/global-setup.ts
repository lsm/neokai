/**
 * Global Setup - Runs BEFORE all tests
 * Ensures clean state to prevent nested worktrees
 */

import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { existsSync, rmSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function globalSetup() {
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
