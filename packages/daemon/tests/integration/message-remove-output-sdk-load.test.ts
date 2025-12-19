/**
 * SDK Session Load Validation Tests
 *
 * Validates that when Claude Agent SDK loads a session file after tool output removal,
 * it receives the reduced content (placeholder) instead of the original large output.
 *
 * This ensures the feature actually prevents context overflow when resuming sessions.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { TestContext } from '../test-utils';
import { createTestApp, callRPCHandler } from '../test-utils';

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

		const projectKey = process.cwd().replace(/\//g, '-');
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

		const projectKey = process.cwd().replace(/\//g, '-');
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

		const projectKey = process.cwd().replace(/\//g, '-');
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
								content: [{ type: 'text', text: `Large output ${i}: ${'X'.repeat(20000)}` }],
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
