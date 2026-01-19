/**
 * Problematic Session Cleanup Integration Tests
 *
 * Tests the fix for sessions that get stuck due to problematic entries in SDK session files:
 * - queue-operation entries: internal SDK metadata
 * - incomplete assistant messages: messages with null stop_reason
 *
 * These tests use real data from an actual stuck session to verify the fix works correctly.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DaemonServerContext } from '../helpers/daemon-server-helper';
import { spawnDaemonServer } from '../helpers/daemon-server-helper';
import { sendMessage, waitForIdle, interrupt } from '../helpers/daemon-test-helpers';

// Use a consistent workspace path for SDK session file predictability
const TEST_WORKSPACE_BASE = join(process.cwd(), 'tmp', 'test-workspaces');

// Original problematic SDK session data from stuck session 92b033df
// This data contains both queue-operation entries and incomplete assistant messages
const PROBLEMATIC_SDK_DATA = [
	// Complete assistant message
	{
		parentUuid: 'c30c5d03-78d7-457c-a056-fcf6a2577f14',
		isSidechain: false,
		userType: 'external',
		cwd: '/Users/lsm/.liuboer/projects/-Users-lsm-focus-liuboer/worktrees/92b033df-0707-4d58-bc8c-956c7437885e',
		sessionId: 'test-sdk-session-id',
		version: '2.1.5',
		gitBranch: 'session/test-problematic-session',
		slug: 'test-session',
		message: {
			id: 'msg_001',
			type: 'message',
			role: 'assistant',
			model: 'claude-3-5-sonnet-20241022',
			content: [{ type: 'text', text: 'Hello!' }],
			stop_reason: 'end_turn',
			stop_sequence: null,
		},
		requestId: 'req_001',
		type: 'assistant',
		uuid: 'c30c5d03-78d7-457c-a056-fcf6a2577f14',
		timestamp: '2026-01-19T16:20:00.000Z',
	},
	// User message
	{
		parentUuid: 'c30c5d03-78d7-457c-a056-fcf6a2577f14',
		isSidechain: false,
		userType: 'external',
		cwd: '/Users/lsm/.liuboer/projects/-Users-lsm-focus-liuboer/worktrees/92b033df-0707-4d58-bc8c-956c7437885e',
		sessionId: 'test-sdk-session-id',
		version: '2.1.5',
		gitBranch: 'session/test-problematic-session',
		slug: 'test-session',
		type: 'user',
		uuid: 'user-001',
		timestamp: '2026-01-19T16:20:01.000Z',
	},
	// Queue operation - causes hang
	{
		type: 'queue-operation',
		operation: 'enqueue',
		timestamp: '2026-01-19T16:24:25.110Z',
		sessionId: 'test-sdk-session-id',
		content: 'test notification',
	},
	// Incomplete assistant message - causes hang
	{
		parentUuid: 'c30c5d03-78d7-457c-a056-fcf6a2577f14',
		isSidechain: false,
		userType: 'external',
		cwd: '/Users/lsm/.liuboer/projects/-Users-lsm-focus-liuboer/worktrees/92b033df-0707-4d58-bc8c-956c7437885e',
		sessionId: 'test-sdk-session-id',
		version: '2.1.5',
		gitBranch: 'session/test-problematic-session',
		slug: 'test-session',
		message: {
			id: 'msg_002',
			type: 'message',
			role: 'assistant',
			model: 'claude-3-5-sonnet-20241022',
			content: [{ type: 'thinking', thinking: 'Processing...' }],
			stop_reason: null, // Incomplete!
			stop_sequence: null,
		},
		type: 'assistant',
		uuid: 'incomplete-001',
		timestamp: '2026-01-19T16:24:30.000Z',
	},
];

describe('Problematic Session Cleanup (SDK Integration)', () => {
	let daemon: DaemonServerContext;
	let testWorkspace: string;
	let sdkProjectDir: string;

	beforeEach(async () => {
		// Create a unique test workspace with a consistent path structure
		const testId = Math.random().toString(36).substring(7);
		testWorkspace = join(TEST_WORKSPACE_BASE, `test-${testId}`);

		// Ensure the workspace directory exists
		if (!existsSync(testWorkspace)) {
			mkdirSync(testWorkspace, { recursive: true });
		}

		// Calculate the SDK project directory path
		// SDK replaces / and . with -
		sdkProjectDir = testWorkspace.replace(/[/.]/g, '-');

		daemon = await spawnDaemonServer();
	});

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
		// Cleanup test workspace
		if (existsSync(testWorkspace)) {
			rmSync(testWorkspace, { recursive: true, force: true });
		}
	});

	test('should reproduce SDK startup timeout with problematic data', async () => {
		// This test reproduces the actual stuck session issue where SDK hangs
		// trying to resume a session with problematic entries.
		//
		// WITHOUT THE FIX: This times out after ~15 seconds with "SDK startup timeout"
		// WITH THE FIX: The cleanup removes problematic entries, SDK resumes successfully

		// Step 1: Create a session and send a message to establish SDK session
		const createResult = (await daemon.messageHub.call('session.create', {
			workspacePath: testWorkspace,
			title: 'Test Session For Timeout Reproduction',
			config: {
				model: 'haiku',
				permissionMode: 'acceptEdits',
			},
		})) as { sessionId: string };

		const { sessionId } = createResult;

		await sendMessage(daemon, sessionId, 'Hello!');
		await waitForIdle(daemon, sessionId, 30000);

		// Step 2: Get the SDK session file path
		const { readdirSync } = require('fs');
		const claudeBase = join(process.env.HOME || '~', '.claude', 'projects', sdkProjectDir);
		const sdkSessionFiles = readdirSync(claudeBase).filter((f: string) => f.endsWith('.jsonl'));
		const sdkSessionFile = join(claudeBase, sdkSessionFiles[0]);

		console.log('[TEST] SDK session file:', sdkSessionFile);

		// Step 3: Backup the original clean file
		const backupFile = sdkSessionFile + '.backup';
		const originalContent = readFileSync(sdkSessionFile, 'utf-8');
		writeFileSync(backupFile, originalContent, 'utf-8');

		try {
			// Step 4: Corrupt the SDK session file by APPENDING problematic data
			// This simulates what happened in the real stuck session where
			// SDK wrote problematic entries to the end of a valid session file
			const problematicContent =
				PROBLEMATIC_SDK_DATA.map((msg) => JSON.stringify(msg)).join('\n') + '\n';
			writeFileSync(sdkSessionFile, originalContent + problematicContent, 'utf-8');

			console.log('[TEST] Appended problematic data to SDK session file');

			// Step 5: Send a message immediately WITHOUT interrupting
			// This will cause the SDK to try to resume the session with the corrupted file
			// and should timeout without the fix
			console.log('[TEST] Sending message to trigger SDK resume with corrupted file...');

			// This should timeout with "SDK startup timeout" if the fix is disabled
			// but succeed if the fix is enabled
			await sendMessage(daemon, sessionId, 'This will trigger resume with problematic data');
			await waitForIdle(daemon, sessionId, 30000);

			console.log('[TEST] Message succeeded - cleanup fix is working!');
		} finally {
			// Always restore the backup
			if (existsSync(backupFile)) {
				writeFileSync(sdkSessionFile, readFileSync(backupFile, 'utf-8'), 'utf-8');
				rmSync(backupFile);
			}
		}
	}, 60000);

	test('should cleanup prevents timeout after interrupt and resume', async () => {
		// This test verifies that the cleanup prevents timeout when resuming
		// after an interrupt. It simulates the real-world scenario where:
		// 1. A session is running
		// 2. The SDK session file gets corrupted
		// 3. The session is interrupted
		// 4. A new message is sent (triggers resume with cleanup)
		//
		// WITH THE FIX: Cleanup removes problematic entries, SDK resumes successfully

		// Step 1: Create a session and send a message to establish SDK session
		const createResult = (await daemon.messageHub.call('session.create', {
			workspacePath: testWorkspace,
			title: 'Test Session For Interrupt Resume',
			config: {
				model: 'haiku',
				permissionMode: 'acceptEdits',
			},
		})) as { sessionId: string };

		const { sessionId } = createResult;

		await sendMessage(daemon, sessionId, 'Hello!');
		await waitForIdle(daemon, sessionId, 30000);

		// Step 2: Get the SDK session file path
		const { readdirSync } = require('fs');
		const claudeBase = join(process.env.HOME || '~', '.claude', 'projects', sdkProjectDir);
		const sdkSessionFiles = readdirSync(claudeBase).filter((f: string) => f.endsWith('.jsonl'));
		const sdkSessionFile = join(claudeBase, sdkSessionFiles[0]);

		console.log('[TEST] SDK session file:', sdkSessionFile);

		// Step 3: Backup the original clean file
		const backupFile = sdkSessionFile + '.backup';
		const originalContent = readFileSync(sdkSessionFile, 'utf-8');
		writeFileSync(backupFile, originalContent, 'utf-8');

		try {
			// Step 4: Corrupt the SDK session file by APPENDING problematic data
			const problematicContent =
				PROBLEMATIC_SDK_DATA.map((msg) => JSON.stringify(msg)).join('\n') + '\n';
			writeFileSync(sdkSessionFile, originalContent + problematicContent, 'utf-8');

			console.log('[TEST] Appended problematic data to SDK session file');

			// Step 5: Interrupt the current session to stop the running query
			// This simulates the query ending/crashing
			await interrupt(daemon, sessionId);
			console.log('[TEST] Interrupted session');

			// Wait a bit for interrupt to complete
			await new Promise((resolve) => setTimeout(resolve, 2000));

			// Step 6: Send another message after interrupt
			// This will trigger a NEW query which will try to RESUME the SDK session
			// The cleanup will run and remove problematic entries before SDK reads the file
			console.log('[TEST] Sending message after interrupt to trigger resume with cleanup...');

			await sendMessage(daemon, sessionId, 'This will trigger resume after interrupt');
			await waitForIdle(daemon, sessionId, 30000);

			console.log('[TEST] Message succeeded - cleanup fix prevents timeout!');
		} finally {
			// Always restore the backup
			if (existsSync(backupFile)) {
				writeFileSync(sdkSessionFile, readFileSync(backupFile, 'utf-8'), 'utf-8');
				rmSync(backupFile);
			}
		}
	}, 60000);

	test('should show that cleanup removes problematic entries', async () => {
		// This test verifies that the cleanup function works correctly
		// by manually calling it and checking the file before and after

		// Create a session and send a message to establish SDK session
		const createResult = (await daemon.messageHub.call('session.create', {
			workspacePath: testWorkspace,
			title: 'Test Session Cleanup Verification',
			config: {
				model: 'haiku',
				permissionMode: 'acceptEdits',
			},
		})) as { sessionId: string };

		const { sessionId } = createResult;

		await sendMessage(daemon, sessionId, 'Hello!');
		await waitForIdle(daemon, sessionId, 30000);

		// Get the SDK session file path
		const { readdirSync } = require('fs');
		const claudeBase = join(process.env.HOME || '~', '.claude', 'projects', sdkProjectDir);
		const sdkSessionFiles = readdirSync(claudeBase).filter((f: string) => f.endsWith('.jsonl'));
		const sdkSessionFile = join(claudeBase, sdkSessionFiles[0]);

		// Backup the original file
		const backupFile = sdkSessionFile + '.backup';
		const originalContent = readFileSync(sdkSessionFile, 'utf-8');
		writeFileSync(backupFile, originalContent, 'utf-8');

		try {
			// Append problematic data to simulate a stuck session
			const problematicContent =
				PROBLEMATIC_SDK_DATA.map((msg) => JSON.stringify(msg)).join('\n') + '\n';
			writeFileSync(sdkSessionFile, originalContent + problematicContent, 'utf-8');

			console.log('[TEST] Appended problematic data to SDK session file');

			// Verify problematic data was written
			const beforeContent = readFileSync(sdkSessionFile, 'utf-8');
			const beforeLines = beforeContent.split('\n').filter((l) => l.trim());

			const queueOpsBefore = beforeLines.filter((line) => {
				try {
					const msg = JSON.parse(line);
					return msg.type === 'queue-operation';
				} catch {
					return false;
				}
			});

			const incompleteBefore = beforeLines.filter((line) => {
				try {
					const msg = JSON.parse(line);
					return msg.type === 'assistant' && msg.message?.stop_reason === null;
				} catch {
					return false;
				}
			});

			expect(queueOpsBefore.length).toBeGreaterThan(0);
			expect(incompleteBefore.length).toBeGreaterThan(0);
			console.log(
				`[TEST] Before cleanup: ${queueOpsBefore.length} queue-ops, ${incompleteBefore.length} incomplete messages`
			);

			// Manually call the cleanup function
			const { cleanQueueOperationEntries } = await import(
				'../../../src/lib/sdk-session-file-manager'
			);
			const cleaned = cleanQueueOperationEntries(sdkSessionFile);

			expect(cleaned).toBe(true);
			console.log('[TEST] Cleanup function returned true');

			// Check the file after cleanup
			const afterContent = readFileSync(sdkSessionFile, 'utf-8');
			const afterLines = afterContent.split('\n').filter((l) => l.trim());

			const queueOpsAfter = afterLines.filter((line) => {
				try {
					const msg = JSON.parse(line);
					return msg.type === 'queue-operation';
				} catch {
					return false;
				}
			});

			const incompleteAfter = afterLines.filter((line) => {
				try {
					const msg = JSON.parse(line);
					return msg.type === 'assistant' && msg.message?.stop_reason === null;
				} catch {
					return false;
				}
			});

			// The cleanup should have removed problematic entries
			console.log(
				`[TEST] After cleanup: ${queueOpsAfter.length} queue-ops, ${incompleteAfter.length} incomplete messages`
			);

			// We expect the cleanup to have removed the queue-operation entries
			expect(queueOpsAfter.length).toBe(0);
			expect(incompleteAfter.length).toBe(0);
		} finally {
			// Always restore the backup
			if (existsSync(backupFile)) {
				writeFileSync(sdkSessionFile, readFileSync(backupFile, 'utf-8'), 'utf-8');
				rmSync(backupFile);
			}
		}
	}, 60000);
});
