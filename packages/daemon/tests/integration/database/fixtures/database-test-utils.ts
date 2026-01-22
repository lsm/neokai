/**
 * Shared test utilities for database tests
 */

import type { Session } from '@liuboer/shared';
import { Database } from '../../../../src/storage/database';

/**
 * Create an in-memory test database
 */
export async function createTestDb(): Promise<Database> {
	const db = new Database(':memory:');
	await db.initialize();
	return db;
}

/**
 * Create a test session with default values
 */
export function createTestSession(id: string): Session {
	return {
		id,
		title: `Test Session ${id}`,
		workspacePath: '/test/workspace',
		createdAt: new Date().toISOString(),
		lastActiveAt: new Date().toISOString(),
		status: 'active',
		config: {
			model: 'claude-sonnet-4-5-20250929',
			maxTokens: 8192,
			temperature: 1.0,
		},
		metadata: {
			messageCount: 0,
			totalTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			totalCost: 0,
			toolCallCount: 0,
		},
	};
}

// Re-export assertions for convenience
export { assertEquals, assertExists } from '../../../test-utils';
