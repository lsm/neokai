/**
 * McpAuditLogRepository Tests
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { McpAuditLogRepository } from '../../../../src/storage/repositories/mcp-audit-log-repository';
import { createSpaceTables } from '../../helpers/space-test-db';

describe('McpAuditLogRepository', () => {
	let db: Database;
	let repo: McpAuditLogRepository;

	beforeEach(() => {
		db = new Database(':memory:');
		createSpaceTables(db);
		repo = new McpAuditLogRepository(db as any);
	});

	afterEach(() => {
		db.close();
	});

	describe('createEntry', () => {
		it('creates an entry with all fields', () => {
			const entry = repo.createEntry({
				agentName: 'coder',
				sessionId: 'sess-1',
				toolName: 'send_message',
				paramsSummary: JSON.stringify({ target: 'reviewer' }),
				spaceId: 'space-1',
				taskId: 'task-1',
				workflowRunId: 'run-1',
			});

			expect(entry.id).toBeDefined();
			expect(entry.timestamp).toBeGreaterThan(0);
			expect(entry.agentName).toBe('coder');
			expect(entry.sessionId).toBe('sess-1');
			expect(entry.toolName).toBe('send_message');
			expect(entry.paramsSummary).toBe(JSON.stringify({ target: 'reviewer' }));
			expect(entry.spaceId).toBe('space-1');
			expect(entry.taskId).toBe('task-1');
			expect(entry.workflowRunId).toBe('run-1');
		});

		it('creates an entry with minimal fields', () => {
			const entry = repo.createEntry({
				toolName: 'save_artifact',
			});

			expect(entry.id).toBeDefined();
			expect(entry.timestamp).toBeGreaterThan(0);
			expect(entry.agentName).toBeNull();
			expect(entry.sessionId).toBeNull();
			expect(entry.toolName).toBe('save_artifact');
			expect(entry.paramsSummary).toBeNull();
			expect(entry.spaceId).toBeNull();
			expect(entry.taskId).toBeNull();
			expect(entry.workflowRunId).toBeNull();
		});

		it('stores null for undefined optional fields', () => {
			const entry = repo.createEntry({
				agentName: undefined,
				sessionId: undefined,
				toolName: 'approve_task',
				paramsSummary: undefined,
				spaceId: undefined,
				taskId: undefined,
				workflowRunId: undefined,
			});

			expect(entry.agentName).toBeNull();
			expect(entry.sessionId).toBeNull();
			expect(entry.paramsSummary).toBeNull();
			expect(entry.spaceId).toBeNull();
			expect(entry.taskId).toBeNull();
			expect(entry.workflowRunId).toBeNull();
		});
	});

	describe('listBySpace', () => {
		it('returns entries for the given space ordered by timestamp desc', () => {
			repo.createEntry({ toolName: 't1', spaceId: 'space-a' });
			repo.createEntry({ toolName: 't2', spaceId: 'space-a' });
			repo.createEntry({ toolName: 't3', spaceId: 'space-b' });

			const results = repo.listBySpace('space-a');
			expect(results).toHaveLength(2);
			expect(results[0].toolName).toBe('t2');
			expect(results[1].toolName).toBe('t1');
		});

		it('returns empty array when no entries match', () => {
			const results = repo.listBySpace('nonexistent');
			expect(results).toEqual([]);
		});

		it('respects limit and offset', () => {
			repo.createEntry({ toolName: 't1', spaceId: 'space-a' });
			repo.createEntry({ toolName: 't2', spaceId: 'space-a' });
			repo.createEntry({ toolName: 't3', spaceId: 'space-a' });

			const page1 = repo.listBySpace('space-a', 2, 0);
			expect(page1).toHaveLength(2);
			expect(page1[0].toolName).toBe('t3');
			expect(page1[1].toolName).toBe('t2');

			const page2 = repo.listBySpace('space-a', 2, 2);
			expect(page2).toHaveLength(1);
			expect(page2[0].toolName).toBe('t1');
		});
	});

	describe('listByTask', () => {
		it('returns entries for the given task ordered by timestamp desc', () => {
			repo.createEntry({ toolName: 't1', taskId: 'task-a' });
			repo.createEntry({ toolName: 't2', taskId: 'task-a' });
			repo.createEntry({ toolName: 't3', taskId: 'task-b' });

			const results = repo.listByTask('task-a');
			expect(results).toHaveLength(2);
			expect(results[0].toolName).toBe('t2');
			expect(results[1].toolName).toBe('t1');
		});

		it('returns empty array when no entries match', () => {
			const results = repo.listByTask('nonexistent');
			expect(results).toEqual([]);
		});

		it('respects limit and offset', () => {
			repo.createEntry({ toolName: 't1', taskId: 'task-a' });
			repo.createEntry({ toolName: 't2', taskId: 'task-a' });
			repo.createEntry({ toolName: 't3', taskId: 'task-a' });

			const page1 = repo.listByTask('task-a', 2, 0);
			expect(page1).toHaveLength(2);

			const page2 = repo.listByTask('task-a', 2, 2);
			expect(page2).toHaveLength(1);
			expect(page2[0].toolName).toBe('t1');
		});
	});

	describe('listBySession', () => {
		it('returns entries for the given session ordered by timestamp desc', () => {
			repo.createEntry({ toolName: 't1', sessionId: 'sess-a' });
			repo.createEntry({ toolName: 't2', sessionId: 'sess-a' });
			repo.createEntry({ toolName: 't3', sessionId: 'sess-b' });

			const results = repo.listBySession('sess-a');
			expect(results).toHaveLength(2);
			expect(results[0].toolName).toBe('t2');
			expect(results[1].toolName).toBe('t1');
		});

		it('returns empty array when no entries match', () => {
			const results = repo.listBySession('nonexistent');
			expect(results).toEqual([]);
		});

		it('respects limit and offset', () => {
			repo.createEntry({ toolName: 't1', sessionId: 'sess-a' });
			repo.createEntry({ toolName: 't2', sessionId: 'sess-a' });
			repo.createEntry({ toolName: 't3', sessionId: 'sess-a' });

			const page1 = repo.listBySession('sess-a', 2, 0);
			expect(page1).toHaveLength(2);

			const page2 = repo.listBySession('sess-a', 2, 2);
			expect(page2).toHaveLength(1);
			expect(page2[0].toolName).toBe('t1');
		});
	});
});
