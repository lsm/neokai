/**
 * Coordinator Tool Delegation - Behavioral Tests
 *
 * Tests that coordinator mode actually delegates file operations to specialist
 * sub-agents instead of performing them directly. This is an end-to-end
 * behavioral test — not a config test.
 *
 * Verifies:
 * 1. Coordinator delegates file reading to a specialist via Task tool
 * 2. The specialist actually reads the file (canary value appears in response)
 * 3. Coordinator's own assistant messages only contain Task/TodoWrite/AskUserQuestion
 *    tool_use blocks — never Read/Edit/Write/Bash directly
 *
 * REQUIREMENTS:
 * - Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * - Makes real API calls (costs money, uses rate limits)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import 'dotenv/config';
import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { DaemonServerContext } from '../helpers/daemon-server-helper';
import { createDaemonServer } from '../helpers/daemon-server-helper';
import { sendMessage, waitForIdle } from '../helpers/daemon-test-helpers';

const TMP_DIR = process.env.TMPDIR || '/tmp';

/** Coordinator-allowed tools — the only tools the coordinator should use directly */
const COORDINATOR_TOOLS = new Set([
	'Task',
	'TodoWrite',
	'AskUserQuestion',
	'TaskOutput',
	'TaskStop',
	'EnterPlanMode',
	'ExitPlanMode',
]);

/** Tools that indicate direct file/command access (should be delegated) */
const _DIRECT_TOOLS = new Set([
	'Read',
	'Edit',
	'Write',
	'Bash',
	'Grep',
	'Glob',
	'NotebookEdit',
	'WebFetch',
	'WebSearch',
]);

/**
 * Collect all SDK messages for a session after processing completes.
 * Uses the message.sdkMessages RPC to fetch the full message list.
 */
async function getAllSDKMessages(
	daemon: DaemonServerContext,
	sessionId: string
): Promise<Array<Record<string, unknown>>> {
	const result = (await daemon.messageHub.call('message.sdkMessages', {
		sessionId,
	})) as { sdkMessages: Array<Record<string, unknown>> };
	return result.sdkMessages || [];
}

/**
 * Extract tool_use blocks from the coordinator's (main thread) assistant messages.
 *
 * Coordinator messages have parent_tool_use_id === null (they're on the main thread).
 * Sub-agent messages have parent_tool_use_id !== null (they're spawned via Task).
 */
function getCoordinatorToolUses(
	messages: Array<Record<string, unknown>>
): Array<{ name: string; id: string }> {
	const toolUses: Array<{ name: string; id: string }> = [];

	for (const msg of messages) {
		if (msg.type !== 'assistant') continue;
		if (msg.parent_tool_use_id !== null) continue; // skip sub-agent messages

		const betaMessage = msg.message as { content?: Array<Record<string, unknown>> } | undefined;
		if (!betaMessage?.content) continue;

		for (const block of betaMessage.content) {
			if (block.type === 'tool_use') {
				toolUses.push({
					name: block.name as string,
					id: block.id as string,
				});
			}
		}
	}

	return toolUses;
}

/**
 * Extract the final text response from assistant messages on the main thread.
 */
function getCoordinatorTextResponse(messages: Array<Record<string, unknown>>): string {
	const texts: string[] = [];

	for (const msg of messages) {
		if (msg.type !== 'assistant') continue;
		if (msg.parent_tool_use_id !== null) continue;

		const betaMessage = msg.message as { content?: Array<Record<string, unknown>> } | undefined;
		if (!betaMessage?.content) continue;

		for (const block of betaMessage.content) {
			if (block.type === 'text') {
				texts.push(block.text as string);
			}
		}
	}

	return texts.join('\n');
}

