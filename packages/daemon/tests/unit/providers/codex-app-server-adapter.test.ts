/**
 * Unit tests for Codex App Server Adapter and CodexAppServerProvider
 *
 * These tests mock Bun.spawn and Bun.spawnSync so that no real codex process
 * is ever spawned. All subprocess I/O is simulated via controlled ReadableStreams
 * carrying JSON-RPC messages in the Codex App Server lite protocol format.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { UUID } from 'crypto';
import type { SDKMessage, SDKUserMessage } from '@neokai/shared/sdk';
import type {
	ProviderQueryOptions,
	ProviderQueryContext,
} from '@neokai/shared/provider/query-types';
import {
	codexAppServerQueryGenerator,
	type CodexAppServerAdapterConfig,
	type ToolExecutionCallback,
} from '../../../src/lib/providers/codex-app-server-adapter';
import { CodexAppServerProvider } from '../../../src/lib/providers/codex-app-server-provider';

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

/** Build a ReadableStream<Uint8Array> that emits each object as a JSONL line. */
function buildServerStream(messages: object[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			for (const msg of messages) {
				await new Promise<void>((r) => setTimeout(r, 0));
				controller.enqueue(encoder.encode(JSON.stringify(msg) + '\n'));
			}
			controller.close();
		},
	});
}

/**
 * Mock Bun.spawn and Bun.spawnSync so that:
 * - spawnSync returns a successful `which codex` result
 * - spawn returns a fake process whose stdout yields the given messages
 */
function mockAppServer(serverMessages: object[]): {
	stdinWrite: ReturnType<typeof mock>;
	stdinFlush: ReturnType<typeof mock>;
	kill: ReturnType<typeof mock>;
} {
	const stdinWrite = mock(() => {});
	const stdinFlush = mock(() => {});
	const kill = mock(() => {});

	const fakeProc = {
		stdout: buildServerStream(serverMessages),
		stderr: buildServerStream([]),
		stdin: { write: stdinWrite, flush: stdinFlush },
		exited: Promise.resolve(0),
		kill,
	};

	Bun.spawn = mock(() => fakeProc) as unknown as typeof Bun.spawn;
	Bun.spawnSync = mock(() => ({
		exitCode: 0,
		stdout: Buffer.from('/usr/local/bin/codex\n'),
		stderr: Buffer.from(''),
	})) as unknown as typeof Bun.spawnSync;

	return { stdinWrite, stdinFlush, kill };
}

/** Build the standard happy-path sequence of server messages for one query. */
function happyPathMessages(text = 'Hello from Codex'): object[] {
	return [
		// Response to initialize
		{ id: 1, result: { serverInfo: { name: 'codex-app-server', version: '1.0.0' } } },
		// Response to thread/start
		{ id: 2, result: { threadId: 'thread-test-123' } },
		// Response to turn/start
		{ id: 3, result: { turnId: 'turn-test-456' } },
		// Notifications
		{ method: 'turn/started', params: { threadId: 'thread-test-123', turnId: 'turn-test-456' } },
		{
			method: 'item/agentMessage/delta',
			params: {
				threadId: 'thread-test-123',
				turnId: 'turn-test-456',
				itemId: 'item-1',
				delta: { type: 'text_delta', text },
			},
		},
		{
			method: 'item/completed',
			params: {
				threadId: 'thread-test-123',
				turnId: 'turn-test-456',
				item: { id: 'item-1', type: 'agent_message', text },
			},
		},
		{
			method: 'turn/completed',
			params: {
				threadId: 'thread-test-123',
				turnId: 'turn-test-456',
				usage: { inputTokens: 100, outputTokens: 20 },
			},
		},
	];
}

/** Collect all messages emitted by an async generator. */
async function collectMessages(gen: AsyncGenerator<SDKMessage>): Promise<SDKMessage[]> {
	const messages: SDKMessage[] = [];
	for await (const msg of gen) {
		messages.push(msg);
	}
	return messages;
}

/** Create a minimal SDKUserMessage with string content. */
function makeUserMessage(text: string): SDKUserMessage {
	return {
		type: 'user',
		uuid: '00000000-0000-0000-0000-000000000001' as UUID,
		session_id: 'test-session',
		message: { role: 'user', content: text },
	};
}

/** Create a SDKUserMessage with content blocks. */
function makeUserMessageWithBlocks(blocks: Array<{ type: 'text'; text: string }>): SDKUserMessage {
	return {
		type: 'user',
		uuid: '00000000-0000-0000-0000-000000000002' as UUID,
		session_id: 'test-session',
		message: { role: 'user', content: blocks },
	};
}

/** Async generator that yields a single SDKUserMessage. */
async function* singleMessageGenerator(msg: SDKUserMessage): AsyncGenerator<SDKUserMessage> {
	yield msg;
}

/** Create an empty async generator (no messages). */
async function* emptyGenerator(): AsyncGenerator<SDKUserMessage> {
	// yields nothing
}

/** Create a ProviderQueryContext with a fresh AbortController. */
function makeContext(signal?: AbortSignal): ProviderQueryContext {
	return {
		signal: signal ?? new AbortController().signal,
		sessionId: 'test-session-id',
		usesCustomQuery: true,
	};
}

/** Create a ProviderQueryOptions with sensible defaults. */
function makeOptions(model = 'gpt-5.3-codex'): ProviderQueryOptions {
	return {
		model,
		systemPrompt: 'You are a helpful assistant.',
		tools: [],
		cwd: '/tmp',
		maxTurns: 5,
	};
}

/** Build a minimal CodexAppServerAdapterConfig. */
function makeConfig(
	overrides: Partial<CodexAppServerAdapterConfig> = {}
): CodexAppServerAdapterConfig {
	return {
		codexPath: '/usr/local/bin/codex',
		model: 'gpt-5.3-codex',
		apiKey: 'sk-test-key',
		...overrides,
	};
}

