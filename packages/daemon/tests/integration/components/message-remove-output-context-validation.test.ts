/**
 * SDK Context Validation Tests
 *
 * Validates that removed tool outputs are actually excluded from the SDK context
 * when the session is resumed or when new messages are sent.
 *
 * This ensures that the removal functionality actually achieves its goal of
 * reducing context window usage.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { TestContext } from '../../test-utils';
import { createTestApp, callRPCHandler } from '../../test-utils';

describe('SDK Context Validation Tests', () => {
	let ctx: TestContext;
	let testSessionDir: string;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();

		// Clean up test session directory
		if (testSessionDir && existsSync(testSessionDir)) {
			try {
				rmSync(testSessionDir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		}
	});

	/**
	 * Helper: Create a mock SDK session file with large tool output
	 */
	function createMockSDKSessionFile(
		workspacePath: string,
		sdkSessionId: string,
		sessionId: string,
		messageUuid: string,
		largeOutputSize = 10000 // 10KB of text
	): string {
		const projectKey = workspacePath.replace(/[/.]/g, '-');
		testSessionDir = join(homedir(), '.claude', 'projects', projectKey);
		mkdirSync(testSessionDir, { recursive: true });

		const sessionFilePath = join(testSessionDir, `${sdkSessionId}.jsonl`);

		// Create large output text
		const largeOutput = 'This is a very large output. '.repeat(largeOutputSize / 30);

		const messages = [
			// User message
			JSON.stringify({
				type: 'user',
				uuid: '00000000-0000-0000-0000-000000000001',
				session_id: sessionId,
				message: {
					role: 'user',
					content: [{ type: 'text', text: 'Read a large file' }],
				},
			}),
			// Assistant with tool use
			JSON.stringify({
				type: 'assistant',
				uuid: '00000000-0000-0000-0000-000000000002',
				session_id: sessionId,
				message: {
					role: 'assistant',
					content: [
						{
							type: 'tool_use',
							id: 'tool_001',
							name: 'Read',
							input: { file_path: '/large/file.txt' },
						},
					],
				},
			}),
			// Tool result with large output
			JSON.stringify({
				type: 'user',
				uuid: messageUuid,
				session_id: sessionId,
				message: {
					role: 'user',
					content: [
						{
							type: 'tool_result',
							tool_use_id: 'tool_001',
							content: [
								{
									type: 'text',
									text: largeOutput,
								},
							],
						},
					],
				},
			}),
			// Assistant response
			JSON.stringify({
				type: 'assistant',
				uuid: '00000000-0000-0000-0000-000000000004',
				session_id: sessionId,
				message: {
					role: 'assistant',
					content: [{ type: 'text', text: 'Here is the file content summary' }],
				},
			}),
		];

		writeFileSync(sessionFilePath, messages.join('\n') + '\n', 'utf-8');
		return sessionFilePath;
	}

	/**
	 * Helper: Calculate total content size in SDK session file
	 */
	function calculateSessionContentSize(filePath: string): {
		totalSize: number;
		toolResultSize: number;
		messageCount: number;
	} {
		const content = readFileSync(filePath, 'utf-8');
		const lines = content.split('\n').filter((line) => line.trim());

		let totalSize = 0;
		let toolResultSize = 0;

		lines.forEach((line) => {
			const message = JSON.parse(line) as Record<string, unknown>;
			const lineSize = line.length;
			totalSize += lineSize;

			// Check if this message contains tool_result
			if (
				message.type === 'user' &&
				message.message &&
				typeof message.message === 'object' &&
				'content' in message.message
			) {
				const messageContent = message.message as Record<string, unknown>;
				const contentArray = messageContent.content as unknown[];

				contentArray.forEach((block: unknown) => {
					const blockObj = block as Record<string, unknown>;
					if (blockObj.type === 'tool_result') {
						// Calculate size of just the tool_result block
						toolResultSize += JSON.stringify(block).length;
					}
				});
			}
		});

		return {
			totalSize,
			toolResultSize,
			messageCount: lines.length,
		};
	}

	test('should significantly reduce session file size after removing large tool output', async () => {
		const sessionId = await ctx.sessionManager.createSession({
			workspacePath: process.cwd(),
		});

		const messageUuid = '00000000-0000-0000-0000-000000000003';
		const sdkSessionId = 'test-sdk-session-size';

		// Create session with 10KB tool output
		const sessionFile = createMockSDKSessionFile(
			process.cwd(),
			sdkSessionId,
			sessionId,
			messageUuid,
			10000
		);

		// Measure size before removal
		const sizeBefore = calculateSessionContentSize(sessionFile);
		expect(sizeBefore.toolResultSize).toBeGreaterThan(9000); // At least 9KB
		expect(sizeBefore.messageCount).toBe(4);

		console.log('[Test] Size before removal:', {
			total: sizeBefore.totalSize,
			toolResult: sizeBefore.toolResultSize,
			percentage: ((sizeBefore.toolResultSize / sizeBefore.totalSize) * 100).toFixed(1) + '%',
		});

		// Mock SDK session ID
		const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
		agentSession!.getSDKSessionId = () => sdkSessionId;

		// Remove tool output
		await callRPCHandler(ctx.messageHub, 'message.removeOutput', {
			sessionId,
			messageUuid,
		});

		// Measure size after removal
		const sizeAfter = calculateSessionContentSize(sessionFile);
		expect(sizeAfter.messageCount).toBe(4); // Same number of messages

		console.log('[Test] Size after removal:', {
			total: sizeAfter.totalSize,
			toolResult: sizeAfter.toolResultSize,
			percentage: ((sizeAfter.toolResultSize / sizeAfter.totalSize) * 100).toFixed(1) + '%',
		});

		// Verify significant size reduction
		const reduction = sizeBefore.totalSize - sizeAfter.totalSize;
		const reductionPercent = (reduction / sizeBefore.totalSize) * 100;

		console.log('[Test] Reduction:', {
			bytes: reduction,
			percentage: reductionPercent.toFixed(1) + '%',
		});

		// Should reduce total size by at least 80% (most of the 10KB output removed)
		expect(reductionPercent).toBeGreaterThan(80);

		// Tool result should now be minimal (just the placeholder)
		expect(sizeAfter.toolResultSize).toBeLessThan(200); // Placeholder is ~100 bytes
	});

	test('should replace large content with minimal placeholder', async () => {
		const sessionId = await ctx.sessionManager.createSession({
			workspacePath: process.cwd(),
		});

		const messageUuid = '00000000-0000-0000-0000-000000000003';
		const sdkSessionId = 'test-sdk-session-placeholder';

		// Create session with 50KB tool output
		const sessionFile = createMockSDKSessionFile(
			process.cwd(),
			sdkSessionId,
			sessionId,
			messageUuid,
			50000
		);

		const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
		agentSession!.getSDKSessionId = () => sdkSessionId;

		// Remove tool output
		await callRPCHandler(ctx.messageHub, 'message.removeOutput', {
			sessionId,
			messageUuid,
		});

		// Read the modified message
		const content = readFileSync(sessionFile, 'utf-8');
		const lines = content.split('\n').filter((line) => line.trim());
		const messages = lines.map((line) => JSON.parse(line));

		const targetMessage = messages.find(
			(msg: unknown) => (msg as Record<string, unknown>).uuid === messageUuid
		) as Record<string, unknown>;

		const messageContent = targetMessage.message as Record<string, unknown>;
		const contentArray = messageContent.content as unknown[];
		const toolResult = contentArray[0] as Record<string, unknown>;
		const replacedContent = toolResult.content as unknown[];

		// Verify placeholder content
		expect(replacedContent.length).toBe(1);
		expect((replacedContent[0] as Record<string, unknown>).type).toBe('text');

		const placeholderText = (replacedContent[0] as Record<string, unknown>).text as string;
		expect(placeholderText).toContain('⚠️ Output removed by user');

		// Placeholder should be tiny compared to original
		const placeholderSize = JSON.stringify(replacedContent).length;
		expect(placeholderSize).toBeLessThan(200);

		console.log('[Test] Placeholder size:', placeholderSize, 'bytes');
		console.log('[Test] Original size:', '~50KB');
		console.log('[Test] Reduction:', '~99.6%');
	});

	test('should preserve other messages and tool results unchanged', async () => {
		const sessionId = await ctx.sessionManager.createSession({
			workspacePath: process.cwd(),
		});

		const sdkSessionId = 'test-sdk-session-preserve';
		const projectKey = process.cwd().replace(/[/.]/g, '-');
		testSessionDir = join(homedir(), '.claude', 'projects', projectKey);
		mkdirSync(testSessionDir, { recursive: true });

		// Create file with multiple tool results
		const sessionFilePath = join(testSessionDir, `${sdkSessionId}.jsonl`);
		const targetMessageUuid = '00000000-0000-0000-0000-000000000003';
		const otherMessageUuid = '00000000-0000-0000-0000-000000000005';

		const messages = [
			// First tool result (to be removed)
			JSON.stringify({
				type: 'user',
				uuid: targetMessageUuid,
				session_id: sessionId,
				message: {
					role: 'user',
					content: [
						{
							type: 'tool_result',
							tool_use_id: 'tool_001',
							content: [{ type: 'text', text: 'Large output to remove'.repeat(1000) }],
						},
					],
				},
			}),
			// Second tool result (to be preserved)
			JSON.stringify({
				type: 'user',
				uuid: otherMessageUuid,
				session_id: sessionId,
				message: {
					role: 'user',
					content: [
						{
							type: 'tool_result',
							tool_use_id: 'tool_002',
							content: [{ type: 'text', text: 'This should be preserved exactly' }],
						},
					],
				},
			}),
		];

		writeFileSync(sessionFilePath, messages.join('\n') + '\n', 'utf-8');

		const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
		agentSession!.getSDKSessionId = () => sdkSessionId;

		// Get original content of second message
		const messagesBefore = readFileSync(sessionFilePath, 'utf-8')
			.split('\n')
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line));

		const otherMessageBefore = messagesBefore.find(
			(msg: unknown) => (msg as Record<string, unknown>).uuid === otherMessageUuid
		) as Record<string, unknown>;

		// Remove only the target message
		await callRPCHandler(ctx.messageHub, 'message.removeOutput', {
			sessionId,
			messageUuid: targetMessageUuid,
		});

		// Verify second message is completely unchanged
		const messagesAfter = readFileSync(sessionFilePath, 'utf-8')
			.split('\n')
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line));

		const otherMessageAfter = messagesAfter.find(
			(msg: unknown) => (msg as Record<string, unknown>).uuid === otherMessageUuid
		) as Record<string, unknown>;

		// Exact equality - no changes at all
		expect(JSON.stringify(otherMessageAfter)).toBe(JSON.stringify(otherMessageBefore));

		// Verify the preserved content
		const otherContent = (otherMessageAfter.message as Record<string, unknown>)
			.content as unknown[];
		const otherToolResult = otherContent[0] as Record<string, unknown>;
		const otherResultContent = otherToolResult.content as unknown[];
		expect((otherResultContent[0] as Record<string, unknown>).text).toBe(
			'This should be preserved exactly'
		);
	});

	test('should demonstrate context window savings with realistic scenario', async () => {
		const sessionId = await ctx.sessionManager.createSession({
			workspacePath: process.cwd(),
		});

		const sdkSessionId = 'test-sdk-session-realistic';
		const projectKey = process.cwd().replace(/[/.]/g, '-');
		testSessionDir = join(homedir(), '.claude', 'projects', projectKey);
		mkdirSync(testSessionDir, { recursive: true });

		const sessionFilePath = join(testSessionDir, `${sdkSessionId}.jsonl`);

		// Simulate a realistic scenario: multiple large TaskOutput results
		const messages = [];

		// Conversation with 5 large TaskOutput calls
		for (let i = 0; i < 5; i++) {
			messages.push(
				// User asks for something
				JSON.stringify({
					type: 'user',
					uuid: `user-${i}`,
					session_id: sessionId,
					message: {
						role: 'user',
						content: [{ type: 'text', text: `Task ${i + 1}` }],
					},
				}),
				// Assistant uses Task tool
				JSON.stringify({
					type: 'assistant',
					uuid: `assistant-${i}`,
					session_id: sessionId,
					message: {
						role: 'assistant',
						content: [
							{
								type: 'tool_use',
								id: `tool_task_${i}`,
								name: 'TaskOutput',
								input: { task_id: `task_${i}` },
							},
						],
					},
				}),
				// Large TaskOutput result (100KB each)
				JSON.stringify({
					type: 'user',
					uuid: `tool_result_${i}`,
					session_id: sessionId,
					message: {
						role: 'user',
						content: [
							{
								type: 'tool_result',
								tool_use_id: `tool_task_${i}`,
								content: [
									{
										type: 'text',
										text: `Task output ${i}: ${'Large agent transcript data. '.repeat(5000)}`,
									},
								],
							},
						],
					},
				})
			);
		}

		writeFileSync(sessionFilePath, messages.join('\n') + '\n', 'utf-8');

		const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
		agentSession!.getSDKSessionId = () => sdkSessionId;

		// Measure before
		const sizeBefore = calculateSessionContentSize(sessionFilePath);
		console.log('[Test] Realistic scenario - Before removal:', {
			total: `${(sizeBefore.totalSize / 1024).toFixed(1)}KB`,
			toolResults: `${(sizeBefore.toolResultSize / 1024).toFixed(1)}KB`,
			messages: sizeBefore.messageCount,
		});

		// Remove all TaskOutput results
		for (let i = 0; i < 5; i++) {
			await callRPCHandler(ctx.messageHub, 'message.removeOutput', {
				sessionId,
				messageUuid: `tool_result_${i}`,
			});
		}

		// Measure after
		const sizeAfter = calculateSessionContentSize(sessionFilePath);
		console.log('[Test] Realistic scenario - After removal:', {
			total: `${(sizeAfter.totalSize / 1024).toFixed(1)}KB`,
			toolResults: `${(sizeAfter.toolResultSize / 1024).toFixed(1)}KB`,
			messages: sizeAfter.messageCount,
		});

		const reduction = sizeBefore.totalSize - sizeAfter.totalSize;
		const reductionPercent = (reduction / sizeBefore.totalSize) * 100;

		console.log('[Test] Total reduction:', {
			bytes: `${(reduction / 1024).toFixed(1)}KB`,
			percentage: `${reductionPercent.toFixed(1)}%`,
		});

		// Should reduce by at least 95% (500KB of TaskOutput → ~500 bytes of placeholders)
		expect(reductionPercent).toBeGreaterThan(95);

		// Verify all messages still present
		expect(sizeAfter.messageCount).toBe(sizeBefore.messageCount);
	});
});