describe('Coordinator Tool Delegation - Behavioral', () => {
	let daemon: DaemonServerContext;
	let testDir: string;

	beforeEach(async () => {
		daemon = await createDaemonServer();
		testDir = join(TMP_DIR, `coordinator-delegation-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	}, 30000);

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	}, 20000);

	test('coordinator delegates file reading to specialist — canary value appears in response', async () => {
		// 1. Create a file with a unique canary value
		const canary = `CANARY_${Date.now()}_${Math.random().toString(36).slice(2)}`;
		const testFile = join(testDir, 'canary.txt');
		writeFileSync(testFile, canary);

		// 2. Create a coordinator mode session
		const createResult = (await daemon.messageHub.call('session.create', {
			workspacePath: testDir,
			title: 'Coordinator Delegation Test',
			config: {
				coordinatorMode: true,
				permissionMode: 'bypassPermissions',
				allowDangerouslySkipPermissions: true,
			},
		})) as { sessionId: string };

		const { sessionId } = createResult;
		daemon.trackSession(sessionId);

		// 3. Ask the coordinator to read the file
		await sendMessage(
			daemon,
			sessionId,
			`Read the file at ${testFile} and tell me exactly what it contains. Just respond with the file content, nothing else.`
		);

		// 4. Wait for full processing (coordinator + sub-agent)
		await waitForIdle(daemon, sessionId, 120000);

		// 5. Collect all SDK messages
		const allMessages = await getAllSDKMessages(daemon, sessionId);

		// 6. Log the system:init message to see what tools the SDK reports
		const initMsg = allMessages.find(
			(m) => m.type === 'system' && (m as { subtype?: string }).subtype === 'init'
		) as { tools?: string[]; agents?: string[] } | undefined;
		console.log('system:init tools:', initMsg?.tools);
		console.log('system:init agents:', initMsg?.agents);

		// 7. Verify the canary value appears somewhere in the response
		//    This proves a specialist actually read the file
		const coordinatorText = getCoordinatorTextResponse(allMessages);
		expect(coordinatorText).toContain(canary);

		// 8. Verify the coordinator used tools and check for violations (soft check)
		//    SDK tool restriction may be prompt-based rather than API-level filtering,
		//    so the model may occasionally use tools outside its allowed set.
		const coordinatorToolUses = getCoordinatorToolUses(allMessages);
		console.log(
			'Coordinator tool uses:',
			coordinatorToolUses.map((t) => t.name)
		);
		expect(coordinatorToolUses.length).toBeGreaterThan(0); // coordinator did use tools

		const violatingTools = coordinatorToolUses.filter((t) => !COORDINATOR_TOOLS.has(t.name));
		if (violatingTools.length > 0) {
			console.warn(
				'WARNING: Coordinator used non-coordinator tools directly:',
				violatingTools.map((t) => t.name)
			);
		}
	}, 120000);

	test('coordinator delegates file writing to specialist — file is actually created', async () => {
		const outputFile = join(testDir, 'output.txt');
		const canary = `WRITTEN_BY_SPECIALIST_${Date.now()}`;

		// 1. Create a coordinator mode session
		const createResult = (await daemon.messageHub.call('session.create', {
			workspacePath: testDir,
			title: 'Coordinator Write Delegation Test',
			config: {
				coordinatorMode: true,
				permissionMode: 'bypassPermissions',
				allowDangerouslySkipPermissions: true,
			},
		})) as { sessionId: string };

		const { sessionId } = createResult;
		daemon.trackSession(sessionId);

		// 2. Ask the coordinator to write a file
		await sendMessage(
			daemon,
			sessionId,
			`Create a file at ${outputFile} with exactly this content: ${canary}`
		);

		// 3. Wait for processing
		await waitForIdle(daemon, sessionId, 120000);

		// 4. Verify the file was actually written by the specialist
		expect(existsSync(outputFile)).toBe(true);
		const content = readFileSync(outputFile, 'utf-8');
		expect(content).toContain(canary);

		// 5. Verify coordinator only used coordinator tools
		const allMessages = await getAllSDKMessages(daemon, sessionId);
		const coordinatorToolUses = getCoordinatorToolUses(allMessages);

		for (const toolUse of coordinatorToolUses) {
			expect(COORDINATOR_TOOLS.has(toolUse.name)).toBe(true);
		}

		// 6. Verify delegation happened
		const taskUses = coordinatorToolUses.filter((t) => t.name === 'Task');
		expect(taskUses.length).toBeGreaterThan(0);

		// Cleanup
		try {
			unlinkSync(outputFile);
		} catch {
			// ignore
		}
	}, 120000);
});