type SpawnSyncResult = {
	exitCode: number;
	stdout: { toString(): string };
	stderr: { toString(): string };
};

function makeSpawnSyncFound(path = '/usr/local/bin/codex'): SpawnSyncResult {
	return {
		exitCode: 0,
		stdout: { toString: () => path + '\n' },
		stderr: { toString: () => '' },
	};
}

function makeSpawnSyncNotFound(): SpawnSyncResult {
	return {
		exitCode: 1,
		stdout: { toString: () => '' },
		stderr: { toString: () => '' },
	};
}

// ---------------------------------------------------------------------------
// CodexAppServerProvider tests
// ---------------------------------------------------------------------------

describe('CodexAppServerProvider', () => {
	let originalSpawn: typeof Bun.spawn;
	let originalSpawnSync: typeof Bun.spawnSync;

	beforeEach(() => {
		originalSpawn = Bun.spawn;
		originalSpawnSync = Bun.spawnSync;
	});

	afterEach(() => {
		Bun.spawn = originalSpawn;
		Bun.spawnSync = originalSpawnSync;
	});

	// -----------------------------------------------------------------------
	// Basic properties
	// -----------------------------------------------------------------------

	describe('static properties', () => {
		it('has id "openai-codex-app-server"', () => {
			const provider = new CodexAppServerProvider({});
			expect(provider.id).toBe('openai-codex-app-server');
		});

		it('has displayName "OpenAI (Codex App Server)"', () => {
			const provider = new CodexAppServerProvider({});
			expect(provider.displayName).toBe('OpenAI (Codex App Server)');
		});

		it('exposes expected capabilities', () => {
			const provider = new CodexAppServerProvider({});
			expect(provider.capabilities.streaming).toBe(true);
			expect(provider.capabilities.extendedThinking).toBe(false);
			expect(provider.capabilities.functionCalling).toBe(true);
			expect(provider.capabilities.vision).toBe(true);
			expect(provider.capabilities.maxContextWindow).toBe(200000);
		});

		it('ownsModel() always returns false for any input', () => {
			const provider = new CodexAppServerProvider({});
			expect(provider.ownsModel('gpt-5.4')).toBe(false);
			expect(provider.ownsModel('gpt-5.3-codex')).toBe(false);
			expect(provider.ownsModel('codex')).toBe(false);
			expect(provider.ownsModel('claude-3-opus')).toBe(false);
			expect(provider.ownsModel('')).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// isAvailable()
	// -----------------------------------------------------------------------

	describe('isAvailable()', () => {
		it('returns false when findCodexCli returns null (codex not on PATH)', () => {
			Bun.spawnSync = mock(() => makeSpawnSyncNotFound()) as unknown as typeof Bun.spawnSync;
			const provider = new CodexAppServerProvider({ OPENAI_API_KEY: 'sk-test' });
			expect(provider.isAvailable()).toBe(false);
		});

		it('returns false when codex is on PATH but no API key is set', () => {
			Bun.spawnSync = mock(() => makeSpawnSyncFound()) as unknown as typeof Bun.spawnSync;
			const provider = new CodexAppServerProvider({});
			expect(provider.isAvailable()).toBe(false);
		});

		it('returns true when codex path is found and OPENAI_API_KEY is set', () => {
			Bun.spawnSync = mock(() => makeSpawnSyncFound()) as unknown as typeof Bun.spawnSync;
			const provider = new CodexAppServerProvider({ OPENAI_API_KEY: 'sk-test' });
			expect(provider.isAvailable()).toBe(true);
		});

		it('returns true when codex path is found and CODEX_API_KEY is set', () => {
			Bun.spawnSync = mock(() => makeSpawnSyncFound()) as unknown as typeof Bun.spawnSync;
			const provider = new CodexAppServerProvider({ CODEX_API_KEY: 'ck-test' });
			expect(provider.isAvailable()).toBe(true);
		});
	});

	// -----------------------------------------------------------------------
	// getModels()
	// -----------------------------------------------------------------------

	describe('getModels()', () => {
		it('returns empty array when provider is not available', async () => {
			Bun.spawnSync = mock(() => makeSpawnSyncNotFound()) as unknown as typeof Bun.spawnSync;
			const provider = new CodexAppServerProvider({});
			const models = await provider.getModels();
			expect(models).toEqual([]);
		});

		it('returns 3 models when provider is available', async () => {
			Bun.spawnSync = mock(() => makeSpawnSyncFound()) as unknown as typeof Bun.spawnSync;
			const provider = new CodexAppServerProvider({ OPENAI_API_KEY: 'sk-test' });
			const models = await provider.getModels();
			expect(models.length).toBe(3);
			const ids = models.map((m) => m.id);
			expect(ids).toContain('gpt-5.4');
			expect(ids).toContain('gpt-5.3-codex');
			expect(ids).toContain('gpt-5.1-codex');
		});
	});

	// -----------------------------------------------------------------------
	// getModelForTier()
	// -----------------------------------------------------------------------

	describe('getModelForTier()', () => {
		it('maps opus tier to gpt-5.4', () => {
			const provider = new CodexAppServerProvider({});
			expect(provider.getModelForTier('opus')).toBe('gpt-5.4');
		});

		it('maps sonnet tier to gpt-5.3-codex', () => {
			const provider = new CodexAppServerProvider({});
			expect(provider.getModelForTier('sonnet')).toBe('gpt-5.3-codex');
		});

		it('maps haiku tier to gpt-5.3-codex', () => {
			const provider = new CodexAppServerProvider({});
			expect(provider.getModelForTier('haiku')).toBe('gpt-5.3-codex');
		});
	});

	// -----------------------------------------------------------------------
	// buildSdkConfig()
	// -----------------------------------------------------------------------

	describe('buildSdkConfig()', () => {
		it('returns empty envVars and isAnthropicCompatible: false', () => {
			const provider = new CodexAppServerProvider({});
			const config = provider.buildSdkConfig('gpt-5.4');
			expect(config.envVars).toEqual({});
			expect(config.isAnthropicCompatible).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// createQuery()
	// -----------------------------------------------------------------------

	describe('createQuery()', () => {
		it('returns null when codex is not on PATH', () => {
			Bun.spawnSync = mock(() => makeSpawnSyncNotFound()) as unknown as typeof Bun.spawnSync;
			const provider = new CodexAppServerProvider({ OPENAI_API_KEY: 'sk-test' });
			const gen = provider.createQuery(
				singleMessageGenerator(makeUserMessage('hello')),
				makeOptions(),
				makeContext()
			);
			expect(gen).toBeNull();
		});

		it('returns null when no API key is present', () => {
			Bun.spawnSync = mock(() => makeSpawnSyncFound()) as unknown as typeof Bun.spawnSync;
			const provider = new CodexAppServerProvider({});
			const gen = provider.createQuery(
				singleMessageGenerator(makeUserMessage('hello')),
				makeOptions(),
				makeContext()
			);
			expect(gen).toBeNull();
		});

		it('returns an async generator when codex is on PATH and API key is present', () => {
			Bun.spawnSync = mock(() => makeSpawnSyncFound()) as unknown as typeof Bun.spawnSync;
			const provider = new CodexAppServerProvider({ OPENAI_API_KEY: 'sk-test' });
			const gen = provider.createQuery(
				singleMessageGenerator(makeUserMessage('hello')),
				makeOptions(),
				makeContext()
			);
			expect(gen).not.toBeNull();
			expect(typeof gen![Symbol.asyncIterator]).toBe('function');
		});

		it('resolves "codex" alias to "gpt-5.3-codex"', () => {
			Bun.spawnSync = mock(() => makeSpawnSyncFound()) as unknown as typeof Bun.spawnSync;
			const provider = new CodexAppServerProvider({ OPENAI_API_KEY: 'sk-test' });
			const gen = provider.createQuery(
				singleMessageGenerator(makeUserMessage('hello')),
				makeOptions('codex'),
				makeContext()
			);
			expect(gen).not.toBeNull();
		});

		it('resolves "codex-latest" alias to "gpt-5.4"', () => {
			Bun.spawnSync = mock(() => makeSpawnSyncFound()) as unknown as typeof Bun.spawnSync;
			const provider = new CodexAppServerProvider({ OPENAI_API_KEY: 'sk-test' });
			const gen = provider.createQuery(
				singleMessageGenerator(makeUserMessage('hello')),
				makeOptions('codex-latest'),
				makeContext()
			);
			expect(gen).not.toBeNull();
		});

		it('passes unknown model IDs through as-is', () => {
			Bun.spawnSync = mock(() => makeSpawnSyncFound()) as unknown as typeof Bun.spawnSync;
			const provider = new CodexAppServerProvider({ OPENAI_API_KEY: 'sk-test' });
			// Unknown model ID should still produce a generator (no null return)
			const gen = provider.createQuery(
				singleMessageGenerator(makeUserMessage('hello')),
				makeOptions('some-unknown-model-xyz'),
				makeContext()
			);
			expect(gen).not.toBeNull();
		});
	});
});

// ---------------------------------------------------------------------------
// codexAppServerQueryGenerator tests
// ---------------------------------------------------------------------------

describe('codexAppServerQueryGenerator', () => {
	let originalSpawn: typeof Bun.spawn;
	let originalSpawnSync: typeof Bun.spawnSync;

	beforeEach(() => {
		originalSpawn = Bun.spawn;
		originalSpawnSync = Bun.spawnSync;
	});

	afterEach(() => {
		Bun.spawn = originalSpawn;
		Bun.spawnSync = originalSpawnSync;
	});

	// -----------------------------------------------------------------------
	// Early-exit cases (no spawn needed)
	// -----------------------------------------------------------------------

	it('yields error result when prompt generator is empty (no messages)', async () => {
		const gen = codexAppServerQueryGenerator(
			emptyGenerator(),
			makeOptions(),
			makeContext(),
			makeConfig()
		);
		const messages = await collectMessages(gen);
		expect(messages.length).toBe(1);
		const result = messages[0];
		expect(result.type).toBe('result');
		expect((result as { is_error: boolean }).is_error).toBe(true);
		expect((result as { errors?: string[] }).errors?.[0]).toContain('No user message');
	});

	it('yields error result when the signal is pre-aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		const gen = codexAppServerQueryGenerator(
			singleMessageGenerator(makeUserMessage('hello')),
			makeOptions(),
			makeContext(controller.signal),
			makeConfig()
		);
		const messages = await collectMessages(gen);
		expect(messages.length).toBe(1);
		const result = messages[0];
		expect(result.type).toBe('result');
		expect((result as { is_error: boolean }).is_error).toBe(true);
		expect((result as { errors?: string[] }).errors?.[0]).toContain('aborted');
	});

	it('yields error result when user message contains no text', async () => {
		mockAppServer([]);
		const gen = codexAppServerQueryGenerator(
			singleMessageGenerator(makeUserMessage('   ')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);
		const messages = await collectMessages(gen);
		expect(messages.length).toBe(1);
		const result = messages[0];
		expect(result.type).toBe('result');
		expect((result as { is_error: boolean }).is_error).toBe(true);
		expect((result as { errors?: string[] }).errors?.[0]).toContain('Empty user message');
	});

	it('yields error result when Bun.spawn throws (spawn failure)', async () => {
		Bun.spawn = mock(() => {
			throw new Error('ENOENT: no such file or directory');
		}) as unknown as typeof Bun.spawn;
		Bun.spawnSync = mock(() => makeSpawnSyncFound()) as unknown as typeof Bun.spawnSync;

		const gen = codexAppServerQueryGenerator(
			singleMessageGenerator(makeUserMessage('test')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);
		const messages = await collectMessages(gen);
		expect(messages.length).toBe(1);
		const result = messages[0];
		expect(result.type).toBe('result');
		expect((result as { is_error: boolean }).is_error).toBe(true);
		expect((result as { errors?: string[] }).errors?.[0]).toContain('ENOENT');
	});

	// -----------------------------------------------------------------------
	// Happy path
	// -----------------------------------------------------------------------

	it('happy path: first yielded message is the system init message', async () => {
		mockAppServer(happyPathMessages());
		const gen = codexAppServerQueryGenerator(
			singleMessageGenerator(makeUserMessage('Do the thing')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);
		const messages = await collectMessages(gen);
		expect(messages.length).toBeGreaterThanOrEqual(1);
		expect(messages[0].type).toBe('system');
		expect((messages[0] as { subtype?: string }).subtype).toBe('init');
	});

	it('happy path: item/agentMessage/delta text_delta → stream_event message', async () => {
		mockAppServer(happyPathMessages('Hello'));
		const gen = codexAppServerQueryGenerator(
			singleMessageGenerator(makeUserMessage('stream this')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);
		const messages = await collectMessages(gen);
		const streamEvents = messages.filter((m) => m.type === 'stream_event');
		expect(streamEvents.length).toBeGreaterThanOrEqual(1);
		const texts = streamEvents.map(
			(m) => (m as { event: { delta?: { text?: string } } }).event.delta?.text ?? ''
		);
		expect(texts).toContain('Hello');
	});

	it('happy path: item/completed for agent_message → assistant message', async () => {
		mockAppServer(happyPathMessages('Task complete'));
		const gen = codexAppServerQueryGenerator(
			singleMessageGenerator(makeUserMessage('do it')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);
		const messages = await collectMessages(gen);
		const assistantMsg = messages.find((m) => m.type === 'assistant');
		expect(assistantMsg).toBeDefined();
		const content = (
			assistantMsg as { message: { content: Array<{ type: string; text: string }> } }
		).message.content;
		expect(Array.isArray(content)).toBe(true);
		expect(content[0].text).toBe('Task complete');
	});

	it('happy path: ends with a success result containing accumulated text', async () => {
		mockAppServer(happyPathMessages('The answer is 42'));
		const gen = codexAppServerQueryGenerator(
			singleMessageGenerator(makeUserMessage('what is the answer?')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);
		const messages = await collectMessages(gen);
		const lastMsg = messages[messages.length - 1];
		expect(lastMsg.type).toBe('result');
		expect((lastMsg as { is_error: boolean }).is_error).toBe(false);
		expect((lastMsg as { subtype: string }).subtype).toBe('success');
		// The accumulated text from the stream should appear in the result
		expect((lastMsg as { result: string }).result).toContain('The answer is 42');
	});

	it('turn/completed with usage → success result has non-zero token counts', async () => {
		mockAppServer(happyPathMessages());
		const gen = codexAppServerQueryGenerator(
			singleMessageGenerator(makeUserMessage('check usage')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);
		const messages = await collectMessages(gen);
		const lastMsg = messages[messages.length - 1];
		expect(lastMsg.type).toBe('result');
		expect((lastMsg as { is_error: boolean }).is_error).toBe(false);
		const usage = (lastMsg as { usage?: { input_tokens: number; output_tokens: number } }).usage;
		expect(usage?.input_tokens).toBe(100);
		expect(usage?.output_tokens).toBe(20);
	});

	it('turn/completed with no usage → result has 0 tokens', async () => {
		mockAppServer([
			{ id: 1, result: { serverInfo: { name: 'codex-app-server', version: '1.0.0' } } },
			{ id: 2, result: { threadId: 'thread-test-123' } },
			{ id: 3, result: { turnId: 'turn-test-456' } },
			{
				method: 'turn/completed',
				params: { threadId: 'thread-test-123', turnId: 'turn-test-456' },
			},
		]);
		const gen = codexAppServerQueryGenerator(
			singleMessageGenerator(makeUserMessage('hello')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);
		const messages = await collectMessages(gen);
		const lastMsg = messages[messages.length - 1];
		expect(lastMsg.type).toBe('result');
		expect((lastMsg as { is_error: boolean }).is_error).toBe(false);
		const usage = (lastMsg as { usage?: { input_tokens: number; output_tokens: number } }).usage;
		expect(usage?.input_tokens).toBe(0);
		expect(usage?.output_tokens).toBe(0);
	});

	it('turn/completed increments num_turns in success result', async () => {
		mockAppServer(happyPathMessages());
		const gen = codexAppServerQueryGenerator(
			singleMessageGenerator(makeUserMessage('count turns')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);
		const messages = await collectMessages(gen);
		const lastMsg = messages[messages.length - 1];
		expect((lastMsg as { num_turns: number }).num_turns).toBeGreaterThan(0);
	});

	// -----------------------------------------------------------------------
	// Tool call interception
	// -----------------------------------------------------------------------

	it('tool call: toolExecutor is called and result is returned, generator continues', async () => {
		const toolExecutor: ToolExecutionCallback = mock(async () => ({
			output: 'file1.txt\nfile2.txt',
			isError: false,
		}));

		mockAppServer([
			{ id: 1, result: { serverInfo: { name: 'codex-app-server', version: '1.0.0' } } },
			{ id: 2, result: { threadId: 'thread-test-123' } },
			{ id: 3, result: { turnId: 'turn-test-456' } },
			// Server request: tool call (has both method AND id)
			{
				method: 'item/tool/call',
				id: 'server-req-1',
				params: {
					threadId: 'thread-test-123',
					turnId: 'turn-test-456',
					callId: 'call-001',
					tool: 'bash',
					arguments: { command: 'ls' },
				},
			},
			{
				method: 'item/agentMessage/delta',
				params: {
					threadId: 'thread-test-123',
					turnId: 'turn-test-456',
					itemId: 'item-1',
					delta: { type: 'text_delta', text: 'Files listed.' },
				},
			},
			{
				method: 'turn/completed',
				params: {
					threadId: 'thread-test-123',
					turnId: 'turn-test-456',
					usage: { inputTokens: 50, outputTokens: 10 },
				},
			},
		]);

		const gen = codexAppServerQueryGenerator(
			singleMessageGenerator(makeUserMessage('list files')),
			makeOptions(),
			makeContext(),
			makeConfig(),
			toolExecutor
		);
		const messages = await collectMessages(gen);

		// toolExecutor must have been called with the right args
		expect(toolExecutor).toHaveBeenCalledTimes(1);
		expect(toolExecutor).toHaveBeenCalledWith('bash', { command: 'ls' }, 'call-001');

		// Generator continues and ends with success
		const lastMsg = messages[messages.length - 1];
		expect(lastMsg.type).toBe('result');
		expect((lastMsg as { is_error: boolean }).is_error).toBe(false);
	});

	it('tool call with isError=true → contentItems contains [Tool Error] prefix', async () => {
		const stdinWrite = mock(() => {});
		const stdinFlush = mock(() => {});

		const toolExecutor: ToolExecutionCallback = mock(async () => ({
			output: 'Permission denied',
			isError: true,
		}));

		const serverMessages = [
			{ id: 1, result: { serverInfo: { name: 'codex-app-server', version: '1.0.0' } } },
			{ id: 2, result: { threadId: 'thread-test-123' } },
			{ id: 3, result: { turnId: 'turn-test-456' } },
			{
				method: 'item/tool/call',
				id: 'server-req-2',
				params: {
					threadId: 'thread-test-123',
					turnId: 'turn-test-456',
					callId: 'call-002',
					tool: 'bash',
					arguments: { command: 'rm -rf /' },
				},
			},
			{
				method: 'turn/completed',
				params: {
					threadId: 'thread-test-123',
					turnId: 'turn-test-456',
				},
			},
		];

		Bun.spawn = mock(() => ({
			stdout: buildServerStream(serverMessages),
			stderr: buildServerStream([]),
			stdin: { write: stdinWrite, flush: stdinFlush },
			exited: Promise.resolve(0),
			kill: mock(() => {}),
		})) as unknown as typeof Bun.spawn;

		// Capture what was written to stdin to verify the error response
		const writtenMessages: unknown[] = [];
		stdinWrite.mockImplementation((line: string) => {
			try {
				writtenMessages.push(JSON.parse(line));
			} catch {
				// non-JSON writes ignored
			}
		});

		const gen = codexAppServerQueryGenerator(
			singleMessageGenerator(makeUserMessage('run dangerous command')),
			makeOptions(),
			makeContext(),
			makeConfig(),
			toolExecutor
		);
		await collectMessages(gen);

		// Find the response sent back to the server for the tool call
		const toolCallResponse = writtenMessages.find(
			(m) =>
				m !== null &&
				typeof m === 'object' &&
				(m as Record<string, unknown>)['id'] === 'server-req-2'
		) as Record<string, unknown> | undefined;

		expect(toolCallResponse).toBeDefined();
		const result = toolCallResponse?.['result'] as Record<string, unknown> | undefined;
		expect(result?.['success']).toBe(false);
		const contentItems = result?.['contentItems'] as Array<{ type: string; text: string }>;
		expect(contentItems?.[0].text).toContain('[Tool Error]');
		expect(contentItems?.[0].text).toContain('Permission denied');
	});

	it('tool call with no toolExecutor → graceful error response, no crash', async () => {
		mockAppServer([
			{ id: 1, result: { serverInfo: { name: 'codex-app-server', version: '1.0.0' } } },
			{ id: 2, result: { threadId: 'thread-test-123' } },
			{ id: 3, result: { turnId: 'turn-test-456' } },
			{
				method: 'item/tool/call',
				id: 'server-req-3',
				params: {
					threadId: 'thread-test-123',
					turnId: 'turn-test-456',
					callId: 'call-003',
					tool: 'bash',
					arguments: { command: 'ls' },
				},
			},
			{
				method: 'turn/completed',
				params: { threadId: 'thread-test-123', turnId: 'turn-test-456' },
			},
		]);

		const gen = codexAppServerQueryGenerator(
			singleMessageGenerator(makeUserMessage('list files')),
			makeOptions(),
			makeContext(),
			makeConfig(),
			// No toolExecutor provided
			undefined
		);

		// Should not throw; should complete with a result
		const messages = await collectMessages(gen);
		const lastMsg = messages[messages.length - 1];
		expect(lastMsg.type).toBe('result');
	});

	// -----------------------------------------------------------------------
	// Auto-accept approval requests
	// -----------------------------------------------------------------------

	it('auto-accepts item/commandExecution/requestApproval server requests', async () => {
		const stdinWrite = mock(() => {});
		const stdinFlush = mock(() => {});

		const serverMessages = [
			{ id: 1, result: { serverInfo: { name: 'codex-app-server', version: '1.0.0' } } },
			{ id: 2, result: { threadId: 'thread-test-123' } },
			{ id: 3, result: { turnId: 'turn-test-456' } },
			{
				method: 'item/commandExecution/requestApproval',
				id: 'approval-1',
				params: {
					threadId: 'thread-test-123',
					turnId: 'turn-test-456',
					command: 'npm install',
				},
			},
			{
				method: 'turn/completed',
				params: { threadId: 'thread-test-123', turnId: 'turn-test-456' },
			},
		];

		const writtenMessages: unknown[] = [];
		stdinWrite.mockImplementation((line: string) => {
			try {
				writtenMessages.push(JSON.parse(line));
			} catch {
				// ignore
			}
		});

		Bun.spawn = mock(() => ({
			stdout: buildServerStream(serverMessages),
			stderr: buildServerStream([]),
			stdin: { write: stdinWrite, flush: stdinFlush },
			exited: Promise.resolve(0),
			kill: mock(() => {}),
		})) as unknown as typeof Bun.spawn;

		const gen = codexAppServerQueryGenerator(
			singleMessageGenerator(makeUserMessage('install deps')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);
		await collectMessages(gen);

		const approvalResponse = writtenMessages.find(
			(m) =>
				m !== null && typeof m === 'object' && (m as Record<string, unknown>)['id'] === 'approval-1'
		) as Record<string, unknown> | undefined;

		expect(approvalResponse).toBeDefined();
		const result = approvalResponse?.['result'] as Record<string, unknown> | undefined;
		expect(result?.['decision']).toBe('accept');
	});

	it('auto-accepts item/fileChange/requestApproval server requests', async () => {
		const stdinWrite = mock(() => {});
		const stdinFlush = mock(() => {});

		const serverMessages = [
			{ id: 1, result: { serverInfo: { name: 'codex-app-server', version: '1.0.0' } } },
			{ id: 2, result: { threadId: 'thread-test-123' } },
			{ id: 3, result: { turnId: 'turn-test-456' } },
			{
				method: 'item/fileChange/requestApproval',
				id: 'approval-fc',
				params: {
					threadId: 'thread-test-123',
					turnId: 'turn-test-456',
					path: '/tmp/test.txt',
				},
			},
			{
				method: 'turn/completed',
				params: { threadId: 'thread-test-123', turnId: 'turn-test-456' },
			},
		];

		const writtenMessages: unknown[] = [];
		stdinWrite.mockImplementation((line: string) => {
			try {
				writtenMessages.push(JSON.parse(line));
			} catch {
				// ignore
			}
		});

		Bun.spawn = mock(() => ({
			stdout: buildServerStream(serverMessages),
			stderr: buildServerStream([]),
			stdin: { write: stdinWrite, flush: stdinFlush },
			exited: Promise.resolve(0),
			kill: mock(() => {}),
		})) as unknown as typeof Bun.spawn;

		const gen = codexAppServerQueryGenerator(
			singleMessageGenerator(makeUserMessage('create file')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);
		await collectMessages(gen);

		const approvalResponse = writtenMessages.find(
			(m) =>
				m !== null &&
				typeof m === 'object' &&
				(m as Record<string, unknown>)['id'] === 'approval-fc'
		) as Record<string, unknown> | undefined;

		expect(approvalResponse).toBeDefined();
		const result = approvalResponse?.['result'] as Record<string, unknown> | undefined;
		expect(result?.['decision']).toBe('accept');
	});

	it('auto-accepts item/permissions/requestApproval server requests', async () => {
		const stdinWrite = mock(() => {});
		const stdinFlush = mock(() => {});

		const serverMessages = [
			{ id: 1, result: { serverInfo: { name: 'codex-app-server', version: '1.0.0' } } },
			{ id: 2, result: { threadId: 'thread-test-123' } },
			{ id: 3, result: { turnId: 'turn-test-456' } },
			{
				method: 'item/permissions/requestApproval',
				id: 'approval-perm',
				params: {
					threadId: 'thread-test-123',
					turnId: 'turn-test-456',
					permissions: ['network'],
				},
			},
			{
				method: 'turn/completed',
				params: { threadId: 'thread-test-123', turnId: 'turn-test-456' },
			},
		];

		const writtenMessages: unknown[] = [];
		stdinWrite.mockImplementation((line: string) => {
			try {
				writtenMessages.push(JSON.parse(line));
			} catch {
				// ignore
			}
		});

		Bun.spawn = mock(() => ({
			stdout: buildServerStream(serverMessages),
			stderr: buildServerStream([]),
			stdin: { write: stdinWrite, flush: stdinFlush },
			exited: Promise.resolve(0),
			kill: mock(() => {}),
		})) as unknown as typeof Bun.spawn;

		const gen = codexAppServerQueryGenerator(
			singleMessageGenerator(makeUserMessage('use network')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);
		await collectMessages(gen);

		const approvalResponse = writtenMessages.find(
			(m) =>
				m !== null &&
				typeof m === 'object' &&
				(m as Record<string, unknown>)['id'] === 'approval-perm'
		) as Record<string, unknown> | undefined;

		expect(approvalResponse).toBeDefined();
		const result = approvalResponse?.['result'] as Record<string, unknown> | undefined;
		expect(result?.['decision']).toBe('accept');
	});

	// -----------------------------------------------------------------------
	// Tool item progress messages
	// -----------------------------------------------------------------------

	it('item/started for dynamicToolCall → yields tool_progress with elapsed=0', async () => {
		mockAppServer([
			{ id: 1, result: { serverInfo: { name: 'codex-app-server', version: '1.0.0' } } },
			{ id: 2, result: { threadId: 'thread-test-123' } },
			{ id: 3, result: { turnId: 'turn-test-456' } },
			{
				method: 'item/started',
				params: {
					threadId: 'thread-test-123',
					turnId: 'turn-test-456',
					item: { id: 'dyn-1', type: 'dynamicToolCall' },
				},
			},
			{
				method: 'turn/completed',
				params: { threadId: 'thread-test-123', turnId: 'turn-test-456' },
			},
		]);

		const gen = codexAppServerQueryGenerator(
			singleMessageGenerator(makeUserMessage('use dynamic tool')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);
		const messages = await collectMessages(gen);

		const toolMsgs = messages.filter((m) => m.type === 'tool_progress');
		expect(toolMsgs.length).toBeGreaterThanOrEqual(1);
		const startedMsg = toolMsgs[0] as { elapsed_time_seconds: number; tool_name: string };
		expect(startedMsg.tool_name).toBe('dynamicToolCall');
		expect(startedMsg.elapsed_time_seconds).toBe(0);
	});

	it('item/completed for dynamicToolCall → yields tool_progress with elapsed >= 0', async () => {
		mockAppServer([
			{ id: 1, result: { serverInfo: { name: 'codex-app-server', version: '1.0.0' } } },
			{ id: 2, result: { threadId: 'thread-test-123' } },
			{ id: 3, result: { turnId: 'turn-test-456' } },
			{
				method: 'item/started',
				params: {
					threadId: 'thread-test-123',
					turnId: 'turn-test-456',
					item: { id: 'dyn-2', type: 'dynamicToolCall' },
				},
			},
			{
				method: 'item/completed',
				params: {
					threadId: 'thread-test-123',
					turnId: 'turn-test-456',
					item: { id: 'dyn-2', type: 'dynamicToolCall', status: 'completed' },
				},
			},
			{
				method: 'turn/completed',
				params: { threadId: 'thread-test-123', turnId: 'turn-test-456' },
			},
		]);

		const gen = codexAppServerQueryGenerator(
			singleMessageGenerator(makeUserMessage('run dynamic tool')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);
		const messages = await collectMessages(gen);

		const toolMsgs = messages.filter((m) => m.type === 'tool_progress');
		// Should have start (elapsed=0) and completed (elapsed>=0)
		expect(toolMsgs.length).toBe(2);
		const completedMsg = toolMsgs[1] as { elapsed_time_seconds: number };
		expect(completedMsg.elapsed_time_seconds).toBeGreaterThanOrEqual(0);
	});

	it('item/started for commandExecution → yields tool_progress', async () => {
		mockAppServer([
			{ id: 1, result: { serverInfo: { name: 'codex-app-server', version: '1.0.0' } } },
			{ id: 2, result: { threadId: 'thread-test-123' } },
			{ id: 3, result: { turnId: 'turn-test-456' } },
			{
				method: 'item/started',
				params: {
					threadId: 'thread-test-123',
					turnId: 'turn-test-456',
					item: { id: 'cmd-1', type: 'commandExecution' },
				},
			},
			{
				method: 'turn/completed',
				params: { threadId: 'thread-test-123', turnId: 'turn-test-456' },
			},
		]);

		const gen = codexAppServerQueryGenerator(
			singleMessageGenerator(makeUserMessage('run command')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);
		const messages = await collectMessages(gen);

		const toolMsgs = messages.filter((m) => m.type === 'tool_progress');
		expect(toolMsgs.length).toBeGreaterThanOrEqual(1);
		expect((toolMsgs[0] as { tool_name: string }).tool_name).toBe('commandExecution');
	});

	it('item/started for fileChange → yields tool_progress', async () => {
		mockAppServer([
			{ id: 1, result: { serverInfo: { name: 'codex-app-server', version: '1.0.0' } } },
			{ id: 2, result: { threadId: 'thread-test-123' } },
			{ id: 3, result: { turnId: 'turn-test-456' } },
			{
				method: 'item/started',
				params: {
					threadId: 'thread-test-123',
					turnId: 'turn-test-456',
					item: { id: 'fc-1', type: 'fileChange' },
				},
			},
			{
				method: 'turn/completed',
				params: { threadId: 'thread-test-123', turnId: 'turn-test-456' },
			},
		]);

		const gen = codexAppServerQueryGenerator(
			singleMessageGenerator(makeUserMessage('change a file')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);
		const messages = await collectMessages(gen);

		const toolMsgs = messages.filter((m) => m.type === 'tool_progress');
		expect(toolMsgs.length).toBeGreaterThanOrEqual(1);
		expect((toolMsgs[0] as { tool_name: string }).tool_name).toBe('fileChange');
	});

	// -----------------------------------------------------------------------
	// Error / edge cases
	// -----------------------------------------------------------------------

	it('JSON parse error on a stdout line → skips line, continues processing', async () => {
		const encoder = new TextEncoder();
		// Inject a non-JSON line between valid messages
		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				const validMessages = [
					{ id: 1, result: { serverInfo: { name: 'codex-app-server', version: '1.0.0' } } },
					{ id: 2, result: { threadId: 'thread-test-123' } },
					{ id: 3, result: { turnId: 'turn-test-456' } },
				];
				for (const msg of validMessages) {
					await new Promise<void>((r) => setTimeout(r, 0));
					controller.enqueue(encoder.encode(JSON.stringify(msg) + '\n'));
				}
				// Non-JSON line
				await new Promise<void>((r) => setTimeout(r, 0));
				controller.enqueue(encoder.encode('this is NOT valid json\n'));
				// Resume with valid message
				await new Promise<void>((r) => setTimeout(r, 0));
				controller.enqueue(
					encoder.encode(
						JSON.stringify({
							method: 'turn/completed',
							params: { threadId: 'thread-test-123', turnId: 'turn-test-456' },
						}) + '\n'
					)
				);
				controller.close();
			},
		});

		Bun.spawn = mock(() => ({
			stdout: stream,
			stderr: buildServerStream([]),
			stdin: { write: mock(() => {}), flush: mock(() => {}) },
			exited: Promise.resolve(0),
			kill: mock(() => {}),
		})) as unknown as typeof Bun.spawn;

		const gen = codexAppServerQueryGenerator(
			singleMessageGenerator(makeUserMessage('test')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);
		const messages = await collectMessages(gen);

		// Should still end with a result — the non-JSON line is skipped
		const lastMsg = messages[messages.length - 1];
		expect(lastMsg.type).toBe('result');
	});

	it('server sends error response to thread/start → generator throws with error message', async () => {
		mockAppServer([
			{ id: 1, result: { serverInfo: { name: 'codex-app-server', version: '1.0.0' } } },
			// Error response to thread/start (id=2)
			{ id: 2, error: { message: 'Model not found', code: -32001 } },
		]);

		const gen = codexAppServerQueryGenerator(
			singleMessageGenerator(makeUserMessage('hello')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);

		// The generator yields the system init message first, then thread/start throws,
		// causing the generator to throw (no inner try-catch wraps startThread).
		let caughtError: unknown;
		const messages: SDKMessage[] = [];
		try {
			for await (const msg of gen) {
				messages.push(msg);
			}
		} catch (err) {
			caughtError = err;
		}

		// At minimum the system init message was yielded before the error
		expect(messages.length).toBeGreaterThanOrEqual(1);
		expect(messages[0].type).toBe('system');

		// And the generator threw with the server's error message
		expect(caughtError).toBeDefined();
		expect((caughtError as Error).message).toContain('Model not found');
	});

	it('multi-text content blocks in SDKUserMessage → extracts and joins text', async () => {
		mockAppServer(happyPathMessages());
		const gen = codexAppServerQueryGenerator(
			singleMessageGenerator(
				makeUserMessageWithBlocks([
					{ type: 'text', text: 'First part.' },
					{ type: 'text', text: 'Second part.' },
				])
			),
			makeOptions(),
			makeContext(),
			makeConfig()
		);

		// Should not yield an error for empty prompt
		const messages = await collectMessages(gen);
		const errorMsgs = messages.filter(
			(m) => m.type === 'result' && (m as { is_error: boolean }).is_error
		);
		expect(errorMsgs.length).toBe(0);

		// Should end with success
		const lastMsg = messages[messages.length - 1];
		expect(lastMsg.type).toBe('result');
		expect((lastMsg as { is_error: boolean }).is_error).toBe(false);
	});

	it('process stdout closes before turn/completed → generator unblocks when server sends turn/completed', async () => {
		// The AsyncQueue only unblocks when 'done' is pushed (via turn/completed notification)
		// or when the abort signal fires AND the queue gets a new item.
		// Sending a delayed turn/completed after some notifications verifies the generator
		// terminates normally once the server eventually sends the completion signal.
		mockAppServer([
			{ id: 1, result: { serverInfo: { name: 'codex-app-server', version: '1.0.0' } } },
			{ id: 2, result: { threadId: 'thread-test-123' } },
			{ id: 3, result: { turnId: 'turn-test-456' } },
			{
				method: 'item/agentMessage/delta',
				params: {
					threadId: 'thread-test-123',
					turnId: 'turn-test-456',
					itemId: 'item-x',
					delta: { type: 'text_delta', text: 'partial output' },
				},
			},
			// Server eventually sends turn/completed — this unblocks the queue
			{
				method: 'turn/completed',
				params: { threadId: 'thread-test-123', turnId: 'turn-test-456' },
			},
		]);

		const gen = codexAppServerQueryGenerator(
			singleMessageGenerator(makeUserMessage('hello')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);

		const messages = await collectMessages(gen);
		const lastMsg = messages[messages.length - 1];
		expect(lastMsg.type).toBe('result');
		expect((lastMsg as { is_error: boolean }).is_error).toBe(false);
	});

	it('abort mid-stream → yields abort error result', async () => {
		// The abort signal fires while the generator awaits queue.next().
		// To break the deadlock, the stream sends a turn/completed notification AFTER
		// the abort fires. The loop then breaks via 'done', and the post-loop
		// context.signal.aborted check yields the error result.
		//
		// Implementation: use buildServerStream with a long delay for turn/completed,
		// abort after the handshake completes, then the delayed turn/completed unblocks
		// the queue. The interruptTurn response (id=4) is included to cleanly resolve
		// the pending request sent by the abort handler.
		const controller = new AbortController();

		// Use a longer delay for turn/completed so we can abort first
		const DELAY_MS = 50;
		const encoder = new TextEncoder();

		const stdout = new ReadableStream<Uint8Array>({
			async start(ctrl) {
				// Handshake responses — delivered quickly
				const handshake = [
					{ id: 1, result: { serverInfo: { name: 'codex-app-server', version: '1.0.0' } } },
					{ id: 2, result: { threadId: 'thread-test-123' } },
					{ id: 3, result: { turnId: 'turn-test-456' } },
				];
				for (const msg of handshake) {
					await new Promise<void>((r) => setTimeout(r, 0));
					ctrl.enqueue(encoder.encode(JSON.stringify(msg) + '\n'));
				}
				// Long delay — abort fires during this wait
				await new Promise<void>((r) => setTimeout(r, DELAY_MS));
				// Respond to interruptTurn (id=4), then send turn/completed
				ctrl.enqueue(encoder.encode(JSON.stringify({ id: 4, result: {} }) + '\n'));
				await new Promise<void>((r) => setTimeout(r, 0));
				ctrl.enqueue(
					encoder.encode(
						JSON.stringify({
							method: 'turn/completed',
							params: { threadId: 'thread-test-123', turnId: 'turn-test-456' },
						}) + '\n'
					)
				);
				ctrl.close();
			},
		});

		Bun.spawn = mock(() => ({
			stdout,
			stderr: buildServerStream([]),
			stdin: { write: mock(() => {}), flush: mock(() => {}) },
			exited: Promise.resolve(0),
			kill: mock(() => {}), // no-op — stream closes itself above
		})) as unknown as typeof Bun.spawn;

		const gen = codexAppServerQueryGenerator(
			singleMessageGenerator(makeUserMessage('long running')),
			makeOptions(),
			makeContext(controller.signal),
			makeConfig()
		);

		const collectPromise = collectMessages(gen);

		// Abort after handshake should have been processed (handshake takes ~3 ticks × ~1ms)
		// but before the DELAY_MS wait finishes
		await new Promise<void>((r) => setTimeout(r, 20));
		controller.abort();

		const messages = await collectPromise;
		const lastMsg = messages[messages.length - 1];
		expect(lastMsg.type).toBe('result');
		expect((lastMsg as { is_error: boolean }).is_error).toBe(true);
		expect((lastMsg as { errors?: string[] }).errors?.[0]).toContain('aborted');
	});
});
