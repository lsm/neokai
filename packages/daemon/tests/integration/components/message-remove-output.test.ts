/**
 * Message Remove Output Integration Tests
 *
 * Tests the `message.removeOutput` RPC handler which removes tool_result content
 * from SDK session .jsonl files to reduce session size and fix context overflow.
 *
 * Tests cover:
 * 1. Removing tool_result from active session (with SDK session ID)
 * 2. Removing tool_result from old session (fallback search by NeoKai session ID)
 * 3. Error handling for invalid session
 * 4. Error handling for invalid message UUID
 * 5. Error handling for missing session file
 * 6. File content verification after removal
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { TestContext } from '../../test-utils';
import { createTestApp, callRPCHandler } from '../../test-utils';

describe('Message Remove Output Integration Tests', () => {
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
	 * Helper: Create a mock SDK session file
	 */
	function createMockSDKSessionFile(
		workspacePath: string,
		sdkSessionId: string,
		sessionId: string,
		messageUuid: string
	): string {
		// Create directory structure
		// SDK replaces both / and . with - (e.g., /.neokai/ -> --neokai-)
		const projectKey = workspacePath.replace(/[/.]/g, '-');
		testSessionDir = join(homedir(), '.claude', 'projects', projectKey);
		mkdirSync(testSessionDir, { recursive: true });

		// Create mock session file with messages including tool_result
		const sessionFilePath = join(testSessionDir, `${sdkSessionId}.jsonl`);
		const messages = [
			// User message with text
			JSON.stringify({
				type: 'user',
				uuid: '00000000-0000-0000-0000-000000000001',
				session_id: sessionId,
				parent_tool_use_id: null,
				message: {
					role: 'user',
					content: [{ type: 'text', text: 'Hello' }],
				},
			}),
			// Assistant message with tool use
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
							name: 'Task',
							input: { prompt: 'Test task' },
						},
					],
				},
			}),
			// User message with tool_result (this is what we'll delete)
			JSON.stringify({
				type: 'user',
				uuid: messageUuid,
				session_id: sessionId,
				parent_tool_use_id: null,
				message: {
					role: 'user',
					content: [
						{
							type: 'tool_result',
							tool_use_id: 'tool_001',
							content: [
								{
									type: 'text',
									text: 'This is a very large output that we want to remove to save context window space. '.repeat(
										100
									),
								},
							],
						},
					],
				},
			}),
			// Another assistant message
			JSON.stringify({
				type: 'assistant',
				uuid: '00000000-0000-0000-0000-000000000004',
				session_id: sessionId,
				message: {
					role: 'assistant',
					content: [{ type: 'text', text: 'Done' }],
				},
			}),
		];

		writeFileSync(sessionFilePath, messages.join('\n') + '\n', 'utf-8');
		return sessionFilePath;
	}

	/**
	 * Helper: Read and parse .jsonl file
	 */
	function readSDKSessionFile(filePath: string): unknown[] {
		const content = readFileSync(filePath, 'utf-8');
		const lines = content.split('\n').filter((line) => line.trim());
		return lines.map((line) => JSON.parse(line));
	}

	describe('Remove Tool Result with SDK Session ID', () => {
		test('should remove tool_result content from message', async () => {
			// Create session
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
			});

			const session = await ctx.sessionManager.getSessionAsync(sessionId);
			expect(session).toBeDefined();

			// Create mock SDK session file
			const messageUuid = '00000000-0000-0000-0000-000000000003';
			const sdkSessionId = 'test-sdk-session-123';
			const sessionFile = createMockSDKSessionFile(
				process.cwd(),
				sdkSessionId,
				sessionId,
				messageUuid
			);

			// Verify file exists and has tool_result
			expect(existsSync(sessionFile)).toBe(true);
			const messagesBefore = readSDKSessionFile(sessionFile);
			expect(messagesBefore.length).toBe(4);

			const targetMessageBefore = messagesBefore.find(
				(msg: unknown) => (msg as Record<string, unknown>).uuid === messageUuid
			) as Record<string, unknown> | undefined;
			expect(targetMessageBefore).toBeDefined();

			const contentBefore = (targetMessageBefore!.message as Record<string, unknown>)
				.content as unknown[];
			const toolResultBefore = contentBefore[0] as Record<string, unknown>;
			expect(toolResultBefore.type).toBe('tool_result');
			expect((toolResultBefore.content as unknown[]).length).toBeGreaterThan(0);

			// Mock the agent session to return SDK session ID
			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			agentSession!.getSDKSessionId = () => sdkSessionId;

			// Call RPC handler
			const result = await callRPCHandler<{ success: boolean }>(
				ctx.messageHub,
				'message.removeOutput',
				{
					sessionId,
					messageUuid,
				}
			);

			expect(result.success).toBe(true);

			// Verify file was modified
			const messagesAfter = readSDKSessionFile(sessionFile);
			expect(messagesAfter.length).toBe(4); // Same number of messages

			const targetMessageAfter = messagesAfter.find(
				(msg: unknown) => (msg as Record<string, unknown>).uuid === messageUuid
			) as Record<string, unknown> | undefined;
			expect(targetMessageAfter).toBeDefined();

			const contentAfter = (targetMessageAfter!.message as Record<string, unknown>)
				.content as unknown[];
			const toolResultAfter = contentAfter[0] as Record<string, unknown>;
			expect(toolResultAfter.type).toBe('tool_result');

			// Verify content was replaced with placeholder
			const replacedContent = toolResultAfter.content as unknown[];
			expect(replacedContent.length).toBe(1);
			expect((replacedContent[0] as Record<string, unknown>).type).toBe('text');
			expect((replacedContent[0] as Record<string, unknown>).text).toBe(
				'⚠️ Output removed by user. Run again with filter to narrow down the message.'
			);
		});

		test('should preserve other messages when removing tool_result', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
			});

			const messageUuid = '00000000-0000-0000-0000-000000000003';
			const sdkSessionId = 'test-sdk-session-456';
			const sessionFile = createMockSDKSessionFile(
				process.cwd(),
				sdkSessionId,
				sessionId,
				messageUuid
			);

			// Mock SDK session ID
			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			agentSession!.getSDKSessionId = () => sdkSessionId;

			const messagesBefore = readSDKSessionFile(sessionFile);
			const firstMessageBefore = messagesBefore[0] as Record<string, unknown>;
			const lastMessageBefore = messagesBefore[3] as Record<string, unknown>;

			// Call RPC handler
			await callRPCHandler(ctx.messageHub, 'message.removeOutput', {
				sessionId,
				messageUuid,
			});

			// Verify other messages unchanged
			const messagesAfter = readSDKSessionFile(sessionFile);
			const firstMessageAfter = messagesAfter[0] as Record<string, unknown>;
			const lastMessageAfter = messagesAfter[3] as Record<string, unknown>;

			expect(firstMessageAfter.uuid).toBe(firstMessageBefore.uuid);
			expect(lastMessageAfter.uuid).toBe(lastMessageBefore.uuid);
			expect(JSON.stringify(firstMessageAfter)).toBe(JSON.stringify(firstMessageBefore));
			expect(JSON.stringify(lastMessageAfter)).toBe(JSON.stringify(lastMessageBefore));
		});
	});

	describe('Remove Tool Result with Fallback Search', () => {
		test('should find session file by NeoKai session ID when SDK session ID unavailable', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
			});

			const messageUuid = '00000000-0000-0000-0000-000000000003';
			const sdkSessionId = 'test-sdk-session-789';
			const sessionFile = createMockSDKSessionFile(
				process.cwd(),
				sdkSessionId,
				sessionId,
				messageUuid
			);

			// Mock SDK session ID to return null (simulating old session)
			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			agentSession!.getSDKSessionId = () => null;

			// Verify file exists
			expect(existsSync(sessionFile)).toBe(true);

			// Call RPC handler - should use fallback search
			const result = await callRPCHandler<{ success: boolean }>(
				ctx.messageHub,
				'message.removeOutput',
				{
					sessionId,
					messageUuid,
				}
			);

			expect(result.success).toBe(true);

			// Verify content was replaced
			const messagesAfter = readSDKSessionFile(sessionFile);
			const targetMessage = messagesAfter.find(
				(msg: unknown) => (msg as Record<string, unknown>).uuid === messageUuid
			) as Record<string, unknown> | undefined;

			expect(targetMessage).toBeDefined();
			const content = (targetMessage!.message as Record<string, unknown>).content as unknown[];
			const toolResult = content[0] as Record<string, unknown>;
			const replacedContent = toolResult.content as unknown[];
			expect((replacedContent[0] as Record<string, unknown>).text).toContain(
				'⚠️ Output removed by user'
			);
		});
	});

	describe('Error Handling', () => {
		test('should throw error for invalid session ID', async () => {
			await expect(
				callRPCHandler(ctx.messageHub, 'message.removeOutput', {
					sessionId: 'invalid-session-id',
					messageUuid: '00000000-0000-0000-0000-000000000003',
				})
			).rejects.toThrow('Session not found');
		});

		test('should throw error when session file not found', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			agentSession!.getSDKSessionId = () => 'nonexistent-sdk-session';

			await expect(
				callRPCHandler(ctx.messageHub, 'message.removeOutput', {
					sessionId,
					messageUuid: '00000000-0000-0000-0000-000000000003',
				})
			).rejects.toThrow('Failed to remove output from SDK session file');
		});

		test('should throw error when message UUID not found in file', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
			});

			const sdkSessionId = 'test-sdk-session-error-1';
			createMockSDKSessionFile(
				process.cwd(),
				sdkSessionId,
				sessionId,
				'00000000-0000-0000-0000-000000000003'
			);

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			agentSession!.getSDKSessionId = () => sdkSessionId;

			await expect(
				callRPCHandler(ctx.messageHub, 'message.removeOutput', {
					sessionId,
					messageUuid: 'nonexistent-message-uuid',
				})
			).rejects.toThrow('Failed to remove output from SDK session file');
		});

		test('should throw error when message has no tool_result', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
			});

			const sdkSessionId = 'test-sdk-session-error-2';
			const projectKey = process.cwd().replace(/[/.]/g, '-');
			testSessionDir = join(homedir(), '.claude', 'projects', projectKey);
			mkdirSync(testSessionDir, { recursive: true });

			// Create file with message that has no tool_result
			const sessionFilePath = join(testSessionDir, `${sdkSessionId}.jsonl`);
			const messageUuid = '00000000-0000-0000-0000-000000000005';
			const messages = [
				JSON.stringify({
					type: 'user',
					uuid: messageUuid,
					session_id: sessionId,
					parent_tool_use_id: null,
					message: {
						role: 'user',
						content: [{ type: 'text', text: 'Just text, no tool_result' }],
					},
				}),
			];
			writeFileSync(sessionFilePath, messages.join('\n') + '\n', 'utf-8');

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			agentSession!.getSDKSessionId = () => sdkSessionId;

			await expect(
				callRPCHandler(ctx.messageHub, 'message.removeOutput', {
					sessionId,
					messageUuid,
				})
			).rejects.toThrow('Failed to remove output from SDK session file');
		});
	});

	describe('File Content Integrity', () => {
		test('should maintain valid JSON structure in .jsonl file', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
			});

			const messageUuid = '00000000-0000-0000-0000-000000000003';
			const sdkSessionId = 'test-sdk-session-integrity';
			const sessionFile = createMockSDKSessionFile(
				process.cwd(),
				sdkSessionId,
				sessionId,
				messageUuid
			);

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			agentSession!.getSDKSessionId = () => sdkSessionId;

			await callRPCHandler(ctx.messageHub, 'message.removeOutput', {
				sessionId,
				messageUuid,
			});

			// Verify file can be parsed without errors
			expect(() => readSDKSessionFile(sessionFile)).not.toThrow();

			// Verify each line is valid JSON
			const content = readFileSync(sessionFile, 'utf-8');
			const lines = content.split('\n').filter((line) => line.trim());

			lines.forEach((line) => {
				expect(() => JSON.parse(line)).not.toThrow();
				const parsed = JSON.parse(line);
				expect(parsed).toHaveProperty('type');
				expect(parsed).toHaveProperty('uuid');
				expect(parsed).toHaveProperty('message');
			});
		});

		test('should maintain file ending with newline', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
			});

			const messageUuid = '00000000-0000-0000-0000-000000000003';
			const sdkSessionId = 'test-sdk-session-newline';
			const sessionFile = createMockSDKSessionFile(
				process.cwd(),
				sdkSessionId,
				sessionId,
				messageUuid
			);

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			agentSession!.getSDKSessionId = () => sdkSessionId;

			await callRPCHandler(ctx.messageHub, 'message.removeOutput', {
				sessionId,
				messageUuid,
			});

			// Verify file ends with newline
			const content = readFileSync(sessionFile, 'utf-8');
			expect(content.endsWith('\n')).toBe(true);
		});
	});

	describe('Multiple Tool Results', () => {
		test('should only modify tool_result in specified message', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: process.cwd(),
			});

			const sdkSessionId = 'test-sdk-session-multiple';
			const projectKey = process.cwd().replace(/[/.]/g, '-');
			testSessionDir = join(homedir(), '.claude', 'projects', projectKey);
			mkdirSync(testSessionDir, { recursive: true });

			const targetMessageUuid = '00000000-0000-0000-0000-000000000003';
			const otherMessageUuid = '00000000-0000-0000-0000-000000000005';

			// Create file with multiple messages with tool_results
			const sessionFilePath = join(testSessionDir, `${sdkSessionId}.jsonl`);
			const messages = [
				JSON.stringify({
					type: 'user',
					uuid: targetMessageUuid,
					session_id: sessionId,
					parent_tool_use_id: null,
					message: {
						role: 'user',
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'tool_001',
								content: [{ type: 'text', text: 'Target result to remove' }],
							},
						],
					},
				}),
				JSON.stringify({
					type: 'user',
					uuid: otherMessageUuid,
					session_id: sessionId,
					parent_tool_use_id: null,
					message: {
						role: 'user',
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'tool_002',
								content: [{ type: 'text', text: 'Other result to keep' }],
							},
						],
					},
				}),
			];
			writeFileSync(sessionFilePath, messages.join('\n') + '\n', 'utf-8');

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			agentSession!.getSDKSessionId = () => sdkSessionId;

			// Remove only the target message
			await callRPCHandler(ctx.messageHub, 'message.removeOutput', {
				sessionId,
				messageUuid: targetMessageUuid,
			});

			// Verify changes
			const messagesAfter = readSDKSessionFile(sessionFilePath);

			const targetMessage = messagesAfter.find(
				(msg: unknown) => (msg as Record<string, unknown>).uuid === targetMessageUuid
			) as Record<string, unknown>;
			const otherMessage = messagesAfter.find(
				(msg: unknown) => (msg as Record<string, unknown>).uuid === otherMessageUuid
			) as Record<string, unknown>;

			// Target message should have placeholder
			const targetContent = (targetMessage.message as Record<string, unknown>).content as unknown[];
			const targetToolResult = targetContent[0] as Record<string, unknown>;
			const targetReplacedContent = targetToolResult.content as unknown[];
			expect((targetReplacedContent[0] as Record<string, unknown>).text).toContain(
				'⚠️ Output removed by user'
			);

			// Other message should be unchanged
			const otherContent = (otherMessage.message as Record<string, unknown>).content as unknown[];
			const otherToolResult = otherContent[0] as Record<string, unknown>;
			const otherOriginalContent = otherToolResult.content as unknown[];
			expect((otherOriginalContent[0] as Record<string, unknown>).text).toBe(
				'Other result to keep'
			);
		});
	});
});
