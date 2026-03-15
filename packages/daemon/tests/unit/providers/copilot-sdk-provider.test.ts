/**
 * Unit tests for CopilotSdkProvider and copilotSdkQueryGenerator
 *
 * Tests provider properties, availability checks, message mapping helpers,
 * and the generator using a mock CopilotClient that simulates SDK events.
 */

import { beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { SDKUserMessage } from '@neokai/shared/sdk';
import type { UUID } from 'crypto';
import { CopilotSdkProvider } from '../../../src/lib/providers/copilot-sdk-provider';
import {
	copilotSdkQueryGenerator,
	createCopilotSdkSystemInitMessage,
	createCopilotSdkStreamEvent,
	copilotSdkMessageToSdkAssistant,
	type CopilotSdkAdapterConfig,
} from '../../../src/lib/providers/copilot-sdk-adapter';
import type { CopilotClient, CopilotSession } from '@github/copilot-sdk';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePrompt(text: string): AsyncGenerator<SDKUserMessage> {
	const msg: SDKUserMessage = {
		type: 'user',
		uuid: '00000000-0000-0000-0000-000000000001' as UUID,
		session_id: 'test-session',
		message: { role: 'user', content: text },
		parent_tool_use_id: null,
	};
	return (async function* () {
		yield msg;
	})();
}

function makeContext(aborted = false) {
	const controller = new AbortController();
	if (aborted) controller.abort();
	return { signal: controller.signal, sessionId: 'test-session', usesCustomQuery: true };
}

function makeOptions(
	overrides: Partial<{ model: string; cwd: string; systemPrompt: string }> = {}
) {
	return {
		model: overrides.model ?? 'claude-sonnet-4.6',
		cwd: overrides.cwd ?? '/tmp',
		tools: [],
		maxTurns: 10,
		systemPrompt: overrides.systemPrompt,
	};
}

// ---------------------------------------------------------------------------
// Minimal mock for CopilotSession
// ---------------------------------------------------------------------------

type EventHandler = (event: { data: Record<string, unknown> }) => void;

class MockCopilotSession {
	readonly sessionId = 'mock-sdk-session-id';
	private handlers = new Map<string, EventHandler[]>();

	on(eventType: string | EventHandler, handler?: EventHandler): () => void {
		if (typeof eventType === 'string' && handler) {
			if (!this.handlers.has(eventType)) this.handlers.set(eventType, []);
			this.handlers.get(eventType)!.push(handler);
		}
		return () => {};
	}

	emit(eventType: string, data: Record<string, unknown>): void {
		for (const h of this.handlers.get(eventType) ?? []) {
			h({ data });
		}
	}

	async send(_opts: unknown): Promise<string> {
		return 'msg-id-1';
	}

	async abort(): Promise<void> {}
	async disconnect(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Minimal mock for CopilotClient
// ---------------------------------------------------------------------------

function makeMockClient(
	sessionFactory?: () => MockCopilotSession
): CopilotClient & { _session?: MockCopilotSession } {
	const mock = {
		_session: undefined as MockCopilotSession | undefined,
		async createSession(_cfg: unknown): Promise<CopilotSession> {
			const session = sessionFactory ? sessionFactory() : new MockCopilotSession();
			mock._session = session;
			return session as unknown as CopilotSession;
		},
		async resumeSession(_id: string, _cfg: unknown): Promise<CopilotSession> {
			const session = sessionFactory ? sessionFactory() : new MockCopilotSession();
			mock._session = session;
			return session as unknown as CopilotSession;
		},
	};
	return mock as unknown as CopilotClient & { _session?: MockCopilotSession };
}

function makeConfig(overrides: Partial<CopilotSdkAdapterConfig> = {}): CopilotSdkAdapterConfig {
	return {
		client: makeMockClient(),
		model: 'claude-sonnet-4.6',
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// CopilotSdkProvider basic properties
// ---------------------------------------------------------------------------

describe('CopilotSdkProvider', () => {
	let provider: CopilotSdkProvider;

	beforeEach(() => {
		provider = new CopilotSdkProvider({});
	});

	describe('basic properties', () => {
		it('should have correct provider ID', () => {
			expect(provider.id).toBe('github-copilot-sdk');
		});

		it('should have correct display name', () => {
			expect(provider.displayName).toBe('GitHub Copilot (SDK)');
		});

		it('should have streaming capability', () => {
			expect(provider.capabilities.streaming).toBe(true);
		});

		it('should have functionCalling=false (CLI executes tools autonomously)', () => {
			expect(provider.capabilities.functionCalling).toBe(false);
		});

		it('should have vision=false', () => {
			expect(provider.capabilities.vision).toBe(false);
		});
	});

	describe('ownsModel', () => {
		it('should own all copilot-sdk-* aliases', () => {
			expect(provider.ownsModel('copilot-sdk-opus')).toBe(true);
			expect(provider.ownsModel('copilot-sdk-sonnet')).toBe(true);
			expect(provider.ownsModel('copilot-sdk-codex')).toBe(true);
			expect(provider.ownsModel('copilot-sdk-gemini')).toBe(true);
			expect(provider.ownsModel('copilot-sdk-mini')).toBe(true);
		});

		it('should NOT own any bare model IDs shared with other providers', () => {
			// Claude IDs: also claimed by GitHubCopilotProvider and CopilotCliProvider
			expect(provider.ownsModel('claude-opus-4.6')).toBe(false);
			expect(provider.ownsModel('claude-sonnet-4.6')).toBe(false);
			// Non-Anthropic IDs: gpt-5.3-codex/gpt-5-mini claimed by GitHubCopilotProvider (registered first); gemini-3-pro-preview by CopilotCliProvider
			expect(provider.ownsModel('gpt-5.3-codex')).toBe(false);
			expect(provider.ownsModel('gemini-3-pro-preview')).toBe(false);
			expect(provider.ownsModel('gpt-5-mini')).toBe(false);
		});

		it('should not own copilot-cli-* aliases (those belong to CopilotCliProvider)', () => {
			expect(provider.ownsModel('copilot-cli-sonnet')).toBe(false);
		});

		it('should not own unknown models', () => {
			expect(provider.ownsModel('llama-3')).toBe(false);
		});
	});

	describe('getModelForTier', () => {
		it('should return opus model for opus tier', () => {
			expect(provider.getModelForTier('opus')).toBe('claude-opus-4.6');
		});

		it('should return sonnet model for sonnet tier', () => {
			expect(provider.getModelForTier('sonnet')).toBe('claude-sonnet-4.6');
		});

		it('should return gpt-5-mini for haiku tier', () => {
			expect(provider.getModelForTier('haiku')).toBe('gpt-5-mini');
		});

		it('should return sonnet as default', () => {
			expect(provider.getModelForTier('default')).toBe('claude-sonnet-4.6');
		});
	});

	describe('buildSdkConfig', () => {
		it('should return empty non-Anthropic config (createQuery is used instead)', () => {
			const config = provider.buildSdkConfig('claude-sonnet-4.6');
			expect(config.isAnthropicCompatible).toBe(false);
			expect(config.envVars).toEqual({});
		});
	});

	describe('isAvailable', () => {
		it('should return false when binary not found', async () => {
			const p = new CopilotSdkProvider({});
			const findSpy = spyOn(
				p as Parameters<typeof spyOn>[0],
				'findCopilotCli' as Parameters<typeof spyOn>[1]
			);
			(findSpy as ReturnType<typeof spyOn>).mockResolvedValue(null);
			const result = await p.isAvailable();
			expect(result).toBe(false);
		});

		it('should return true when token is set and binary exists', async () => {
			const p = new CopilotSdkProvider({ COPILOT_GITHUB_TOKEN: 'ghp_test' });
			const findSpy = spyOn(
				p as Parameters<typeof spyOn>[0],
				'findCopilotCli' as Parameters<typeof spyOn>[1]
			);
			(findSpy as ReturnType<typeof spyOn>).mockResolvedValue('/usr/local/bin/copilot');
			const result = await p.isAvailable();
			expect(result).toBe(true);
		});

		it('should return false when binary not found even with token', async () => {
			const p = new CopilotSdkProvider({ COPILOT_GITHUB_TOKEN: 'ghp_test' });
			const findSpy = spyOn(
				p as Parameters<typeof spyOn>[0],
				'findCopilotCli' as Parameters<typeof spyOn>[1]
			);
			(findSpy as ReturnType<typeof spyOn>).mockResolvedValue(null);
			const result = await p.isAvailable();
			expect(result).toBe(false);
		});
	});

	describe('getAuthStatus', () => {
		it('should return not authenticated when binary not found', async () => {
			const p = new CopilotSdkProvider({});
			const findSpy = spyOn(
				p as Parameters<typeof spyOn>[0],
				'findCopilotCli' as Parameters<typeof spyOn>[1]
			);
			(findSpy as ReturnType<typeof spyOn>).mockResolvedValue(null);
			const status = await p.getAuthStatus();
			expect(status.isAuthenticated).toBe(false);
			expect(status.error).toContain('not installed');
		});

		it('should return authenticated when token is set and binary exists', async () => {
			const p = new CopilotSdkProvider({ COPILOT_GITHUB_TOKEN: 'ghp_test' });
			const findSpy = spyOn(
				p as Parameters<typeof spyOn>[0],
				'findCopilotCli' as Parameters<typeof spyOn>[1]
			);
			(findSpy as ReturnType<typeof spyOn>).mockResolvedValue('/usr/local/bin/copilot');
			const status = await p.getAuthStatus();
			expect(status.isAuthenticated).toBe(true);
		});
	});
});

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

describe('createCopilotSdkSystemInitMessage', () => {
	it('should build a system init message with correct fields', () => {
		const msg = createCopilotSdkSystemInitMessage('sess-1', makeOptions());
		expect(msg.type).toBe('system');
		expect(msg.subtype).toBe('init');
		expect(msg.session_id).toBe('sess-1');
		expect(msg.model).toBe('claude-sonnet-4.6');
		expect(msg.claude_code_version).toBe('copilot-sdk-adapter');
	});
});

describe('createCopilotSdkStreamEvent', () => {
	it('should build a stream_event with text_delta', () => {
		const msg = createCopilotSdkStreamEvent('sess-1', 'Hello');
		expect(msg.type).toBe('stream_event');
		expect(msg.session_id).toBe('sess-1');
		expect((msg.event as { delta: { text: string } }).delta.text).toBe('Hello');
	});
});

describe('copilotSdkMessageToSdkAssistant', () => {
	it('should map plain text content to text block', () => {
		const msg = copilotSdkMessageToSdkAssistant({ messageId: 'm1', content: 'Hello!' }, 'sess-1');
		expect(msg.type).toBe('assistant');
		const blocks = msg.message.content as Array<{ type: string; text?: string }>;
		expect(blocks.find((b) => b.type === 'text')?.text).toBe('Hello!');
	});

	it('should prepend reasoning as thinking block when present', () => {
		const msg = copilotSdkMessageToSdkAssistant(
			{ messageId: 'm1', content: 'Answer', reasoningText: 'Let me think...' },
			'sess-1'
		);
		const blocks = msg.message.content as Array<{ type: string; thinking?: string }>;
		expect(blocks[0].type).toBe('thinking');
		expect(blocks[0].thinking).toBe('Let me think...');
	});

	it('should map tool requests to tool_use blocks using toolCallId', () => {
		const msg = copilotSdkMessageToSdkAssistant(
			{
				messageId: 'm1',
				content: '',
				toolRequests: [{ toolCallId: 'tc-42', name: 'bash', arguments: { cmd: 'ls' } }],
			},
			'sess-1'
		);
		const blocks = msg.message.content as Array<{
			type: string;
			id?: string;
			name?: string;
		}>;
		const toolBlock = blocks.find((b) => b.type === 'tool_use');
		expect(toolBlock?.id).toBe('tc-42');
		expect(toolBlock?.name).toBe('bash');
	});
});

// ---------------------------------------------------------------------------
// copilotSdkQueryGenerator — early-exit paths
// ---------------------------------------------------------------------------

describe('copilotSdkQueryGenerator (early exits)', () => {
	it('should yield system init message as first message', async () => {
		const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {})();
		const msgs: Array<{ type: string }> = [];
		for await (const msg of copilotSdkQueryGenerator(
			prompt,
			makeOptions(),
			makeContext(),
			makeConfig()
		)) {
			msgs.push({ type: msg.type });
		}
		expect(msgs[0]?.type).toBe('system');
	});

	it('should yield error result when prompt generator is empty', async () => {
		const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {})();
		const msgs = [];
		for await (const msg of copilotSdkQueryGenerator(
			prompt,
			makeOptions(),
			makeContext(),
			makeConfig()
		)) {
			msgs.push(msg);
		}
		const result = msgs.find((m) => m.type === 'result');
		expect(result?.is_error).toBe(true);
		expect((result as { errors?: string[] }).errors?.[0]).toContain('No user message');
	});

	it('should yield error result when signal is already aborted', async () => {
		const msgs = [];
		for await (const msg of copilotSdkQueryGenerator(
			makePrompt('test'),
			makeOptions(),
			makeContext(true), // pre-aborted
			makeConfig()
		)) {
			msgs.push(msg);
		}
		const result = msgs.find((m) => m.type === 'result');
		expect(result?.is_error).toBe(true);
		expect((result as { errors?: string[] }).errors?.[0]).toContain('aborted');
	});

	it('should yield error result when prompt text is empty whitespace', async () => {
		const msgs = [];
		for await (const msg of copilotSdkQueryGenerator(
			makePrompt('   '),
			makeOptions(),
			makeContext(),
			makeConfig()
		)) {
			msgs.push(msg);
		}
		const result = msgs.find((m) => m.type === 'result');
		expect(result?.is_error).toBe(true);
		expect((result as { errors?: string[] }).errors?.[0]).toContain('Empty prompt');
	});

	it('should yield error result when createSession throws', async () => {
		const badClient = {
			createSession: async () => {
				throw new Error('Connection refused');
			},
			resumeSession: async () => {
				throw new Error('Connection refused');
			},
		} as unknown as CopilotClient;

		const msgs = [];
		for await (const msg of copilotSdkQueryGenerator(
			makePrompt('test'),
			makeOptions(),
			makeContext(),
			{ ...makeConfig(), client: badClient }
		)) {
			msgs.push(msg);
		}
		const result = msgs.find((m) => m.type === 'result');
		expect(result?.is_error).toBe(true);
		expect((result as { errors?: string[] }).errors?.[0]).toContain('Copilot SDK error');
	});
});

// ---------------------------------------------------------------------------
// copilotSdkQueryGenerator — happy path with mocked session events
// ---------------------------------------------------------------------------

describe('copilotSdkQueryGenerator (mock session events)', () => {
	/**
	 * Helper: run the generator with a mock session that emits the given
	 * event sequence immediately after send() returns, then fires session.idle.
	 */
	async function runWithEvents(
		events: Array<[string, Record<string, unknown>]>
	): Promise<Array<{ type: string; is_error?: boolean; subtype?: string }>> {
		const session = new MockCopilotSession();

		// Override send() to emit events then idle after a microtask delay
		const origSend = session.send.bind(session);
		session.send = async (opts: unknown): Promise<string> => {
			const result = await origSend(opts);
			// Defer emission so event handlers are registered before events fire
			queueMicrotask(() => {
				for (const [type, data] of events) {
					session.emit(type, data);
				}
				session.emit('session.idle', {});
			});
			return result;
		};

		const client = makeMockClient(() => session);
		const msgs: Array<{ type: string; is_error?: boolean; subtype?: string }> = [];
		for await (const msg of copilotSdkQueryGenerator(
			makePrompt('hello'),
			makeOptions(),
			makeContext(),
			{ ...makeConfig(), client }
		)) {
			msgs.push({
				type: msg.type,
				is_error: (msg as { is_error?: boolean }).is_error,
				subtype: (msg as { subtype?: string }).subtype,
			});
		}
		return msgs;
	}

	it('should yield success result when session.idle fires with no events', async () => {
		const msgs = await runWithEvents([]);
		const result = msgs.find((m) => m.type === 'result');
		expect(result?.is_error).toBe(false);
		expect(result?.subtype).toBe('success');
	});

	it('should yield stream_event for each assistant.message_delta', async () => {
		const msgs = await runWithEvents([
			['assistant.message_delta', { deltaContent: 'Hello' }],
			['assistant.message_delta', { deltaContent: ' world' }],
		]);
		const streamEvents = msgs.filter((m) => m.type === 'stream_event');
		expect(streamEvents.length).toBe(2);
	});

	it('should yield assistant message for assistant.message event', async () => {
		const msgs = await runWithEvents([
			[
				'assistant.message',
				{
					messageId: 'm1',
					content: 'I can help with that.',
					toolRequests: [],
				},
			],
		]);
		expect(msgs.some((m) => m.type === 'assistant')).toBe(true);
	});

	it('should yield error result when session.error fires', async () => {
		const session = new MockCopilotSession();

		session.send = async (_opts: unknown): Promise<string> => {
			queueMicrotask(() => {
				session.emit('session.error', {
					errorType: 'authentication',
					message: 'Token expired',
				});
			});
			return 'msg-id';
		};

		const client = makeMockClient(() => session);
		const msgs: Array<{ type: string; is_error?: boolean }> = [];
		for await (const msg of copilotSdkQueryGenerator(
			makePrompt('test'),
			makeOptions(),
			makeContext(),
			{ ...makeConfig(), client }
		)) {
			msgs.push({ type: msg.type, is_error: (msg as { is_error?: boolean }).is_error });
		}
		const result = msgs.find((m) => m.type === 'result');
		expect(result?.is_error).toBe(true);
	});

	it('should call onSessionId callback with session ID', async () => {
		let capturedId: string | undefined;
		const session = new MockCopilotSession();

		session.send = async (_opts: unknown): Promise<string> => {
			queueMicrotask(() => {
				session.emit('session.idle', {});
			});
			return 'msg-id';
		};

		const client = makeMockClient(() => session);
		for await (const _ of copilotSdkQueryGenerator(
			makePrompt('test'),
			makeOptions(),
			makeContext(),
			{
				...makeConfig(),
				client,
				onSessionId: (id) => {
					capturedId = id;
				},
			}
		)) {
			// consume
		}

		expect(capturedId).toBe('mock-sdk-session-id');
	});

	it('should use resumeSession when resumeSessionId is provided', async () => {
		let usedResume = false;
		const session = new MockCopilotSession();
		session.send = async (_opts: unknown): Promise<string> => {
			queueMicrotask(() => session.emit('session.idle', {}));
			return 'msg-id';
		};

		const client = {
			createSession: async () => {
				throw new Error('should not call createSession');
			},
			resumeSession: async (_id: string, _cfg: unknown): Promise<CopilotSession> => {
				usedResume = true;
				return session as unknown as CopilotSession;
			},
		} as unknown as CopilotClient;

		for await (const _ of copilotSdkQueryGenerator(
			makePrompt('continue'),
			makeOptions(),
			makeContext(),
			{ ...makeConfig(), client, resumeSessionId: 'prev-session-123' }
		)) {
			// consume
		}

		expect(usedResume).toBe(true);
	});

	it('should prepend systemPrompt as [Context: ...] prefix in session.send()', async () => {
		let capturedPrompt: string | undefined;
		const session = new MockCopilotSession();

		session.send = async (opts: unknown): Promise<string> => {
			capturedPrompt = (opts as { prompt: string }).prompt;
			queueMicrotask(() => session.emit('session.idle', {}));
			return 'msg-id';
		};

		const client = makeMockClient(() => session);
		for await (const _ of copilotSdkQueryGenerator(
			makePrompt('user question'),
			makeOptions({ systemPrompt: 'be concise' }),
			makeContext(),
			{ ...makeConfig(), client }
		)) {
			// consume
		}

		expect(capturedPrompt).toStartWith('[Context: be concise]\n\n');
		expect(capturedPrompt).toContain('user question');
	});

	it('should send prompt without prefix when no systemPrompt is set', async () => {
		let capturedPrompt: string | undefined;
		const session = new MockCopilotSession();

		session.send = async (opts: unknown): Promise<string> => {
			capturedPrompt = (opts as { prompt: string }).prompt;
			queueMicrotask(() => session.emit('session.idle', {}));
			return 'msg-id';
		};

		const client = makeMockClient(() => session);
		for await (const _ of copilotSdkQueryGenerator(
			makePrompt('bare question'),
			makeOptions(), // no systemPrompt
			makeContext(),
			{ ...makeConfig(), client }
		)) {
			// consume
		}

		expect(capturedPrompt).toBe('bare question');
	});
});

// ---------------------------------------------------------------------------
// Factory registration
// ---------------------------------------------------------------------------

describe('CopilotSdkProvider shutdown()', () => {
	it('stops the CopilotClient and clears clientCache', async () => {
		const provider = new CopilotSdkProvider({});
		let clientStopped = false;
		(provider as unknown as Record<string, unknown>)['clientCache'] = {
			stop: async () => {
				clientStopped = true;
				return [];
			},
		};
		await provider.shutdown();
		expect(clientStopped).toBe(true);
		expect((provider as unknown as Record<string, unknown>)['clientCache']).toBeUndefined();
	});

	it('is safe to call when client was never started', async () => {
		const provider = new CopilotSdkProvider({});
		await expect(provider.shutdown()).resolves.toBeUndefined();
	});
});

describe('CopilotSdkProvider factory registration', () => {
	it('should be registered by initializeProviders()', async () => {
		const { initializeProviders, resetProviderFactory } = await import(
			'../../../src/lib/providers/factory'
		);
		const { resetProviderRegistry } = await import('../../../src/lib/providers/registry');

		resetProviderFactory();
		resetProviderRegistry();

		const registry = initializeProviders();
		const prov = registry.get('github-copilot-sdk');
		expect(prov).toBeDefined();
		expect(prov?.id).toBe('github-copilot-sdk');
		expect(prov?.displayName).toBe('GitHub Copilot (SDK)');

		resetProviderFactory();
		resetProviderRegistry();
	});
});
