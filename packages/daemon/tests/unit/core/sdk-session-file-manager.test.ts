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
	deleteSDKSessionFiles,
	archiveSDKSessionFiles,
	scanSDKSessionFiles,
	identifyOrphanedSDKFiles,
	removeToolResultFromSessionFile,
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
	});

	// ============================================================================
	// SDK Session File Cleanup & Archive Tests
	// ============================================================================

	describe('deleteSDKSessionFiles', () => {
		test('should return success with empty deletedFiles when no files exist', () => {
			const result = deleteSDKSessionFiles(
				'/nonexistent/workspace',
				'nonexistent-sdk-session',
				'liuboer-session-1'
			);

			expect(result.success).toBe(true);
			expect(result.deletedFiles).toHaveLength(0);
			expect(result.deletedSize).toBe(0);
			expect(result.errors).toHaveLength(0);
		});

		test('should delete SDK session file by sdkSessionId', () => {
			// Create a test file
			const content = JSON.stringify({
				type: 'user',
				uuid: 'u1',
				message: { content: [{ type: 'text', text: 'Hello' }] },
			});
			writeFileSync(testSessionFile, content + '\n', 'utf-8');

			expect(existsSync(testSessionFile)).toBe(true);

			const result = deleteSDKSessionFiles(
				testWorkspacePath,
				testSdkSessionId,
				'liuboer-session-1'
			);

			expect(result.success).toBe(true);
			expect(result.deletedFiles).toHaveLength(1);
			expect(result.deletedFiles[0]).toContain(testSdkSessionId);
			expect(result.deletedSize).toBeGreaterThan(0);
			expect(existsSync(testSessionFile)).toBe(false);
		});

		test('should find and delete SDK files by liuboerSessionId when sdkSessionId is null', () => {
			const liuboerSessionId = 'test-liuboer-id-12345678';

			// Create a file that contains the Liuboer session ID
			const content = JSON.stringify({
				type: 'user',
				uuid: 'u1',
				sessionId: liuboerSessionId,
				message: { content: [{ type: 'text', text: 'Hello' }] },
			});
			writeFileSync(testSessionFile, content + '\n', 'utf-8');

			const result = deleteSDKSessionFiles(testWorkspacePath, null, liuboerSessionId);

			expect(result.success).toBe(true);
			expect(result.deletedFiles.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe('archiveSDKSessionFiles', () => {
		const liuboerSessionId = 'test-archive-session-id';
		let archiveDir: string;

		beforeEach(() => {
			archiveDir = join(homedir(), '.liuboer', 'claude-session-archives', liuboerSessionId);
		});

		afterEach(() => {
			// Cleanup archive directory
			if (existsSync(archiveDir)) {
				try {
					rmSync(archiveDir, { recursive: true, force: true });
				} catch {
					// Ignore cleanup errors
				}
			}
		});

		test('should return success with empty archivedFiles when no files exist', () => {
			const result = archiveSDKSessionFiles(
				'/nonexistent/workspace',
				'nonexistent-sdk-session',
				liuboerSessionId
			);

			expect(result.success).toBe(true);
			expect(result.archivedFiles).toHaveLength(0);
			expect(result.archivePath).toBeNull();
			expect(result.totalSize).toBe(0);
		});

		test('should archive SDK session file and create metadata', () => {
			// Create a test file
			const content = JSON.stringify({
				type: 'user',
				uuid: 'u1',
				message: { content: [{ type: 'text', text: 'Hello' }] },
			});
			writeFileSync(testSessionFile, content + '\n', 'utf-8');

			expect(existsSync(testSessionFile)).toBe(true);

			const result = archiveSDKSessionFiles(testWorkspacePath, testSdkSessionId, liuboerSessionId);

			expect(result.success).toBe(true);
			expect(result.archivePath).toBe(archiveDir);
			expect(result.archivedFiles).toHaveLength(1);
			expect(result.totalSize).toBeGreaterThan(0);

			// Original file should be removed
			expect(existsSync(testSessionFile)).toBe(false);

			// Archive should contain the file
			const archivedFile = join(archiveDir, `${testSdkSessionId}.jsonl`);
			expect(existsSync(archivedFile)).toBe(true);

			// Metadata file should exist
			const metadataFile = join(archiveDir, 'archive-metadata.json');
			expect(existsSync(metadataFile)).toBe(true);

			// Verify metadata content
			const metadata = JSON.parse(readFileSync(metadataFile, 'utf-8'));
			expect(metadata.liuboerSessionId).toBe(liuboerSessionId);
			expect(metadata.originalWorkspacePath).toBe(testWorkspacePath);
			expect(metadata.fileCount).toBe(1);
		});
	});

	describe('scanSDKSessionFiles', () => {
		test('should return empty array for nonexistent workspace', () => {
			const files = scanSDKSessionFiles('/nonexistent/workspace');
			expect(files).toHaveLength(0);
		});

		test('should find SDK session files in workspace', () => {
			// Create test files
			const file1 = join(testSessionDir, 'sdk-session-1.jsonl');
			const file2 = join(testSessionDir, 'sdk-session-2.jsonl');

			writeFileSync(
				file1,
				JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 'liuboer-id-1' }) + '\n',
				'utf-8'
			);
			writeFileSync(
				file2,
				JSON.stringify({ type: 'user', uuid: 'u2', sessionId: 'liuboer-id-2' }) + '\n',
				'utf-8'
			);

			const files = scanSDKSessionFiles(testWorkspacePath);

			expect(files.length).toBeGreaterThanOrEqual(2);

			const sdkSessionIds = files.map((f) => f.sdkSessionId);
			expect(sdkSessionIds).toContain('sdk-session-1');
			expect(sdkSessionIds).toContain('sdk-session-2');

			// Each file should have size and modifiedAt
			for (const file of files) {
				expect(file.size).toBeGreaterThan(0);
				expect(file.modifiedAt).toBeInstanceOf(Date);
			}
		});

		test('should extract Liuboer session IDs from file content', () => {
			const liuboerId = 'a1b2c3d4-e5f6-4789-abcd-ef0123456789';

			// Create a file with UUID-like content (appears multiple times)
			const content = [
				JSON.stringify({ type: 'user', uuid: 'u1', liuboerId }),
				JSON.stringify({ type: 'assistant', uuid: 'a1', liuboerId }),
				JSON.stringify({ type: 'user', uuid: 'u2', liuboerId }),
				JSON.stringify({ type: 'assistant', uuid: 'a2', liuboerId }),
			].join('\n');

			writeFileSync(testSessionFile, content + '\n', 'utf-8');

			const files = scanSDKSessionFiles(testWorkspacePath);
			const targetFile = files.find((f) => f.sdkSessionId === testSdkSessionId);

			expect(targetFile).toBeDefined();
			expect(targetFile!.liuboerSessionIds).toContain(liuboerId);
		});
	});

	describe('identifyOrphanedSDKFiles', () => {
		test('should return empty array when no files provided', () => {
			const orphaned = identifyOrphanedSDKFiles([], new Set(), new Set());
			expect(orphaned).toHaveLength(0);
		});

		test('should identify files with no matching session as orphaned', () => {
			const files = [
				{
					path: '/test/path/sdk-1.jsonl',
					sdkSessionId: 'sdk-1',
					liuboerSessionIds: ['unknown-session-id'],
					size: 100,
					modifiedAt: new Date(),
				},
			];

			const activeIds = new Set(['active-session-1', 'active-session-2']);
			const archivedIds = new Set(['archived-session-1']);

			const orphaned = identifyOrphanedSDKFiles(files, activeIds, archivedIds);

			expect(orphaned).toHaveLength(1);
			expect(orphaned[0].sdkSessionId).toBe('sdk-1');
			expect(orphaned[0].reason).toBe('no-matching-session');
		});

		test('should not mark files with active session as orphaned', () => {
			const files = [
				{
					path: '/test/path/sdk-1.jsonl',
					sdkSessionId: 'sdk-1',
					liuboerSessionIds: ['active-session-1'],
					size: 100,
					modifiedAt: new Date(),
				},
			];

			const activeIds = new Set(['active-session-1', 'active-session-2']);
			const archivedIds = new Set<string>();

			const orphaned = identifyOrphanedSDKFiles(files, activeIds, archivedIds);

			expect(orphaned).toHaveLength(0);
		});

		test('should not mark files with archived session as orphaned', () => {
			const files = [
				{
					path: '/test/path/sdk-1.jsonl',
					sdkSessionId: 'sdk-1',
					liuboerSessionIds: ['archived-session-1'],
					size: 100,
					modifiedAt: new Date(),
				},
			];

			const activeIds = new Set<string>();
			const archivedIds = new Set(['archived-session-1']);

			const orphaned = identifyOrphanedSDKFiles(files, activeIds, archivedIds);

			expect(orphaned).toHaveLength(0);
		});

		test('should mark files with no liuboerSessionIds as unknown-session', () => {
			const files = [
				{
					path: '/test/path/sdk-1.jsonl',
					sdkSessionId: 'sdk-1',
					liuboerSessionIds: [],
					size: 100,
					modifiedAt: new Date(),
				},
			];

			const activeIds = new Set(['active-session-1']);
			const archivedIds = new Set<string>();

			const orphaned = identifyOrphanedSDKFiles(files, activeIds, archivedIds);

			expect(orphaned).toHaveLength(1);
			expect(orphaned[0].reason).toBe('unknown-session');
		});

		test('should handle mixed files correctly', () => {
			const files = [
				{
					path: '/test/path/active.jsonl',
					sdkSessionId: 'active',
					liuboerSessionIds: ['active-session-1'],
					size: 100,
					modifiedAt: new Date(),
				},
				{
					path: '/test/path/archived.jsonl',
					sdkSessionId: 'archived',
					liuboerSessionIds: ['archived-session-1'],
					size: 100,
					modifiedAt: new Date(),
				},
				{
					path: '/test/path/orphan.jsonl',
					sdkSessionId: 'orphan',
					liuboerSessionIds: ['deleted-session'],
					size: 100,
					modifiedAt: new Date(),
				},
				{
					path: '/test/path/unknown.jsonl',
					sdkSessionId: 'unknown',
					liuboerSessionIds: [],
					size: 100,
					modifiedAt: new Date(),
				},
			];

			const activeIds = new Set(['active-session-1']);
			const archivedIds = new Set(['archived-session-1']);

			const orphaned = identifyOrphanedSDKFiles(files, activeIds, archivedIds);

			expect(orphaned).toHaveLength(2);
			const sdkIds = orphaned.map((o) => o.sdkSessionId);
			expect(sdkIds).toContain('orphan');
			expect(sdkIds).toContain('unknown');
		});
	});

	// ============================================================================
	// removeToolResultFromSessionFile Tests
	// ============================================================================

	describe('removeToolResultFromSessionFile', () => {
		test('should return false when SDK session file does not exist', () => {
			const result = removeToolResultFromSessionFile(
				testWorkspacePath,
				'nonexistent-sdk-session-id',
				'message-uuid-123'
			);

			expect(result).toBe(false);
		});

		test('should return false when neither sdkSessionId nor liuboerSessionId provided', () => {
			const result = removeToolResultFromSessionFile(testWorkspacePath, null, 'message-uuid-123');

			expect(result).toBe(false);
		});

		test('should return false when liuboerSessionId search finds no files', () => {
			const result = removeToolResultFromSessionFile(
				testWorkspacePath,
				null,
				'message-uuid-123',
				'nonexistent-liuboer-session-id'
			);

			expect(result).toBe(false);
		});

		test('should return false when message UUID is not found in file', () => {
			// Create a file without the target message
			const messages = [
				JSON.stringify({
					type: 'user',
					uuid: 'other-uuid',
					message: {
						role: 'user',
						content: [{ type: 'text', text: 'Hello' }],
					},
				}),
			];
			writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

			const result = removeToolResultFromSessionFile(
				testWorkspacePath,
				testSdkSessionId,
				'nonexistent-message-uuid'
			);

			expect(result).toBe(false);
		});

		test('should return false when message has no tool_result blocks', () => {
			// Create a file with target message but no tool_result
			const messages = [
				JSON.stringify({
					type: 'user',
					uuid: 'target-uuid',
					message: {
						role: 'user',
						content: [{ type: 'text', text: 'Hello' }],
					},
				}),
			];
			writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

			const result = removeToolResultFromSessionFile(
				testWorkspacePath,
				testSdkSessionId,
				'target-uuid'
			);

			expect(result).toBe(false);
		});

		test('should successfully remove tool_result content from message', () => {
			// Create a file with a tool_result message
			const messages = [
				JSON.stringify({
					type: 'assistant',
					uuid: 'assistant-uuid',
					message: {
						role: 'assistant',
						content: [{ type: 'tool_use', id: 'tool-123', name: 'Bash', input: { command: 'ls' } }],
					},
				}),
				JSON.stringify({
					type: 'user',
					uuid: 'user-uuid-with-result',
					message: {
						role: 'user',
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'tool-123',
								content: 'Very large output that we want to remove...',
							},
						],
					},
				}),
			];
			writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

			const result = removeToolResultFromSessionFile(
				testWorkspacePath,
				testSdkSessionId,
				'user-uuid-with-result'
			);

			expect(result).toBe(true);

			// Verify the content was replaced
			const updatedContent = readFileSync(testSessionFile, 'utf-8');
			const lines = updatedContent.split('\n').filter((l) => l.trim());
			const userMessage = JSON.parse(lines[1]);

			expect(userMessage.message.content[0].content[0].type).toBe('text');
			expect(userMessage.message.content[0].content[0].text).toContain('Output removed by user');
		});

		test('should find file by liuboerSessionId when sdkSessionId is null', () => {
			const liuboerSessionId = 'findable-liuboer-session-id-12345678';

			// Create a file containing the Liuboer session ID
			const messages = [
				JSON.stringify({
					type: 'user',
					uuid: 'target-message-uuid',
					sessionId: liuboerSessionId,
					message: {
						role: 'user',
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'tool-456',
								content: 'Large output to remove...',
							},
						],
					},
				}),
			];
			writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

			const result = removeToolResultFromSessionFile(
				testWorkspacePath,
				null,
				'target-message-uuid',
				liuboerSessionId
			);

			expect(result).toBe(true);
		});

		test('should handle multiple tool_result blocks in same message', () => {
			// Create a file with multiple tool_result blocks
			const messages = [
				JSON.stringify({
					type: 'user',
					uuid: 'multi-result-uuid',
					message: {
						role: 'user',
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'tool-1',
								content: 'First result output',
							},
							{
								type: 'tool_result',
								tool_use_id: 'tool-2',
								content: 'Second result output',
							},
						],
					},
				}),
			];
			writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

			const result = removeToolResultFromSessionFile(
				testWorkspacePath,
				testSdkSessionId,
				'multi-result-uuid'
			);

			expect(result).toBe(true);

			// Verify both tool_results were modified
			const updatedContent = readFileSync(testSessionFile, 'utf-8');
			const lines = updatedContent.split('\n').filter((l) => l.trim());
			const userMessage = JSON.parse(lines[0]);

			expect(userMessage.message.content[0].content[0].text).toContain('Output removed by user');
			expect(userMessage.message.content[1].content[0].text).toContain('Output removed by user');
		});
	});
});
