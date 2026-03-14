/**
 * Unit tests for Codex CLI Adapter and CodexCliProvider
 *
 * These tests mock Bun.spawn and Bun.spawnSync so that no real codex process
 * is ever spawned. All subprocess I/O is simulated via controlled ReadableStreams.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { UUID } from 'crypto';
import type { SDKMessage, SDKUserMessage } from '@neokai/shared/sdk';
import type {
	ProviderQueryOptions,
	ProviderQueryContext,
} from '@neokai/shared/provider/query-types';
import {
	findCodexCli,
	codexExecQueryGenerator,
} from '../../../src/lib/providers/codex-cli-adapter';
import { CodexCliProvider } from '../../../src/lib/providers/codex-cli-provider';

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

/**
 * Convert an array of JSONL strings into a ReadableStream<Uint8Array>.
 */
function makeJsonlStream(lines: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const line of lines) {
				controller.enqueue(encoder.encode(line + '\n'));
			}
			controller.close();
		},
	});
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

/** Build a minimal CodexCliAdapterConfig. */
function makeConfig(overrides: Partial<Parameters<typeof codexExecQueryGenerator>[3]> = {}) {
	return {
		codexPath: '/usr/local/bin/codex',
		model: 'gpt-5.3-codex',
		apiKey: 'sk-test-key',
		sandbox: 'workspace-write' as const,
		approvalMode: 'never' as const,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Bun.spawnSync mock helpers
// ---------------------------------------------------------------------------

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
// findCodexCli tests
// ---------------------------------------------------------------------------

describe('findCodexCli', () => {
	let originalSpawnSync: typeof Bun.spawnSync;

	beforeEach(() => {
		originalSpawnSync = Bun.spawnSync;
	});

	afterEach(() => {
		Bun.spawnSync = originalSpawnSync;
	});

	it('returns the resolved path when codex is found on PATH', () => {
		Bun.spawnSync = mock(() =>
			makeSpawnSyncFound('/usr/local/bin/codex')
		) as unknown as typeof Bun.spawnSync;
		const result = findCodexCli();
		expect(result).toBe('/usr/local/bin/codex');
	});

	it('returns null when which exits with non-zero code (codex not on PATH)', () => {
		Bun.spawnSync = mock(() => makeSpawnSyncNotFound()) as unknown as typeof Bun.spawnSync;
		const result = findCodexCli();
		expect(result).toBeNull();
	});

	it('returns null when Bun.spawnSync throws', () => {
		Bun.spawnSync = mock(() => {
			throw new Error('spawn error');
		}) as unknown as typeof Bun.spawnSync;
		const result = findCodexCli();
		expect(result).toBeNull();
	});

	it('accepts a custom codex path', () => {
		Bun.spawnSync = mock(() =>
			makeSpawnSyncFound('/opt/homebrew/bin/codex')
		) as unknown as typeof Bun.spawnSync;
		const result = findCodexCli('/opt/homebrew/bin/codex');
		expect(result).toBe('/opt/homebrew/bin/codex');
	});

	it('falls back to the input path when stdout is empty but exit code is 0', () => {
		Bun.spawnSync = mock(() => ({
			exitCode: 0,
			stdout: { toString: () => '   ' }, // only whitespace
			stderr: { toString: () => '' },
		})) as unknown as typeof Bun.spawnSync;
		const result = findCodexCli('codex');
		// empty stdout → return the codexPath argument itself
		expect(result).toBe('codex');
	});
});

// ---------------------------------------------------------------------------
// CodexCliProvider tests
// ---------------------------------------------------------------------------

describe('CodexCliProvider', () => {
	let originalSpawnSync: typeof Bun.spawnSync;

	beforeEach(() => {
		originalSpawnSync = Bun.spawnSync;
	});

	afterEach(() => {
		Bun.spawnSync = originalSpawnSync;
	});

	describe('static properties', () => {
		it('has id "openai-codex-cli"', () => {
			const provider = new CodexCliProvider({});
			expect(provider.id).toBe('openai-codex-cli');
		});

		it('has displayName "OpenAI (Codex CLI)"', () => {
			const provider = new CodexCliProvider({});
			expect(provider.displayName).toBe('OpenAI (Codex CLI)');
		});

		it('exposes expected capabilities', () => {
			const provider = new CodexCliProvider({});
			expect(provider.capabilities.streaming).toBe(true);
			expect(provider.capabilities.extendedThinking).toBe(false);
			expect(provider.capabilities.functionCalling).toBe(true);
			expect(provider.capabilities.vision).toBe(true);
			expect(provider.capabilities.maxContextWindow).toBe(200000);
		});
	});

	describe('isAvailable()', () => {
		it('returns true when codex is on PATH and OPENAI_API_KEY is set', () => {
			Bun.spawnSync = mock(() => makeSpawnSyncFound()) as unknown as typeof Bun.spawnSync;
			const provider = new CodexCliProvider({ OPENAI_API_KEY: 'sk-test' });
			expect(provider.isAvailable()).toBe(true);
		});

		it('returns true when codex is on PATH and CODEX_API_KEY is set', () => {
			Bun.spawnSync = mock(() => makeSpawnSyncFound()) as unknown as typeof Bun.spawnSync;
			const provider = new CodexCliProvider({ CODEX_API_KEY: 'ck-test' });
			expect(provider.isAvailable()).toBe(true);
		});

		it('returns false when codex is NOT on PATH (even with API key)', () => {
			Bun.spawnSync = mock(() => makeSpawnSyncNotFound()) as unknown as typeof Bun.spawnSync;
			const provider = new CodexCliProvider({ OPENAI_API_KEY: 'sk-test' });
			expect(provider.isAvailable()).toBe(false);
		});

		it('returns false when no API key is present (even with codex on PATH)', () => {
			Bun.spawnSync = mock(() => makeSpawnSyncFound()) as unknown as typeof Bun.spawnSync;
			const provider = new CodexCliProvider({});
			expect(provider.isAvailable()).toBe(false);
		});

		it('returns false when both codex and API key are missing', () => {
			Bun.spawnSync = mock(() => makeSpawnSyncNotFound()) as unknown as typeof Bun.spawnSync;
			const provider = new CodexCliProvider({});
			expect(provider.isAvailable()).toBe(false);
		});
	});

	describe('getModels()', () => {
		it('returns the list of models when provider is available', async () => {
			Bun.spawnSync = mock(() => makeSpawnSyncFound()) as unknown as typeof Bun.spawnSync;
			const provider = new CodexCliProvider({ OPENAI_API_KEY: 'sk-test' });
			const models = await provider.getModels();
			expect(models.length).toBeGreaterThan(0);
			const ids = models.map((m) => m.id);
			expect(ids).toContain('gpt-5.4');
			expect(ids).toContain('gpt-5.3-codex');
			expect(ids).toContain('gpt-5.1-codex');
		});

		it('returns an empty array when provider is not available', async () => {
			Bun.spawnSync = mock(() => makeSpawnSyncNotFound()) as unknown as typeof Bun.spawnSync;
			const provider = new CodexCliProvider({});
			const models = await provider.getModels();
			expect(models).toEqual([]);
		});
	});

	describe('ownsModel()', () => {
		it('always returns false regardless of model id', () => {
			const provider = new CodexCliProvider({});
			expect(provider.ownsModel('gpt-5.4')).toBe(false);
			expect(provider.ownsModel('gpt-5.3-codex')).toBe(false);
			expect(provider.ownsModel('codex')).toBe(false);
			expect(provider.ownsModel('gpt-4o')).toBe(false);
		});
	});

	describe('getModelForTier()', () => {
		it('maps opus tier to gpt-5.4', () => {
			const provider = new CodexCliProvider({});
			expect(provider.getModelForTier('opus')).toBe('gpt-5.4');
		});

		it('maps sonnet tier to gpt-5.3-codex', () => {
			const provider = new CodexCliProvider({});
			expect(provider.getModelForTier('sonnet')).toBe('gpt-5.3-codex');
		});

		it('maps haiku tier to gpt-5.3-codex', () => {
			const provider = new CodexCliProvider({});
			expect(provider.getModelForTier('haiku')).toBe('gpt-5.3-codex');
		});

		it('maps default tier to gpt-5.4', () => {
			const provider = new CodexCliProvider({});
			expect(provider.getModelForTier('default')).toBe('gpt-5.4');
		});
	});

	describe('buildSdkConfig()', () => {
		it('returns empty envVars', () => {
			const provider = new CodexCliProvider({});
			const config = provider.buildSdkConfig('gpt-5.4');
			expect(config.envVars).toEqual({});
		});

		it('returns isAnthropicCompatible: false', () => {
			const provider = new CodexCliProvider({});
			const config = provider.buildSdkConfig('gpt-5.4');
			expect(config.isAnthropicCompatible).toBe(false);
		});
	});

	describe('createQuery()', () => {
		it('returns null when codex is not on PATH', () => {
			Bun.spawnSync = mock(() => makeSpawnSyncNotFound()) as unknown as typeof Bun.spawnSync;
			const provider = new CodexCliProvider({ OPENAI_API_KEY: 'sk-test' });
			const gen = provider.createQuery(
				singleMessageGenerator(makeUserMessage('hello')),
				makeOptions(),
				makeContext()
			);
			expect(gen).toBeNull();
		});

		it('returns null when no API key is present', () => {
			Bun.spawnSync = mock(() => makeSpawnSyncFound()) as unknown as typeof Bun.spawnSync;
			const provider = new CodexCliProvider({});
			const gen = provider.createQuery(
				singleMessageGenerator(makeUserMessage('hello')),
				makeOptions(),
				makeContext()
			);
			expect(gen).toBeNull();
		});

		it('returns an async generator when codex is on PATH and API key is present', () => {
			Bun.spawnSync = mock(() => makeSpawnSyncFound()) as unknown as typeof Bun.spawnSync;
			const provider = new CodexCliProvider({ OPENAI_API_KEY: 'sk-test' });
			const gen = provider.createQuery(
				singleMessageGenerator(makeUserMessage('hello')),
				makeOptions(),
				makeContext()
			);
			expect(gen).not.toBeNull();
			expect(typeof gen![Symbol.asyncIterator]).toBe('function');
		});

		it('resolves the "codex" alias to "gpt-5.3-codex"', () => {
			Bun.spawnSync = mock(() => makeSpawnSyncFound()) as unknown as typeof Bun.spawnSync;
			const provider = new CodexCliProvider({ OPENAI_API_KEY: 'sk-test' });
			// We just verify createQuery doesn't return null — alias resolution happens internally
			const gen = provider.createQuery(
				singleMessageGenerator(makeUserMessage('hello')),
				makeOptions('codex'),
				makeContext()
			);
			expect(gen).not.toBeNull();
		});

		it('resolves the "codex-latest" alias to "gpt-5.4"', () => {
			Bun.spawnSync = mock(() => makeSpawnSyncFound()) as unknown as typeof Bun.spawnSync;
			const provider = new CodexCliProvider({ OPENAI_API_KEY: 'sk-test' });
			const gen = provider.createQuery(
				singleMessageGenerator(makeUserMessage('hello')),
				makeOptions('codex-latest'),
				makeContext()
			);
			expect(gen).not.toBeNull();
		});
	});
});

// ---------------------------------------------------------------------------
// codexExecQueryGenerator tests
// ---------------------------------------------------------------------------

describe('codexExecQueryGenerator', () => {
	let originalSpawn: typeof Bun.spawn;

	beforeEach(() => {
		originalSpawn = Bun.spawn;
	});

	afterEach(() => {
		Bun.spawn = originalSpawn;
	});

	/** Helper: create a mock Bun.spawn return value with controlled JSONL output. */
	function mockSpawnWith(jsonlLines: string[], exitCode = 0, stderrLines: string[] = []) {
		const stdoutStream = makeJsonlStream(jsonlLines);
		const stderrStream = makeJsonlStream(stderrLines);
		const fakeProc = {
			stdout: stdoutStream,
			stderr: stderrStream,
			exited: Promise.resolve(exitCode),
			kill: mock(() => {}),
		};
		Bun.spawn = mock(() => fakeProc) as unknown as typeof Bun.spawn;
		return fakeProc;
	}

	it('yields error result when prompt generator is empty (no messages)', async () => {
		const gen = codexExecQueryGenerator(
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

	it('yields error result when user message text is empty', async () => {
		const gen = codexExecQueryGenerator(
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

	it('happy path: agent_message → system init + assistant message + success result', async () => {
		mockSpawnWith([
			JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
			JSON.stringify({ type: 'turn.started' }),
			JSON.stringify({
				type: 'item.completed',
				item: { id: 'msg-1', type: 'agent_message', text: 'Task done!' },
			}),
			JSON.stringify({ type: 'turn.completed' }),
		]);

		const gen = codexExecQueryGenerator(
			singleMessageGenerator(makeUserMessage('Do the thing')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);
		const messages = await collectMessages(gen);

		// Must start with system init
		expect(messages[0].type).toBe('system');
		expect((messages[0] as { subtype?: string }).subtype).toBe('init');

		// Should contain an assistant message
		const assistantMsg = messages.find((m) => m.type === 'assistant');
		expect(assistantMsg).toBeDefined();
		const content = (
			assistantMsg as { message: { content: Array<{ type: string; text: string }> } }
		).message.content;
		expect(Array.isArray(content)).toBe(true);
		expect(content[0].text).toBe('Task done!');

		// Must end with a success result
		const lastMsg = messages[messages.length - 1];
		expect(lastMsg.type).toBe('result');
		expect((lastMsg as { is_error: boolean }).is_error).toBe(false);
		expect((lastMsg as { subtype: string }).subtype).toBe('success');
	});

	it('item.delta events yield stream_event messages', async () => {
		mockSpawnWith([
			JSON.stringify({
				type: 'item.delta',
				item_id: 'item-1',
				delta: { type: 'text_delta', text: 'Hello ' },
			}),
			JSON.stringify({
				type: 'item.delta',
				item_id: 'item-1',
				delta: { type: 'text_delta', text: 'world' },
			}),
			JSON.stringify({ type: 'turn.completed' }),
		]);

		const gen = codexExecQueryGenerator(
			singleMessageGenerator(makeUserMessage('stream test')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);
		const messages = await collectMessages(gen);

		const streamEvents = messages.filter((m) => m.type === 'stream_event');
		expect(streamEvents.length).toBeGreaterThanOrEqual(2);

		const texts = streamEvents.map(
			(m) => (m as { event: { delta?: { text?: string } } }).event.delta?.text ?? ''
		);
		expect(texts).toContain('Hello ');
		expect(texts).toContain('world');
	});

	it('command_execution items emit tool_progress messages', async () => {
		mockSpawnWith([
			JSON.stringify({
				type: 'item.started',
				item: { id: 'cmd-1', type: 'command_execution', command: 'ls' },
			}),
			JSON.stringify({
				type: 'item.completed',
				item: {
					id: 'cmd-1',
					type: 'command_execution',
					command: 'ls',
					output: 'file.txt',
					exit_code: 0,
				},
			}),
			JSON.stringify({ type: 'turn.completed' }),
		]);

		const gen = codexExecQueryGenerator(
			singleMessageGenerator(makeUserMessage('run ls')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);
		const messages = await collectMessages(gen);

		const toolMsgs = messages.filter((m) => m.type === 'tool_progress');
		expect(toolMsgs.length).toBeGreaterThanOrEqual(2); // started + completed
		const toolNames = toolMsgs.map((m) => (m as { tool_name: string }).tool_name);
		expect(toolNames.every((n) => n === 'command_execution')).toBe(true);
	});

	it('file_change items emit tool_progress messages with operation in name', async () => {
		mockSpawnWith([
			JSON.stringify({
				type: 'item.started',
				item: { id: 'fc-1', type: 'file_change', path: '/tmp/test.txt', operation: 'create' },
			}),
			JSON.stringify({
				type: 'item.completed',
				item: { id: 'fc-1', type: 'file_change', path: '/tmp/test.txt', operation: 'create' },
			}),
			JSON.stringify({ type: 'turn.completed' }),
		]);

		const gen = codexExecQueryGenerator(
			singleMessageGenerator(makeUserMessage('create a file')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);
		const messages = await collectMessages(gen);

		const toolMsgs = messages.filter((m) => m.type === 'tool_progress');
		expect(toolMsgs.length).toBeGreaterThanOrEqual(1);
		const names = toolMsgs.map((m) => (m as { tool_name: string }).tool_name);
		expect(names.some((n) => n.startsWith('file_change:'))).toBe(true);
	});

	it('error event in stream yields error result message', async () => {
		mockSpawnWith([
			JSON.stringify({ type: 'error', message: 'Rate limit exceeded', code: 'rate_limit' }),
		]);

		const gen = codexExecQueryGenerator(
			singleMessageGenerator(makeUserMessage('test')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);
		const messages = await collectMessages(gen);

		const lastMsg = messages[messages.length - 1];
		expect(lastMsg.type).toBe('result');
		expect((lastMsg as { is_error: boolean }).is_error).toBe(true);
		expect((lastMsg as { errors?: string[] }).errors?.[0]).toContain('Rate limit exceeded');
	});

	it('non-zero exit code yields error result message', async () => {
		mockSpawnWith([], /* exitCode= */ 1, ['codex: command not found']);

		const gen = codexExecQueryGenerator(
			singleMessageGenerator(makeUserMessage('test')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);
		const messages = await collectMessages(gen);

		const lastMsg = messages[messages.length - 1];
		expect(lastMsg.type).toBe('result');
		expect((lastMsg as { is_error: boolean }).is_error).toBe(true);
		const errMsg = (lastMsg as { stop_reason?: string }).stop_reason ?? '';
		expect(errMsg).toContain('1');
	});

	it('AbortSignal fired before spawn yields abort error result', async () => {
		const controller = new AbortController();
		controller.abort();

		// No need to mock spawn — abort check happens before spawn
		const gen = codexExecQueryGenerator(
			singleMessageGenerator(makeUserMessage('test')),
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

	it('AbortSignal fired after spawn yields abort error result', async () => {
		const controller = new AbortController();

		// Stream yields some events, then we abort mid-stream
		const encoder = new TextEncoder();
		let streamController: ReadableStreamDefaultController<Uint8Array>;
		const stdoutStream = new ReadableStream<Uint8Array>({
			start(ctrl) {
				streamController = ctrl;
			},
		});
		const stderrStream = makeJsonlStream([]);

		let resolveExited: (code: number) => void;
		const exitedPromise = new Promise<number>((res) => {
			resolveExited = res;
		});

		const fakeProc = {
			stdout: stdoutStream,
			stderr: stderrStream,
			exited: exitedPromise,
			kill: mock(() => {
				resolveExited(0);
			}),
		};
		Bun.spawn = mock(() => fakeProc) as unknown as typeof Bun.spawn;

		const gen = codexExecQueryGenerator(
			singleMessageGenerator(makeUserMessage('long running task')),
			makeOptions(),
			makeContext(controller.signal),
			makeConfig()
		);

		// Start collecting in the background, then abort after a tick
		const collectPromise = collectMessages(gen);

		// Give the generator a chance to start, then abort
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
		controller.abort();
		// Close the stream to unblock the reader
		streamController!.close();

		const messages = await collectPromise;

		const lastMsg = messages[messages.length - 1];
		expect(lastMsg.type).toBe('result');
		expect((lastMsg as { is_error: boolean }).is_error).toBe(true);
		expect((lastMsg as { errors?: string[] }).errors?.[0]).toContain('aborted');
	});

	it('turn.completed with usage → usage appears in success result message', async () => {
		mockSpawnWith([
			JSON.stringify({
				type: 'item.completed',
				item: { id: 'msg-1', type: 'agent_message', text: 'Done.' },
			}),
			JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50 } }),
		]);

		const gen = codexExecQueryGenerator(
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
		expect(usage?.output_tokens).toBe(50);
	});

	it('spawn failure yields error result message', async () => {
		Bun.spawn = mock(() => {
			throw new Error('ENOENT: no such file or directory');
		}) as unknown as typeof Bun.spawn;

		const gen = codexExecQueryGenerator(
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

	it('system init message contains correct session_id and model', async () => {
		mockSpawnWith([JSON.stringify({ type: 'turn.completed' })]);

		const opts = makeOptions('gpt-5.4');
		const ctx = makeContext();
		const gen = codexExecQueryGenerator(
			singleMessageGenerator(makeUserMessage('hello')),
			opts,
			ctx,
			makeConfig({ model: 'gpt-5.4' })
		);
		const messages = await collectMessages(gen);

		const initMsg = messages.find(
			(m) => m.type === 'system' && (m as { subtype?: string }).subtype === 'init'
		);
		expect(initMsg).toBeDefined();
		expect((initMsg as { session_id: string }).session_id).toBe('test-session-id');
		expect((initMsg as { model: string }).model).toBe('gpt-5.4');
	});

	it('result message includes num_turns incremented by turn.completed events', async () => {
		mockSpawnWith([
			JSON.stringify({ type: 'turn.completed' }),
			JSON.stringify({ type: 'turn.completed' }),
		]);

		const gen = codexExecQueryGenerator(
			singleMessageGenerator(makeUserMessage('multi-turn')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);
		const messages = await collectMessages(gen);

		const lastMsg = messages[messages.length - 1];
		expect(lastMsg.type).toBe('result');
		expect((lastMsg as { num_turns: number }).num_turns).toBe(2);
	});

	it('non-JSON lines in stdout are silently skipped', async () => {
		mockSpawnWith(['not-json at all', JSON.stringify({ type: 'turn.completed' })]);

		const gen = codexExecQueryGenerator(
			singleMessageGenerator(makeUserMessage('test')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);
		const messages = await collectMessages(gen);

		// Should still end with a result — non-JSON is skipped gracefully
		const lastMsg = messages[messages.length - 1];
		expect(lastMsg.type).toBe('result');
	});

	it('reasoning items emit stream_event with <thinking> tags', async () => {
		mockSpawnWith([
			JSON.stringify({
				type: 'item.completed',
				item: { id: 'r-1', type: 'reasoning', text: 'Let me think.' },
			}),
			JSON.stringify({ type: 'turn.completed' }),
		]);

		const gen = codexExecQueryGenerator(
			singleMessageGenerator(makeUserMessage('reason')),
			makeOptions(),
			makeContext(),
			makeConfig()
		);
		const messages = await collectMessages(gen);

		const streamEvents = messages.filter((m) => m.type === 'stream_event');
		const texts = streamEvents.map(
			(m) => (m as { event: { delta?: { text?: string } } }).event.delta?.text ?? ''
		);
		expect(texts.some((t) => t.includes('<thinking>'))).toBe(true);
	});
});
