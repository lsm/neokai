/**
 * Shared test environment configuration for E2E tests.
 *
 * This module is imported by both playwright.config.ts and global-setup.ts.
 * Node.js caches modules, so this is only evaluated ONCE — both files
 * get the same exported values.
 *
 * NOTE: This module has side effects (creates temp directories).
 * It should only be imported by setup/teardown/config files.
 */

import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';

// Compute workspace path once (Node.js caches this module)
const testRunId = `e2e-${Date.now()}-${randomUUID().slice(0, 8)}`;
export const e2eTempDir = join(tmpdir(), 'neokai-e2e', testRunId);
export const e2eWorkspaceDir = join(e2eTempDir, 'workspace');
export const e2eDatabaseDir = join(e2eTempDir, 'database');
export const e2eDatabasePath = join(e2eDatabaseDir, 'daemon.db');

// Ensure directories exist (only created once due to module caching)
if (!existsSync(e2eWorkspaceDir)) {
	mkdirSync(e2eWorkspaceDir, { recursive: true });
}
if (!existsSync(e2eDatabaseDir)) {
	mkdirSync(e2eDatabaseDir, { recursive: true });
}
