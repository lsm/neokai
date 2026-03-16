/**
 * AnthropicCopilotProvider Online Tests
 *
 * Tests the embedded Anthropic-compatible HTTP server backed by the GitHub Copilot SDK.
 *
 * REQUIREMENTS:
 * - Authentication: set COPILOT_GITHUB_TOKEN to a fine-grained PAT with Copilot access,
 *   or set GH_TOKEN, or run `gh auth login` with a GitHub account that has Copilot access.
 *   Classic PATs (ghp_…) are NOT supported by the Copilot CLI.
 * - No manual CLI install needed — @github/copilot is bundled as a runtime
 *   dependency of @github/copilot-sdk and installed by `bun install`.
 * - If credentials are absent or non-functional, these tests FAIL (not skip). This is
 *   intentional — CI must alert the team when Copilot credentials need attention.
 *
 * HOW TO RUN:
 *   bun test packages/daemon/tests/online/providers/anthropic-copilot-provider.test.ts
 *
 * WHAT THESE TESTS PROVE:
 *   1. basic-conversation  — embedded server routes requests to the Copilot model and
 *                            returns a coherent response (proves the SSE bridge works).
 *   2. tool-use            — the tool-use bridge (ToolBridgeRegistry) works end-to-end:
 *                            the Agent SDK sends tool definitions → Copilot model calls a
 *                            tool → bridge emits a tool_use SSE block → SDK executes the
 *                            tool locally → sends tool_result → suspended session resumes.
 *   3. custom-mcp          — tools registered via .mcp.json in the workspace are loaded by
 *                            the Agent SDK and exposed to the model through the same bridge.
 *   4. models-list         — the anthropic-copilot provider exposes its models when authenticated.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import {
	sendMessage,
	waitForIdle,
	getProcessingState,
	waitForSdkMessages,
} from '../../helpers/daemon-actions';

const TMP_DIR = process.env.TMPDIR || '/tmp';

/** Per-turn idle timeout. The Copilot API can take 60-90 s per turn. */
const IDLE_TIMEOUT = 120_000;
const SETUP_TIMEOUT = 60_000; // includes server start + models.list warm-up
const TEST_TIMEOUT = IDLE_TIMEOUT + 30_000;

// ---------------------------------------------------------------------------
// Minimal MCP server (JSON-RPC 2.0 over stdio)
//
// Provides a single `get_answer` tool that returns a caller-supplied unique
// token.  The token is embedded at test-write time so the model cannot guess
// it from training data — it must call the tool to obtain the value.
// Written as a plain CommonJS script so it runs under both `node` and `bun`.
// ---------------------------------------------------------------------------

/**
 * Build the MCP server script with a unique answer token baked in.
 *
 * Using a runtime-generated token (not a culturally-known value like "42")
 * ensures the model cannot answer the test prompt from its training data —
 * it must call the tool to obtain the correct answer.
 */
function makeMcpServerScript(uniqueToken: string): string {
	return /* js */ `
const rl = require('readline').createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = msg;
  if (method === 'initialize') {
    write({ jsonrpc: '2.0', id, result: {
      protocolVersion: params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'test-answer-server', version: '1.0' }
    }});
  } else if (method === 'tools/list') {
    write({ jsonrpc: '2.0', id, result: { tools: [{
      name: 'get_answer',
      description: 'Returns a unique secret token. You cannot know this value without calling the tool.',
      inputSchema: { type: 'object', properties: {}, required: [] }
    }]}});
  } else if (method === 'tools/call') {
    write({ jsonrpc: '2.0', id, result: {
      content: [{ type: 'text', text: '${uniqueToken}' }], isError: false
    }});
  } else if (id !== undefined) {
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' }});
  }
  // notifications/initialized has no id — silently ignored here, which is correct
  // per MCP spec (it is a fire-and-forget notification, not a request).
});
function write(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
`.trim();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractAssistantText(msg: Record<string, unknown>): string {
	const message = msg.message as { content?: unknown };
	if (!message?.content) return '';
	if (typeof message.content === 'string') return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.filter((b: unknown) => (b as { type?: string }).type === 'text')
			.map((b: unknown) => (b as { text?: string }).text ?? '')
			.join('');
	}
	return '';
}

