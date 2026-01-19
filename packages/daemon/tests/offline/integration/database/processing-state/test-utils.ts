/**
 * Shared test utilities for ProcessingStateManager tests
 */

import type { Session } from '@liuboer/shared';
import { mock } from 'bun:test';
import { Database } from '../../../../../src/storage/database';
import { createDaemonHub, type DaemonHub } from '../../../../../src/lib/daemon-hub';

export async function createTestDb(): Promise<Database> {
	const db = new Database(':memory:');
	await db.initialize();
	return db;
}

export function createMockDb(): Database {
	return {
		getSession: mock(() => null),
		updateSession: mock(() => {}),
	} as unknown as Database;
}

export function createMockDaemonHub() {
	const emitSpy = mock(async () => {});
	return {
		hub: { emit: emitSpy } as unknown as DaemonHub,
		emitSpy,
	};
}

export async function createTestDaemonHub(name: string): Promise<DaemonHub> {
	const eventBus = createDaemonHub(name);
	await eventBus.initialize();
	return eventBus;
}

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

export function createSamplePendingQuestion() {
	return {
		toolUseId: 'tool-ask-123',
		questions: [
			{
				question: 'Which database should we use?',
				header: 'Database Choice',
				options: [
					{ label: 'PostgreSQL', description: 'Robust relational database' },
					{ label: 'SQLite', description: 'Lightweight embedded database' },
				],
				multiSelect: false,
			},
		],
		askedAt: Date.now(),
	};
}

export function createMultiSelectPendingQuestion() {
	return {
		toolUseId: 'tool-ask-456',
		questions: [
			{
				question: 'Select features',
				header: 'Features',
				options: [
					{ label: 'TypeScript', description: 'Type safety' },
					{ label: 'Testing', description: 'Unit tests' },
				],
				multiSelect: true,
			},
		],
		askedAt: Date.now(),
	};
}

export function createPersistablePendingQuestion() {
	return {
		toolUseId: 'tool-persist-789',
		questions: [
			{
				question: 'Which option?',
				header: 'Options',
				options: [
					{ label: 'A', description: 'Option A' },
					{ label: 'B', description: 'Option B' },
				],
				multiSelect: false,
			},
		],
		askedAt: Date.now(),
		draftResponses: [{ questionIndex: 0, selectedLabels: ['A'] }],
	};
}
