/**
 * SpaceTaskReportResultRepository Unit Tests
 *
 * Covers:
 *   - append() creates a row with a generated id and recordedAt ~= Date.now().
 *   - listByTask() returns rows in ascending recordedAt order.
 *   - getLatestByTask() returns the most recent row, or null when empty.
 *   - Evidence round-trips through JSON; null evidence stays null.
 *   - FK cascade: deleting the parent task removes associated result rows.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SpaceTaskReportResultRepository } from '../../../../src/storage/repositories/space-task-report-result-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';

describe('SpaceTaskReportResultRepository', () => {
	let db: Database;
	let spaceRepo: SpaceRepository;
	let taskRepo: SpaceTaskRepository;
	let repo: SpaceTaskReportResultRepository;
	let spaceId: string;
	let taskId: string;

	beforeEach(() => {
		db = new Database(':memory:');
		createSpaceTables(db);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		spaceRepo = new SpaceRepository(db as any);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		taskRepo = new SpaceTaskRepository(db as any);
		repo = new SpaceTaskReportResultRepository(db);

		const space = spaceRepo.createSpace({
			workspacePath: '/workspace/test',
			slug: 'test',
			name: 'Test',
		});
		spaceId = space.id;
		const task = taskRepo.createTask({ spaceId, title: 'T', description: '' });
		taskId = task.id;
	});

	afterEach(() => {
		db.close();
	});

	describe('append', () => {
		test('creates a row with a generated id and recordedAt ~= Date.now()', () => {
			const before = Date.now();
			const result = repo.append({
				taskId,
				spaceId,
				workflowNodeId: 'node-1',
				agentName: 'coder',
				summary: 'Built the thing',
				evidence: { files: ['a.ts'] },
			});
			const after = Date.now();

			expect(result.id).toBeTruthy();
			expect(result.id.length).toBeGreaterThan(8);
			expect(result.recordedAt).toBeGreaterThanOrEqual(before);
			expect(result.recordedAt).toBeLessThanOrEqual(after);
			expect(result.taskId).toBe(taskId);
			expect(result.summary).toBe('Built the thing');
			expect(result.evidence).toEqual({ files: ['a.ts'] });
		});

		test('null evidence round-trips as null', () => {
			const result = repo.append({
				taskId,
				spaceId,
				workflowNodeId: null,
				agentName: null,
				summary: 'quick note',
				evidence: null,
			});
			expect(result.evidence).toBeNull();

			const fetched = repo.getLatestByTask(taskId);
			expect(fetched?.evidence).toBeNull();
		});

		test('workflowNodeId and agentName can be null', () => {
			const result = repo.append({
				taskId,
				spaceId,
				workflowNodeId: null,
				agentName: null,
				summary: 's',
				evidence: null,
			});
			expect(result.workflowNodeId).toBeNull();
			expect(result.agentName).toBeNull();
		});
	});

	describe('listByTask', () => {
		test('returns all rows for the task in ascending recordedAt order', async () => {
			const r1 = repo.append({
				taskId,
				spaceId,
				workflowNodeId: 'n',
				agentName: 'a',
				summary: 'first',
				evidence: null,
			});
			// Ensure a distinct timestamp for deterministic ordering.
			await new Promise((r) => setTimeout(r, 2));
			const r2 = repo.append({
				taskId,
				spaceId,
				workflowNodeId: 'n',
				agentName: 'a',
				summary: 'second',
				evidence: null,
			});
			await new Promise((r) => setTimeout(r, 2));
			const r3 = repo.append({
				taskId,
				spaceId,
				workflowNodeId: 'n',
				agentName: 'a',
				summary: 'third',
				evidence: null,
			});

			const rows = repo.listByTask(taskId);
			expect(rows.map((r) => r.id)).toEqual([r1.id, r2.id, r3.id]);
			expect(rows.map((r) => r.summary)).toEqual(['first', 'second', 'third']);
		});

		test('only returns rows for the requested task', () => {
			const otherTask = taskRepo.createTask({ spaceId, title: 'Other', description: '' });
			repo.append({
				taskId,
				spaceId,
				workflowNodeId: null,
				agentName: null,
				summary: 'mine',
				evidence: null,
			});
			repo.append({
				taskId: otherTask.id,
				spaceId,
				workflowNodeId: null,
				agentName: null,
				summary: 'theirs',
				evidence: null,
			});
			const rows = repo.listByTask(taskId);
			expect(rows).toHaveLength(1);
			expect(rows[0].summary).toBe('mine');
		});

		test('returns empty array when task has no results', () => {
			expect(repo.listByTask(taskId)).toEqual([]);
		});

		test('two appends with different evidence payloads round-trip', () => {
			repo.append({
				taskId,
				spaceId,
				workflowNodeId: null,
				agentName: null,
				summary: 'a',
				evidence: { kind: 'pr', url: 'https://example.com/pr/1' },
			});
			repo.append({
				taskId,
				spaceId,
				workflowNodeId: null,
				agentName: null,
				summary: 'b',
				evidence: { kind: 'commit', sha: 'abc123' },
			});
			const rows = repo.listByTask(taskId);
			expect(rows).toHaveLength(2);
			expect(rows[0].evidence).toEqual({ kind: 'pr', url: 'https://example.com/pr/1' });
			expect(rows[1].evidence).toEqual({ kind: 'commit', sha: 'abc123' });
		});
	});

	describe('getLatestByTask', () => {
		test('returns the most recent row', async () => {
			repo.append({
				taskId,
				spaceId,
				workflowNodeId: null,
				agentName: null,
				summary: 'first',
				evidence: null,
			});
			await new Promise((r) => setTimeout(r, 2));
			const r2 = repo.append({
				taskId,
				spaceId,
				workflowNodeId: null,
				agentName: null,
				summary: 'second',
				evidence: null,
			});

			const latest = repo.getLatestByTask(taskId);
			expect(latest?.id).toBe(r2.id);
			expect(latest?.summary).toBe('second');
		});

		test('returns null when task has no results', () => {
			expect(repo.getLatestByTask(taskId)).toBeNull();
		});
	});

	describe('FK cascade', () => {
		test('deleting the parent task removes associated result rows', () => {
			repo.append({
				taskId,
				spaceId,
				workflowNodeId: null,
				agentName: null,
				summary: 'x',
				evidence: null,
			});
			repo.append({
				taskId,
				spaceId,
				workflowNodeId: null,
				agentName: null,
				summary: 'y',
				evidence: null,
			});
			expect(repo.listByTask(taskId)).toHaveLength(2);

			taskRepo.deleteTask(taskId);

			expect(repo.listByTask(taskId)).toHaveLength(0);
		});

		test('deleting the parent space removes associated result rows', () => {
			repo.append({
				taskId,
				spaceId,
				workflowNodeId: null,
				agentName: null,
				summary: 'x',
				evidence: null,
			});
			expect(repo.listByTask(taskId)).toHaveLength(1);

			spaceRepo.deleteSpace(spaceId);

			// Task cascaded from space, and results cascaded from task (or space).
			expect(repo.listByTask(taskId)).toHaveLength(0);
		});
	});
});
