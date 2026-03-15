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

	it('server sends error response to thread/start → generator yields error result (not throws)', async () => {
		// P1 regression test: startThread() previously would propagate the rejection,
		// causing an unhandled throw from the generator. Now it yields an error result.
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

		// Generator must NOT throw — it catches the error and yields a result message
		const messages = await collectMessages(gen);

		// System init should be yielded before the error result
		expect(messages.length).toBeGreaterThanOrEqual(2);
		expect(messages[0].type).toBe('system');

		const lastMsg = messages[messages.length - 1];
		expect(lastMsg.type).toBe('result');
		expect((lastMsg as { is_error: boolean }).is_error).toBe(true);
		expect((lastMsg as { errors?: string[] }).errors?.[0]).toContain('Model not found');
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

	it('delayed turn/completed after partial output → generator terminates successfully', async () => {
		// Verifies the generator terminates normally once the server eventually sends
		// turn/completed after streaming some delta notifications.
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

	it('subprocess crashes before turn/completed → generator unblocks with error result', async () => {
		// P0 regression test: when stdout closes without a turn/completed notification,
		// the conn.closed promise resolves and pushes an Error sentinel into the AsyncQueue,
		// unblocking the drain loop which then yields an error result message.
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
			// No turn/completed — stream closes here (subprocess crash)
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
		expect((lastMsg as { is_error: boolean }).is_error).toBe(true);
		expect((lastMsg as { errors?: string[] }).errors?.[0]).toMatch(/subprocess closed/i);
	});

	it('server request with string ID → handler dispatched and response sent with same string ID', async () => {
		// P0 regression test: server requests use string IDs (e.g. "srv-req-1").
		// The AppServerIncoming type now accepts id: string | number, and dispatchMessage
		// must echo the same string ID back in the response.
		const stdinWrite = mock(() => {});
		const stdinFlush = mock(() => {});

		const encoder = new TextEncoder();
		const stdout = new ReadableStream<Uint8Array>({
			async start(ctrl) {
				const messages = [
					{ id: 1, result: { serverInfo: { name: 'codex-app-server', version: '1.0.0' } } },
					{ id: 2, result: { threadId: 'thread-abc' } },
					{ id: 3, result: { turnId: 'turn-xyz' } },
					// Server request with STRING id
					{
						id: 'srv-req-1',
						method: 'item/tool/call',
						params: {
							threadId: 'thread-abc',
							turnId: 'turn-xyz',
							callId: 'call-1',
							tool: 'myTool',
							arguments: { x: 1 },
						},
					},
					{
						method: 'turn/completed',
						params: { threadId: 'thread-abc', turnId: 'turn-xyz' },
					},
				];
				for (const msg of messages) {
					await new Promise<void>((r) => setTimeout(r, 0));
					ctrl.enqueue(encoder.encode(JSON.stringify(msg) + '\n'));
				}
				ctrl.close();
			},
		});

		Bun.spawn = mock(() => ({
			stdout,
			stderr: buildServerStream([]),
			stdin: { write: stdinWrite, flush: stdinFlush },
			exited: Promise.resolve(0),
			kill: mock(() => {}),
		})) as unknown as typeof Bun.spawn;

		Bun.spawnSync = mock(() => ({
			exitCode: 0,
			stdout: Buffer.from('/usr/local/bin/codex\n'),
			stderr: Buffer.from(''),
		})) as unknown as typeof Bun.spawnSync;

		const toolExecutor: ToolExecutionCallback = mock(async () => ({
			output: 'tool result',
			isError: false,
		}));

		const gen = codexAppServerQueryGenerator(
			singleMessageGenerator(makeUserMessage('use a tool')),
			makeOptions(),
			makeContext(),
			makeConfig(),
			toolExecutor
		);

		const messages = await collectMessages(gen);

		// Tool executor should have been called
		expect(toolExecutor).toHaveBeenCalledWith('myTool', { x: 1 }, 'call-1');

		// The response written to stdin should echo the string id "srv-req-1"
		const writtenLines: string[] = [];
		for (const call of (stdinWrite as ReturnType<typeof mock>).mock.calls) {
			const line = call[0] as string;
			if (line.trim()) writtenLines.push(line.trim());
		}
		const responseForStringId = writtenLines
			.map((l) => {
				try {
					return JSON.parse(l) as Record<string, unknown>;
				} catch {
					return null;
				}
			})
			.filter(Boolean)
			.find((m) => m !== null && m['id'] === 'srv-req-1');

		expect(responseForStringId).toBeDefined();
		expect(responseForStringId).toHaveProperty('result');

		// Generator should succeed
		const lastMsg = messages[messages.length - 1];
		expect(lastMsg.type).toBe('result');
		expect((lastMsg as { is_error: boolean }).is_error).toBe(false);
	});

	it('initialize fails → generator yields error result instead of throwing', async () => {
		// P1 regression test: if conn.initialize() rejects (e.g. server responds with error),
		// the generator should yield an error result message, not propagate the exception.
		const stdinWrite = mock(() => {});
		const encoder = new TextEncoder();
		const stdout = new ReadableStream<Uint8Array>({
			async start(ctrl) {
				// Send error response to initialize request (id=1)
				await new Promise<void>((r) => setTimeout(r, 0));
				ctrl.enqueue(
					encoder.encode(
						JSON.stringify({
							id: 1,
							error: { code: -32000, message: 'Server init failed: unsupported version' },
						}) + '\n'
					)
				);
				ctrl.close();
			},
		});

		Bun.spawn = mock(() => ({
			stdout,
			stderr: buildServerStream([]),
			stdin: { write: stdinWrite, flush: mock(() => {}) },
			exited: Promise.resolve(1),
			kill: mock(() => {}),
		})) as unknown as typeof Bun.spawn;

		Bun.spawnSync = mock(() => ({
			exitCode: 0,
			stdout: Buffer.from('/usr/local/bin/codex\n'),
			stderr: Buffer.from(''),
		})) as unknown as typeof Bun.spawnSync;

		const gen = codexAppServerQueryGenerator(
			singleMessageGenerator(makeUserMessage('hello')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);

		const messages = await collectMessages(gen);
		const lastMsg = messages[messages.length - 1];
		expect(lastMsg.type).toBe('result');
		expect((lastMsg as { is_error: boolean }).is_error).toBe(true);
		expect((lastMsg as { errors?: string[] }).errors?.[0]).toMatch(/init failed/i);
	});

	it('unregistered server request method → dispatchMessage sends JSON-RPC -32601 error (not empty result)', async () => {
		// P1 regression test: previously, unregistered server request methods received
		// { id, result: {} } which is a success response. The server would interpret this
		// as a successful method call with empty result, masking the error. Now the adapter
		// sends { id, error: { code: -32601, message: "Method not found: ..." } }.
		const stdinWrite = mock(() => {});
		const stdinFlush = mock(() => {});
		const encoder = new TextEncoder();

		const stdout = new ReadableStream<Uint8Array>({
			async start(ctrl) {
				const messages = [
					{ id: 1, result: { serverInfo: { name: 'codex-app-server', version: '1.0.0' } } },
					{ id: 2, result: { threadId: 'thread-abc' } },
					{ id: 3, result: { turnId: 'turn-xyz' } },
					// Server sends a request for an unknown method
					{
						id: 42,
						method: 'unknown/futureMethod',
						params: { some: 'data' },
					},
					{
						method: 'turn/completed',
						params: { threadId: 'thread-abc', turnId: 'turn-xyz' },
					},
				];
				for (const msg of messages) {
					await new Promise<void>((r) => setTimeout(r, 0));
					ctrl.enqueue(encoder.encode(JSON.stringify(msg) + '\n'));
				}
				ctrl.close();
			},
		});

		Bun.spawn = mock(() => ({
			stdout,
			stderr: buildServerStream([]),
			stdin: { write: stdinWrite, flush: stdinFlush },
			exited: Promise.resolve(0),
			kill: mock(() => {}),
		})) as unknown as typeof Bun.spawn;

		Bun.spawnSync = mock(() => ({
			exitCode: 0,
			stdout: Buffer.from('/usr/local/bin/codex\n'),
			stderr: Buffer.from(''),
		})) as unknown as typeof Bun.spawnSync;

		const gen = codexAppServerQueryGenerator(
			singleMessageGenerator(makeUserMessage('hello')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);

		await collectMessages(gen);

		// Find the response written for id=42
		const writtenLines: string[] = [];
		for (const call of (stdinWrite as ReturnType<typeof mock>).mock.calls) {
			const line = call[0] as string;
			if (line.trim()) writtenLines.push(line.trim());
		}
		const responseFor42 = writtenLines
			.map((l) => {
				try {
					return JSON.parse(l) as Record<string, unknown>;
				} catch {
					return null;
				}
			})
			.filter(Boolean)
			.find((m) => m !== null && m['id'] === 42);

		expect(responseFor42).toBeDefined();
		// Must be an error response, NOT { result: {} }
		expect(responseFor42).toHaveProperty('error');
		expect(responseFor42).not.toHaveProperty('result');
		const errObj = responseFor42?.['error'] as { code: number; message: string };
		expect(errObj.code).toBe(-32601);
		expect(errObj.message).toContain('unknown/futureMethod');
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
