/**
 * SDK Session File Manager Tests
 *
 * Tests for validation and auto-repair of SDK session files.
 * These files can become corrupted when SDK context compaction removes
 * tool_use blocks while keeping tool_result blocks, causing API errors.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
	validateSDKSessionFile,
	getSDKSessionFilePath,
	repairSDKSessionFile,
	validateAndRepairSDKSession,
} from '../../../src/lib/sdk-session-file-manager';
import type { Database } from '../../../src/storage/database';

describe('SDK Session File Manager', () => {
	const testWorkspacePath = '/tmp/test-workspace-sdk-validation';
	const testSdkSessionId = 'test-sdk-session-validation';
	let testSessionDir: string;
	let testSessionFile: string;

	beforeEach(() => {
		// Create test directory structure
		const projectKey = testWorkspacePath.replace(/[/.]/g, '-');
		testSessionDir = join(homedir(), '.claude', 'projects', projectKey);
		mkdirSync(testSessionDir, { recursive: true });
		testSessionFile = join(testSessionDir, `${testSdkSessionId}.jsonl`);
	});

	afterEach(() => {
		// Cleanup test files
		if (existsSync(testSessionDir)) {
			try {
				rmSync(testSessionDir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		}
	});

	describe('getSDKSessionFilePath', () => {
		test('should construct correct path with workspace encoding', () => {
			const path = getSDKSessionFilePath('/Users/test/project', 'session-123');
			expect(path).toContain('.claude/projects/-Users-test-project/session-123.jsonl');
		});

		test('should handle dots and slashes in workspace path', () => {
			const path = getSDKSessionFilePath('/Users/test/.hidden/project', 'session-123');
			expect(path).toContain('-Users-test--hidden-project');
		});
	});

	describe('validateSDKSessionFile', () => {
		test('should return valid for non-existent file', () => {
			const result = validateSDKSessionFile(testWorkspacePath, 'nonexistent-session');
			expect(result.valid).toBe(true);
			expect(result.orphanedToolResults).toHaveLength(0);
		});

		test('should return valid for file with matching tool_use/tool_result pairs', () => {
			const messages = [
				// User message
				JSON.stringify({
					type: 'user',
					uuid: 'user-1',
					message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
				}),
				// Assistant with tool_use
				JSON.stringify({
					type: 'assistant',
					uuid: 'assistant-1',
					message: {
						role: 'assistant',
						content: [{ type: 'tool_use', id: 'tool_001', name: 'Bash', input: {} }],
					},
				}),
				// User with tool_result
				JSON.stringify({
					type: 'user',
					uuid: 'user-2',
					message: {
						role: 'user',
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'tool_001',
								content: 'result',
							},
						],
					},
				}),
			];

			writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

			const result = validateSDKSessionFile(testWorkspacePath, testSdkSessionId);
			expect(result.valid).toBe(true);
			expect(result.orphanedToolResults).toHaveLength(0);
		});

		test('should detect orphaned tool_result (missing tool_use)', () => {
			const messages = [
				// User with tool_result but NO preceding tool_use
				JSON.stringify({
					type: 'user',
					uuid: 'user-1',
					message: {
						role: 'user',
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'orphan_tool_001',
								content: 'result',
							},
						],
					},
				}),
				// Assistant response
				JSON.stringify({
					type: 'assistant',
					uuid: 'assistant-1',
					message: {
						role: 'assistant',
						content: [{ type: 'text', text: 'Response' }],
					},
				}),
			];

			writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

			const result = validateSDKSessionFile(testWorkspacePath, testSdkSessionId);
			expect(result.valid).toBe(false);
			expect(result.orphanedToolResults).toHaveLength(1);
			expect(result.orphanedToolResults[0].toolUseId).toBe('orphan_tool_001');
			expect(result.orphanedToolResults[0].messageUuid).toBe('user-1');
		});

		test('should detect multiple orphaned tool_results', () => {
			const messages = [
				// First orphaned tool_result
				JSON.stringify({
					type: 'user',
					uuid: 'user-1',
					message: {
						role: 'user',
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'orphan_001',
								content: 'result 1',
							},
						],
					},
				}),
				// Second orphaned tool_result
				JSON.stringify({
					type: 'user',
					uuid: 'user-2',
					message: {
						role: 'user',
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'orphan_002',
								content: 'result 2',
							},
						],
					},
				}),
			];

			writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

			const result = validateSDKSessionFile(testWorkspacePath, testSdkSessionId);
			expect(result.valid).toBe(false);
			expect(result.orphanedToolResults).toHaveLength(2);
		});

		test('should handle mixed valid and orphaned tool_results', () => {
			const messages = [
				// Valid tool_use
				JSON.stringify({
					type: 'assistant',
					uuid: 'assistant-1',
					message: {
						role: 'assistant',
						content: [{ type: 'tool_use', id: 'valid_tool', name: 'Bash', input: {} }],
					},
				}),
				// Valid tool_result
				JSON.stringify({
					type: 'user',
					uuid: 'user-1',
					message: {
						role: 'user',
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'valid_tool',
								content: 'valid',
							},
						],
					},
				}),
				// Orphaned tool_result
				JSON.stringify({
					type: 'user',
					uuid: 'user-2',
					message: {
						role: 'user',
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'orphan_tool',
								content: 'orphan',
							},
						],
					},
				}),
			];

			writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

			const result = validateSDKSessionFile(testWorkspacePath, testSdkSessionId);
			expect(result.valid).toBe(false);
			expect(result.orphanedToolResults).toHaveLength(1);
			expect(result.orphanedToolResults[0].toolUseId).toBe('orphan_tool');
		});

		test('should handle queue-operation messages (skip them)', () => {
			const messages = [
				JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
				JSON.stringify({
					type: 'assistant',
					uuid: 'assistant-1',
					message: {
						role: 'assistant',
						content: [{ type: 'tool_use', id: 'tool_001', name: 'Bash', input: {} }],
					},
				}),
				JSON.stringify({
					type: 'user',
					uuid: 'user-1',
					message: {
						role: 'user',
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'tool_001',
								content: 'result',
							},
						],
					},
				}),
			];

			writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

			const result = validateSDKSessionFile(testWorkspacePath, testSdkSessionId);
			expect(result.valid).toBe(true);
		});

		test('should handle malformed JSON lines gracefully', () => {
			const content = [
				'{"type":"assistant","uuid":"a1","message":{"content":[{"type":"tool_use","id":"t1"}]}}',
				'not valid json',
				'{"type":"user","uuid":"u1","message":{"content":[{"type":"tool_result","tool_use_id":"t1"}]}}',
			].join('\n');

			writeFileSync(testSessionFile, content + '\n', 'utf-8');

			const result = validateSDKSessionFile(testWorkspacePath, testSdkSessionId);
			// Should still find the valid messages
			expect(result.errors.length).toBeGreaterThan(0);
			expect(result.errors[0]).toContain('Failed to parse line 1');
		});
	});

	describe('repairSDKSessionFile', () => {
		// Mock database for testing
		const createMockDb = (messages: Array<{ type: string; uuid: string; message: unknown }>) => {
			return {
				getSDKMessages: () =>
					messages.map((m) => ({
						...m,
						timestamp: Date.now(),
					})),
			} as unknown as Database;
		};

		test('should return success for already valid file', () => {
			const messages = [
				JSON.stringify({
					type: 'assistant',
					uuid: 'a1',
					message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] },
				}),
				JSON.stringify({
					type: 'user',
					uuid: 'u1',
					message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] },
				}),
			];
			writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

			const mockDb = createMockDb([]);
			const result = repairSDKSessionFile(
				testWorkspacePath,
				testSdkSessionId,
				'liuboer-session-1',
				mockDb
			);

			expect(result.success).toBe(true);
			expect(result.repairedCount).toBe(0);
			expect(result.backupPath).toBeNull(); // No backup needed for valid file
		});

		test('should create backup before repair', () => {
			// Create file with orphaned tool_result
			const messages = [
				JSON.stringify({
					type: 'user',
					uuid: 'u1',
					parentUuid: 'missing-parent',
					cwd: testWorkspacePath,
					message: {
						content: [{ type: 'tool_result', tool_use_id: 'orphan_t1' }],
					},
				}),
			];
			writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

			// Mock DB with the missing tool_use message
			const mockDb = createMockDb([
				{
					type: 'assistant',
					uuid: 'missing-parent',
					message: {
						content: [{ type: 'tool_use', id: 'orphan_t1', name: 'TaskOutput' }],
					},
				},
			]);

			const result = repairSDKSessionFile(
				testWorkspacePath,
				testSdkSessionId,
				'liuboer-session-1',
				mockDb
			);

			expect(result.backupPath).not.toBeNull();
			expect(existsSync(result.backupPath!)).toBe(true);
		});

		test('should insert missing tool_use message', () => {
			// Create file with orphaned tool_result
			const messages = [
				JSON.stringify({
					type: 'user',
					uuid: 'u1',
					parentUuid: 'missing-parent',
					cwd: testWorkspacePath,
					version: '2.1.1',
					gitBranch: 'test-branch',
					slug: 'test-slug',
					message: {
						content: [{ type: 'tool_result', tool_use_id: 'orphan_t1' }],
					},
				}),
			];
			writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

			// Mock DB with the missing tool_use message
			const mockDb = createMockDb([
				{
					type: 'assistant',
					uuid: 'recovered-assistant-uuid',
					message: {
						role: 'assistant',
						content: [
							{
								type: 'tool_use',
								id: 'orphan_t1',
								name: 'TaskOutput',
								input: {},
							},
						],
					},
				},
			]);

			const result = repairSDKSessionFile(
				testWorkspacePath,
				testSdkSessionId,
				'liuboer-session-1',
				mockDb
			);

			expect(result.success).toBe(true);
			expect(result.repairedCount).toBe(1);

			// Verify the file was repaired
			const repairedContent = readFileSync(testSessionFile, 'utf-8');
			const lines = repairedContent.split('\n').filter((l) => l.trim());

			expect(lines.length).toBe(2); // Should now have 2 messages

			const firstMsg = JSON.parse(lines[0]);
			const secondMsg = JSON.parse(lines[1]);

			expect(firstMsg.type).toBe('assistant');
			expect(firstMsg.uuid).toBe('recovered-assistant-uuid');
			expect(firstMsg.message.content[0].type).toBe('tool_use');
			expect(firstMsg.message.content[0].id).toBe('orphan_t1');

			expect(secondMsg.type).toBe('user');
			expect(secondMsg.parentUuid).toBe('recovered-assistant-uuid'); // Should be updated
		});

		test('should report error when tool_use not found in DB', () => {
			// Create file with orphaned tool_result
			const messages = [
				JSON.stringify({
					type: 'user',
					uuid: 'u1',
					parentUuid: 'missing-parent',
					message: {
						content: [{ type: 'tool_result', tool_use_id: 'unfindable_tool' }],
					},
				}),
			];
			writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

			// Mock DB with NO matching tool_use
			const mockDb = createMockDb([]);

			const result = repairSDKSessionFile(
				testWorkspacePath,
				testSdkSessionId,
				'liuboer-session-1',
				mockDb
			);

			expect(result.success).toBe(false);
			expect(result.repairedCount).toBe(0);
			expect(result.errors.length).toBeGreaterThan(0);
			expect(result.errors[0]).toContain('Could not find tool_use message for unfindable_tool');
		});
	});

	describe('validateAndRepairSDKSession', () => {
		test('should return true for valid session', () => {
			const messages = [
				JSON.stringify({
					type: 'assistant',
					uuid: 'a1',
					message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] },
				}),
				JSON.stringify({
					type: 'user',
					uuid: 'u1',
					message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] },
				}),
			];
			writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

			const mockDb = {
				getSDKMessages: () => [],
			} as unknown as Database;

			const result = validateAndRepairSDKSession(
				testWorkspacePath,
				testSdkSessionId,
				'liuboer-session-1',
				mockDb
			);

			expect(result).toBe(true);
		});

		test('should return true after successful repair', () => {
			// Create file with orphaned tool_result
			const messages = [
				JSON.stringify({
					type: 'user',
					uuid: 'u1',
					parentUuid: 'missing-parent',
					cwd: testWorkspacePath,
					message: {
						content: [{ type: 'tool_result', tool_use_id: 'orphan_t1' }],
					},
				}),
			];
			writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

			// Mock DB with the missing tool_use message
			const mockDb = {
				getSDKMessages: () => [
					{
						type: 'assistant',
						uuid: 'recovered-uuid',
						message: {
							content: [{ type: 'tool_use', id: 'orphan_t1', name: 'TaskOutput' }],
						},
						timestamp: Date.now(),
					},
				],
			} as unknown as Database;

			const result = validateAndRepairSDKSession(
				testWorkspacePath,
				testSdkSessionId,
				'liuboer-session-1',
				mockDb
			);

			expect(result).toBe(true);
		});

		test('should return false when repair fails', () => {
			// Create file with orphaned tool_result
			const messages = [
				JSON.stringify({
					type: 'user',
					uuid: 'u1',
					message: {
						content: [{ type: 'tool_result', tool_use_id: 'unfindable' }],
					},
				}),
			];
			writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

			// Mock DB with NO matching tool_use
			const mockDb = {
				getSDKMessages: () => [],
			} as unknown as Database;

			const result = validateAndRepairSDKSession(
				testWorkspacePath,
				testSdkSessionId,
				'liuboer-session-1',
				mockDb
			);

			expect(result).toBe(false);
		});

		test('should clean queue-operation entries from session file', () => {
			// Create file with queue-operation entries
			const messages = [
				JSON.stringify({
					type: 'assistant',
					uuid: 'a1',
					message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] },
				}),
				JSON.stringify({
					type: 'queue-operation',
					operation: 'enqueue',
					timestamp: '2026-01-19T16:24:25.110Z',
					sessionId: 'test-session-id',
				}),
				JSON.stringify({
					type: 'user',
					uuid: 'u1',
					message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] },
				}),
				JSON.stringify({
					type: 'queue-operation',
					operation: 'dequeue',
					timestamp: '2026-01-19T16:24:56.050Z',
					sessionId: 'test-session-id',
				}),
			];
			writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

			const mockDb = {
				getSDKMessages: () => [],
			} as unknown as Database;

			// validateAndRepairSDKSession should clean queue-operation entries
			const result = validateAndRepairSDKSession(
				testWorkspacePath,
				testSdkSessionId,
				'liuboer-session-1',
				mockDb
			);

			expect(result).toBe(true);

			// Verify queue-operation entries were removed
			const cleanedContent = readFileSync(testSessionFile, 'utf-8');
			const lines = cleanedContent.split('\n').filter((l) => l.trim());

			// Should only have 2 messages (assistant and user), not 4
			expect(lines.length).toBe(2);

			const firstMsg = JSON.parse(lines[0]);
			const secondMsg = JSON.parse(lines[1]);

			expect(firstMsg.type).toBe('assistant');
			expect(secondMsg.type).toBe('user');
		});

		test('should clean incomplete assistant messages with null stop_reason', () => {
			// Create file with incomplete assistant message (interrupted mid-stream)
			const messages = [
				JSON.stringify({
					type: 'assistant',
					uuid: 'a1',
					message: {
						id: 'msg1',
						role: 'assistant',
						content: [{ type: 'text', text: 'Thinking...' }],
						stop_reason: null, // Incomplete message!
						stop_sequence: null,
					},
				}),
				JSON.stringify({
					type: 'assistant',
					uuid: 'a2',
					message: {
						id: 'msg2',
						role: 'assistant',
						content: [{ type: 'tool_use', id: 't1', name: 'Bash' }],
						stop_reason: 'tool_use', // Complete message
						stop_sequence: null,
					},
				}),
				JSON.stringify({
					type: 'user',
					uuid: 'u1',
					message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] },
				}),
			];
			writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

			const mockDb = {
				getSDKMessages: () => [],
			} as unknown as Database;

			// validateAndRepairSDKSession should clean incomplete messages
			const result = validateAndRepairSDKSession(
				testWorkspacePath,
				testSdkSessionId,
				'liuboer-session-1',
				mockDb
			);

			expect(result).toBe(true);

			// Verify incomplete message was removed
			const cleanedContent = readFileSync(testSessionFile, 'utf-8');
			const lines = cleanedContent.split('\n').filter((l) => l.trim());

			// Should only have 2 messages (complete assistant and user), not 3
			expect(lines.length).toBe(2);

			const firstMsg = JSON.parse(lines[0]);
			const secondMsg = JSON.parse(lines[1]);

			expect(firstMsg.uuid).toBe('a2');
			expect(firstMsg.message.stop_reason).toBe('tool_use');
			expect(secondMsg.type).toBe('user');
		});
	});
});