/** Returns true if any assistant message contains a tool_use block with the given name. */
function hasToolUseBlock(sdkMessages: Array<Record<string, unknown>>, toolName?: string): boolean {
	return sdkMessages.some((m) => {
		const msg = m as { type?: string; message?: { content?: unknown[] } };
		if (msg.type !== 'assistant' || !Array.isArray(msg.message?.content)) return false;
		return msg.message.content.some((b: unknown) => {
			const block = b as { type?: string; name?: string };
			if (block.type !== 'tool_use') return false;
			return toolName === undefined || block.name === toolName;
		});
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnthropicCopilotProvider (Online)', () => {
	let daemon: DaemonServerContext;
	/**
	 * The first available anthropic-copilot model ID, fetched dynamically in beforeAll.
	 * Using a dynamic ID avoids hardcoding model names that may not exist in all
	 * Copilot plans or that Copilot may deprecate.
	 */
	let testModelId: string;

	beforeAll(async () => {
		daemon = await createDaemonServer();

		// Hard-fail if credentials are absent or invalid — per CLAUDE.md policy.
		const authResult = (await daemon.messageHub.request('auth.providers', {})) as {
			providers: Array<{ id: string; isAuthenticated: boolean }>;
		};
		const provider = authResult.providers.find((x) => x.id === 'anthropic-copilot');
		if (!provider?.isAuthenticated) {
			throw new Error(
				'anthropic-copilot provider is not authenticated. ' +
					'Set COPILOT_GITHUB_TOKEN to a fine-grained PAT (not a classic ghp_ PAT) with ' +
					'Copilot access, or use the OAuth login flow. ' +
					'See: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token'
			);
		}

		// Call models.list to start the embedded Anthropic server (mirrors production
		// flow where the UI always fetches models before creating a session).
		const modelsResult = (await daemon.messageHub.request('models.list', {})) as {
			models: Array<{ id: string; provider: string }>;
		};
		const copilotModels = modelsResult.models.filter((m) => m.provider === 'anthropic-copilot');
		if (copilotModels.length === 0) {
			throw new Error(
				'No anthropic-copilot models returned by models.list — ' +
					'authentication succeeded but the embedded server failed to start.'
			);
		}
		testModelId = copilotModels[0].id;
	}, SETUP_TIMEOUT);

	afterAll(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	}, SETUP_TIMEOUT);

	// -------------------------------------------------------------------------
	// 1. Basic conversation
	// -------------------------------------------------------------------------

	test(
		'basic conversation: model responds correctly',
		async () => {
			const workspacePath = join(TMP_DIR, `copilot-anthropic-basic-${Date.now()}`);
			mkdirSync(workspacePath, { recursive: true });

			const { sessionId } = (await daemon.messageHub.request('session.create', {
				workspacePath,
				title: 'Copilot Anthropic Basic Test',
				config: { model: testModelId, permissionMode: 'acceptEdits' },
			})) as { sessionId: string };
			daemon.trackSession(sessionId);

			await sendMessage(daemon, sessionId, 'What is 6+7? Reply with just the number.');
			await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

			const state = await getProcessingState(daemon, sessionId);
			expect(state.status).toBe('idle');

			const { sdkMessages } = await waitForSdkMessages(daemon, sessionId, {
				minCount: 1,
				timeout: 5000,
			});
			const assistantMessages = sdkMessages.filter(
				(m) => (m as { type?: string }).type === 'assistant'
			);
			expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

			const text = assistantMessages
				.map((m) => extractAssistantText(m as Record<string, unknown>))
				.join('');
			expect(text).toContain('13');
		},
		TEST_TIMEOUT
	);

	// -------------------------------------------------------------------------
	// 2. Tool use via the bridge
	// -------------------------------------------------------------------------

	test(
		'tool use: bridge routes tool_use/tool_result correctly',
		async () => {
			// Create a workspace with a known file the model will read.
			const workspacePath = join(TMP_DIR, `copilot-anthropic-tool-${Date.now()}`);
			mkdirSync(workspacePath, { recursive: true });
			writeFileSync(join(workspacePath, 'answer.txt'), 'The secret number is 42.');

			const { sessionId } = (await daemon.messageHub.request('session.create', {
				workspacePath,
				title: 'Copilot Anthropic Tool-Use Test',
				config: { model: testModelId, permissionMode: 'acceptEdits' },
			})) as { sessionId: string };
			daemon.trackSession(sessionId);

			await sendMessage(
				daemon,
				sessionId,
				'Read the file answer.txt in the current directory and tell me the exact content.'
			);
			await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

			const state = await getProcessingState(daemon, sessionId);
			expect(state.status).toBe('idle');

			const { sdkMessages } = await waitForSdkMessages(daemon, sessionId, {
				minCount: 1,
				timeout: 5000,
			});

			// At least one tool_use block proves the bridge fired.
			expect(hasToolUseBlock(sdkMessages)).toBe(true);

			// The response text should contain the file content.
			const text = sdkMessages
				.filter((m) => (m as { type?: string }).type === 'assistant')
				.map((m) => extractAssistantText(m as Record<string, unknown>))
				.join('');
			// "secret" proves the actual file content was received (not a coincidental "42")
			expect(text).toContain('secret');
			expect(text).toContain('42');
		},
		TEST_TIMEOUT
	);

	// -------------------------------------------------------------------------
	// 3. Custom MCP tool
	// -------------------------------------------------------------------------

	test(
		'custom MCP: tool from .mcp.json is exposed and called by the model',
		async () => {
			const workspacePath = join(TMP_DIR, `copilot-anthropic-mcp-${Date.now()}`);
			mkdirSync(workspacePath, { recursive: true });

			// Generate a unique token the model cannot know without calling the tool.
			// Using a timestamp + random suffix avoids any culturally-known value (e.g.
			// "42") that the model might answer from training data instead of calling
			// the tool.
			const uniqueToken = `tok-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

			// Write the minimal MCP server and register it via .mcp.json.
			const mcpServerPath = join(workspacePath, 'test-mcp-server.js');
			writeFileSync(mcpServerPath, makeMcpServerScript(uniqueToken));
			writeFileSync(
				join(workspacePath, '.mcp.json'),
				JSON.stringify(
					{
						mcpServers: {
							'test-answer-server': {
								command: 'node',
								args: [mcpServerPath],
							},
						},
					},
					null,
					2
				)
			);

			const { sessionId } = (await daemon.messageHub.request('session.create', {
				workspacePath,
				title: 'Copilot Anthropic MCP Test',
				config: { model: testModelId, permissionMode: 'acceptEdits' },
			})) as { sessionId: string };
			daemon.trackSession(sessionId);

			await sendMessage(
				daemon,
				sessionId,
				'Call the get_answer tool and report the exact token it returns. ' +
					'You MUST use the tool — do not guess or invent a value. ' +
					'Reply with only the token string, nothing else.'
			);
			await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

			const state = await getProcessingState(daemon, sessionId);
			expect(state.status).toBe('idle');

			const { sdkMessages } = await waitForSdkMessages(daemon, sessionId, {
				minCount: 1,
				timeout: 5000,
			});

			// The model must have called get_answer via the MCP bridge.
			expect(hasToolUseBlock(sdkMessages, 'get_answer')).toBe(true);

			// The response must contain the unique token the tool returned.
			const text = sdkMessages
				.filter((m) => (m as { type?: string }).type === 'assistant')
				.map((m) => extractAssistantText(m as Record<string, unknown>))
				.join('');
			expect(text).toContain(uniqueToken);
		},
		TEST_TIMEOUT
	);

	// -------------------------------------------------------------------------
	// 4. Models list includes Copilot models
	// -------------------------------------------------------------------------

	test('models list: anthropic-copilot models are present when authenticated', async () => {
		// testModelId is set in beforeAll from the models.list call — if we reach here,
		// the embedded server is running and at least one copilot model was returned.
		expect(testModelId).toBeTruthy();
	});
});
