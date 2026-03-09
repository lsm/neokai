/**
 * Room Chat Constraints
 *
 * Verifies room chat sessions:
 * - Do not use Claude Code preset system prompt
 * - Use restricted built-in tool allowlist
 * - Still respond to a simple user message
 *
 * MODES:
 * - Real API (default): Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * - Dev Proxy: Set NEOKAI_USE_DEV_PROXY=1 for offline testing with mocked responses
 *
 * Run with Dev Proxy:
 *   NEOKAI_USE_DEV_PROXY=1 bun test packages/daemon/tests/online/room/room-chat-constraints.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { sendMessage, waitForIdle } from '../../helpers/daemon-actions';

// Detect mock mode for faster timeouts (Dev Proxy)
const IS_MOCK = !!process.env.NEOKAI_USE_DEV_PROXY;
const SETUP_TIMEOUT = IS_MOCK ? 10000 : 30000;
const TEARDOWN_TIMEOUT = IS_MOCK ? 10000 : 20000;
const IDLE_TIMEOUT = IS_MOCK ? 5000 : 120000;
const TEST_TIMEOUT = IS_MOCK ? 30000 : 180000;

const ROOM_CHAT_ALLOWED_TOOLS = [
	'Read',
	'Glob',
	'Grep',
	'WebFetch',
	'WebSearch',
	'ToolSearch',
	'AskUserQuestion',
	'Skill',
];

function getMainThreadAssistantText(messages: Array<Record<string, unknown>>): string {
	const texts: string[] = [];

	for (const msg of messages) {
		if (msg.type !== 'assistant') continue;
		if (msg.parent_tool_use_id !== null && msg.parent_tool_use_id !== undefined) continue;

		const betaMessage = msg.message as { content?: Array<Record<string, unknown>> } | undefined;
		if (!betaMessage?.content) continue;

		for (const block of betaMessage.content) {
			if (block.type === 'text' && typeof block.text === 'string') {
				texts.push(block.text);
			}
		}
	}

	return texts.join('\n').trim();
}

describe('Room Chat Constraints', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		daemon = await createDaemonServer();
	}, SETUP_TIMEOUT);

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	}, TEARDOWN_TIMEOUT);

	test(
		'should disable Claude preset, keep restricted tools, and answer a simple message',
		async () => {
			const createRoomResult = (await daemon.messageHub.request('room.create', {
				name: `Room Chat Constraints ${Date.now()}`,
			})) as { room: { id: string } };

			const roomChatSessionId = `room:chat:${createRoomResult.room.id}`;
			daemon.trackSession(roomChatSessionId);

			const daemonWithContext = daemon as DaemonServerContext & {
				daemonContext?: {
					sessionManager: {
						getSessionAsync: (sessionId: string) => Promise<{
							optionsBuilder: {
								build: () => Promise<{
									systemPrompt?: unknown;
									tools?: string[] | { type: 'preset'; preset: 'claude_code' };
									allowedTools?: string[];
								}>;
							};
						} | null>;
					};
				};
			};

			if (!daemonWithContext.daemonContext) {
				throw new Error('This test requires in-process daemon mode (DAEMON_TEST_SPAWN != true).');
			}

			const roomChatSession =
				await daemonWithContext.daemonContext.sessionManager.getSessionAsync(roomChatSessionId);
			expect(roomChatSession).toBeTruthy();
			if (!roomChatSession) return;

			const options = await roomChatSession.optionsBuilder.build();
			expect(options.systemPrompt).toBeUndefined();
			expect(options.tools).toEqual(ROOM_CHAT_ALLOWED_TOOLS);
			expect(options.allowedTools).toEqual(
				expect.arrayContaining([...ROOM_CHAT_ALLOWED_TOOLS, 'room-agent-tools__*'])
			);

			await sendMessage(daemon, roomChatSessionId, 'Reply with exactly: room ok');
			await waitForIdle(daemon, roomChatSessionId, IDLE_TIMEOUT);

			const messageResult = (await daemon.messageHub.request('message.sdkMessages', {
				sessionId: roomChatSessionId,
				limit: 200,
			})) as { sdkMessages: Array<Record<string, unknown>> };
			const sdkMessages = messageResult.sdkMessages || [];
			const assistantText = getMainThreadAssistantText(sdkMessages);
			const resultMessages = sdkMessages.filter((msg) => msg.type === 'result');

			expect(assistantText.length).toBeGreaterThan(0);
			expect(assistantText.toLowerCase()).toContain('room ok');
			expect(resultMessages).toHaveLength(1);
		},
		TEST_TIMEOUT
	);
});
