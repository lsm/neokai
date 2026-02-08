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
import type { TestContext } from '../../helpers/test-app';
import { createTestApp, callRPCHandler } from '../../helpers/test-app';

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

// =============================================================================
// SDK Session Load Validation (merged from message-remove-output-sdk-load.test.ts)
// =============================================================================

describe('SDK Session Load Validation', () => {
	let ctx: TestContext;
	let testSessionDir: string;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();

		if (testSessionDir && existsSync(testSessionDir)) {
			try {
				rmSync(testSessionDir, { recursive: true, force: true });
			} catch {
				// Ignore
			}
		}
	});

	/**
	 * Simulate what Claude Agent SDK does when loading a session:
	 * Reads the .jsonl file and reconstructs the message array
	 */
	function loadSDKSessionAsSDKWould(sessionFilePath: string): unknown[] {
		const content = readFileSync(sessionFilePath, 'utf-8');
		const lines = content.split('\n').filter((line) => line.trim());

		return lines.map((line) => {
			const entry = JSON.parse(line) as Record<string, unknown>;
			// SDK extracts just the message part
			return entry.message;
		});
	}

	test('SDK should receive placeholder instead of large output when loading session', async () => {
		const sessionId = await ctx.sessionManager.createSession({
			workspacePath: process.cwd(),
		});

		const sdkSessionId = 'test-sdk-load-validation';
		const messageUuid = '00000000-0000-0000-0000-000000000003';

		const projectKey = process.cwd().replace(/[/.]/g, '-');
		testSessionDir = join(homedir(), '.claude', 'projects', projectKey);
		mkdirSync(testSessionDir, { recursive: true });

		const sessionFilePath = join(testSessionDir, `${sdkSessionId}.jsonl`);

		// Create session with large output (100KB)
		const largeOutput = 'Very large tool output content. '.repeat(3000);
		const messages = [
			JSON.stringify({
				type: 'user',
				uuid: '00000000-0000-0000-0000-000000000001',
				session_id: sessionId,
				message: {
					role: 'user',
					content: [{ type: 'text', text: 'Test' }],
				},
			}),
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
							input: {},
						},
					],
				},
			}),
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
		];

		writeFileSync(sessionFilePath, messages.join('\n') + '\n', 'utf-8');

		const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
		agentSession!.getSDKSessionId = () => sdkSessionId;

		// Simulate SDK loading session BEFORE removal
		const messagesBefore = loadSDKSessionAsSDKWould(sessionFilePath);
		const toolResultMessageBefore = messagesBefore[2] as Record<string, unknown>;
		const contentBefore = (toolResultMessageBefore.content as unknown[])[0] as Record<
			string,
			unknown
		>;
		const contentBlocksBefore = contentBefore.content as unknown[];
		const textBlockBefore = contentBlocksBefore[0] as Record<string, unknown>;

		expect(textBlockBefore.text).toBe(largeOutput);
		expect((textBlockBefore.text as string).length).toBeGreaterThan(90000);

		console.log('[Test] Before removal - SDK would receive:', {
			textLength: (textBlockBefore.text as string).length,
			preview: (textBlockBefore.text as string).slice(0, 50) + '...',
		});

		// Remove output
		await callRPCHandler(ctx.messageHub, 'message.removeOutput', {
			sessionId,
			messageUuid,
		});

		// Simulate SDK loading session AFTER removal
		const messagesAfter = loadSDKSessionAsSDKWould(sessionFilePath);
		const toolResultMessageAfter = messagesAfter[2] as Record<string, unknown>;
		const contentAfter = (toolResultMessageAfter.content as unknown[])[0] as Record<
			string,
			unknown
		>;
		const contentBlocksAfter = contentAfter.content as unknown[];
		const textBlockAfter = contentBlocksAfter[0] as Record<string, unknown>;

		// SDK should now receive the placeholder
		expect(textBlockAfter.text).toContain('⚠️ Output removed by user');
		expect((textBlockAfter.text as string).length).toBeLessThan(200);

		console.log('[Test] After removal - SDK would receive:', {
			textLength: (textBlockAfter.text as string).length,
			content: textBlockAfter.text,
		});

		// Verify message structure is still valid for SDK
		expect(messagesAfter.length).toBe(3);
		expect(toolResultMessageAfter.role).toBe('user');
		expect((toolResultMessageAfter.content as unknown[]).length).toBe(1);
		expect(contentAfter.type).toBe('tool_result');
		expect(contentAfter.tool_use_id).toBe('tool_001');
	});

	test('SDK message array structure should remain valid after removal', async () => {
		const sessionId = await ctx.sessionManager.createSession({
			workspacePath: process.cwd(),
		});

		const sdkSessionId = 'test-sdk-structure-validation';
		const messageUuid = '00000000-0000-0000-0000-000000000005';

		const projectKey = process.cwd().replace(/[/.]/g, '-');
		testSessionDir = join(homedir(), '.claude', 'projects', projectKey);
		mkdirSync(testSessionDir, { recursive: true });

		const sessionFilePath = join(testSessionDir, `${sdkSessionId}.jsonl`);

		// Create a realistic session with multiple turns
		const messages = [
			// Turn 1
			JSON.stringify({
				type: 'user',
				uuid: '00000000-0000-0000-0000-000000000001',
				session_id: sessionId,
				message: {
					role: 'user',
					content: [{ type: 'text', text: 'List files' }],
				},
			}),
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
							name: 'Bash',
							input: { command: 'ls -la' },
						},
					],
				},
			}),
			JSON.stringify({
				type: 'user',
				uuid: '00000000-0000-0000-0000-000000000003',
				session_id: sessionId,
				message: {
					role: 'user',
					content: [
						{
							type: 'tool_result',
							tool_use_id: 'tool_001',
							content: [{ type: 'text', text: 'file1.txt\nfile2.txt' }],
						},
					],
				},
			}),
			JSON.stringify({
				type: 'assistant',
				uuid: '00000000-0000-0000-0000-000000000004',
				session_id: sessionId,
				message: {
					role: 'assistant',
					content: [{ type: 'text', text: 'Found 2 files' }],
				},
			}),
			// Turn 2 - Large output to be removed
			JSON.stringify({
				type: 'user',
				uuid: messageUuid,
				session_id: sessionId,
				message: {
					role: 'user',
					content: [
						{
							type: 'tool_result',
							tool_use_id: 'tool_002',
							content: [{ type: 'text', text: 'X'.repeat(50000) }],
						},
					],
				},
			}),
			// Turn 3 - After the large output
			JSON.stringify({
				type: 'assistant',
				uuid: '00000000-0000-0000-0000-000000000006',
				session_id: sessionId,
				message: {
					role: 'assistant',
					content: [{ type: 'text', text: 'Processed the data' }],
				},
			}),
		];

		writeFileSync(sessionFilePath, messages.join('\n') + '\n', 'utf-8');

		const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
		agentSession!.getSDKSessionId = () => sdkSessionId;

		// Remove the large output
		await callRPCHandler(ctx.messageHub, 'message.removeOutput', {
			sessionId,
			messageUuid,
		});

		// Load as SDK would
		const sdkMessages = loadSDKSessionAsSDKWould(sessionFilePath);

		// Validate structure
		expect(sdkMessages.length).toBe(6);

		// Check message roles alternate correctly
		expect((sdkMessages[0] as Record<string, unknown>).role).toBe('user');
		expect((sdkMessages[1] as Record<string, unknown>).role).toBe('assistant');
		expect((sdkMessages[2] as Record<string, unknown>).role).toBe('user');
		expect((sdkMessages[3] as Record<string, unknown>).role).toBe('assistant');
		expect((sdkMessages[4] as Record<string, unknown>).role).toBe('user'); // Modified message
		expect((sdkMessages[5] as Record<string, unknown>).role).toBe('assistant');

		// Check the modified message
		const modifiedMessage = sdkMessages[4] as Record<string, unknown>;
		const content = modifiedMessage.content as unknown[];
		expect(content.length).toBe(1);

		const toolResult = content[0] as Record<string, unknown>;
		expect(toolResult.type).toBe('tool_result');
		expect(toolResult.tool_use_id).toBe('tool_002');

		const resultContent = toolResult.content as unknown[];
		expect(resultContent.length).toBe(1);

		const textBlock = resultContent[0] as Record<string, unknown>;
		expect(textBlock.type).toBe('text');
		expect(textBlock.text).toContain('⚠️ Output removed by user');

		console.log('[Test] Message structure validation passed');
		console.log('[Test] SDK would receive valid alternating user/assistant messages');
		console.log('[Test] Tool result structure preserved with placeholder content');
	});

	test('Multiple removed outputs should all be placeholders when SDK loads', async () => {
		const sessionId = await ctx.sessionManager.createSession({
			workspacePath: process.cwd(),
		});

		const sdkSessionId = 'test-sdk-multiple-placeholders';

		const projectKey = process.cwd().replace(/[/.]/g, '-');
		testSessionDir = join(homedir(), '.claude', 'projects', projectKey);
		mkdirSync(testSessionDir, { recursive: true });

		const sessionFilePath = join(testSessionDir, `${sdkSessionId}.jsonl`);

		// Create session with 3 large outputs
		const messages = [];
		const uuidsToRemove = [];

		for (let i = 0; i < 3; i++) {
			const uuid = `tool_result_${i}`;
			uuidsToRemove.push(uuid);

			messages.push(
				JSON.stringify({
					type: 'user',
					uuid,
					session_id: sessionId,
					message: {
						role: 'user',
						content: [
							{
								type: 'tool_result',
								tool_use_id: `tool_${i}`,
								content: [
									{
										type: 'text',
										text: `Large output ${i}: ${'X'.repeat(20000)}`,
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

		// Remove all three
		for (const uuid of uuidsToRemove) {
			await callRPCHandler(ctx.messageHub, 'message.removeOutput', {
				sessionId,
				messageUuid: uuid,
			});
		}

		// Load as SDK would
		const sdkMessages = loadSDKSessionAsSDKWould(sessionFilePath);

		// All three should have placeholders
		for (let i = 0; i < 3; i++) {
			const msg = sdkMessages[i] as Record<string, unknown>;
			const content = (msg.content as unknown[])[0] as Record<string, unknown>;
			const resultContent = (content.content as unknown[])[0] as Record<string, unknown>;

			expect(resultContent.text).toContain('⚠️ Output removed by user');
			expect((resultContent.text as string).length).toBeLessThan(200);

			console.log(
				`[Test] Tool result ${i} - placeholder size:`,
				(resultContent.text as string).length
			);
		}

		console.log('[Test] All removed outputs are placeholders when SDK loads session');
	});
});

// =============================================================================
// SDK Context Validation (merged from message-remove-output-context-validation.test.ts)
// =============================================================================

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
