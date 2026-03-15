/**
 * CopilotAnthropicProvider Online Tests
 *
 * Tests the embedded Anthropic-compatible HTTP server backed by the GitHub Copilot SDK,
 * using the gpt-5-mini model via the `copilot-anthropic-mini` alias.
 *
 * REQUIREMENTS:
 * - GitHub Copilot CLI (`copilot` binary) in PATH
 *   → Install: `gh extension install github/copilot`
 * - Authentication: set COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN,
 *   or run `gh auth login` with a GitHub account that has Copilot access.
 *
 * HOW TO RUN:
 *   bun test packages/daemon/tests/online/providers/copilot-anthropic-provider.test.ts
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
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
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

/** Model alias for gpt-5-mini routed through CopilotAnthropicProvider. */
const MODEL = 'copilot-anthropic-mini';

/** Per-turn idle timeout. The Copilot API can take 60-90 s per turn. */
const IDLE_TIMEOUT = 120_000;
const SETUP_TIMEOUT = 30_000;
const TEST_TIMEOUT = IDLE_TIMEOUT + 30_000;

// ---------------------------------------------------------------------------
// Minimal MCP server (JSON-RPC 2.0 over stdio)
//
// Provides a single `get_answer` tool that always returns "42".
// Written as a plain CommonJS script so it runs under both `node` and `bun`.
// ---------------------------------------------------------------------------

const MCP_SERVER_SCRIPT = /* js */ `
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
      description: 'Returns the answer to the ultimate question about life, the universe, and everything. Always returns 42.',
      inputSchema: { type: 'object', properties: {}, required: [] }
    }]}});
  } else if (method === 'tools/call') {
    write({ jsonrpc: '2.0', id, result: {
      content: [{ type: 'text', text: '42' }], isError: false
    }});
  } else if (id !== undefined) {
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' }});
  }
  // notifications/initialized has no id — silently ignored here, which is correct
  // per MCP spec (it is a fire-and-forget notification, not a request).
});
function write(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
`.trim();

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

describe('CopilotAnthropicProvider (Online)', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		daemon = await createDaemonServer();
	}, SETUP_TIMEOUT);

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	}, SETUP_TIMEOUT);

	/** Returns true when the github-copilot-anthropic provider reports authenticated. */
	async function isCopilotAnthropicAvailable(): Promise<boolean> {
		try {
			const result = (await daemon.messageHub.request('auth.providers', {})) as {
				providers: Array<{ id: string; isAuthenticated: boolean }>;
			};
			const p = result.providers.find((x) => x.id === 'github-copilot-anthropic');
			return p?.isAuthenticated ?? false;
		} catch {
			return false;
		}
	}

	// -------------------------------------------------------------------------
	// 1. Basic conversation
	// -------------------------------------------------------------------------

	test(
		'basic conversation: model responds correctly via gpt-5-mini',
		async () => {
			if (!(await isCopilotAnthropicAvailable())) {
				console.log(
					'Skipping — github-copilot-anthropic not authenticated. ' +
						'Set COPILOT_GITHUB_TOKEN to a PAT with copilot_requests scope.'
				);
				return;
			}

			const workspacePath = join(TMP_DIR, `copilot-anthropic-basic-${Date.now()}`);
			mkdirSync(workspacePath, { recursive: true });

			const { sessionId } = (await daemon.messageHub.request('session.create', {
				workspacePath,
				title: 'Copilot Anthropic Basic Test',
				config: { model: MODEL, permissionMode: 'acceptEdits' },
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
			if (!(await isCopilotAnthropicAvailable())) {
				console.log('Skipping — github-copilot-anthropic not authenticated.');
				return;
			}

			// Create a workspace with a known file the model will read.
			const workspacePath = join(TMP_DIR, `copilot-anthropic-tool-${Date.now()}`);
			mkdirSync(workspacePath, { recursive: true });
			writeFileSync(join(workspacePath, 'answer.txt'), 'The secret number is 42.');

			const { sessionId } = (await daemon.messageHub.request('session.create', {
				workspacePath,
				title: 'Copilot Anthropic Tool-Use Test',
				config: { model: MODEL, permissionMode: 'acceptEdits' },
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
			if (!(await isCopilotAnthropicAvailable())) {
				console.log('Skipping — github-copilot-anthropic not authenticated.');
				return;
			}

			const workspacePath = join(TMP_DIR, `copilot-anthropic-mcp-${Date.now()}`);
			mkdirSync(workspacePath, { recursive: true });

			// Write the minimal MCP server and register it via .mcp.json.
			const mcpServerPath = join(workspacePath, 'test-mcp-server.js');
			writeFileSync(mcpServerPath, MCP_SERVER_SCRIPT);
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
				config: { model: MODEL, permissionMode: 'acceptEdits' },
			})) as { sessionId: string };
			daemon.trackSession(sessionId);

			await sendMessage(
				daemon,
				sessionId,
				'Use the get_answer tool and report the result. Reply with just the number it returns.'
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

			// The response must contain the value the tool returned.
			const text = sdkMessages
				.filter((m) => (m as { type?: string }).type === 'assistant')
				.map((m) => extractAssistantText(m as Record<string, unknown>))
				.join('');
			expect(text).toContain('42');
		},
		TEST_TIMEOUT
	);
});
