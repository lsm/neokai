/**
 * SDK Title Generation Tests
 *
 * Tests for the generateTitleWithSdk private method, covering:
 * - Thinking is disabled to prevent models with adaptive thinking from
 *   returning thinking-only responses (the root cause of the bug fixed in
 *   session/sdk-title-generation-empty-response-error)
 * - Title is correctly extracted from text blocks
 * - Fallback path is used when SDK call fails
 *
 * Design note: only the external @anthropic-ai/claude-agent-sdk package is
 * mocked here. Internal modules (provider-service, sdk-cli-resolver, etc.) use
 * their real implementations to avoid global mock pollution that would break
 * other test files sharing the same bun test process.
 */

import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';

// Track query call options to verify what is passed to the SDK.
// Only updated on calls that carry a `thinking` option (title generation),
// not on model-loading calls (maxTurns: 0).
let lastTitleQueryOptions: Record<string, unknown> | undefined;

// Mutable state controlling which messages the SDK query mock yields for
// title generation. Set in beforeEach so each test starts from a known state.
let mockSdkMessages: unknown[] = [];

async function* makeAsyncGen(messages: unknown[]) {
	for (const msg of messages) {
		yield msg;
	}
}

/**
 * Build a Query-compatible mock from a message list.
 *
 * The returned object is an async iterable (for the title-generation loop) and
 * also exposes the `supportedModels()` / `interrupt()` methods that
 * loadModelsFromSdk() calls when loading the available model list.
 */
function makeQueryMock(messages: unknown[]) {
	const gen = makeAsyncGen(messages);
	return Object.assign(gen, {
		supportedModels: () => Promise.resolve([]),
		interrupt: () => Promise.resolve(),
	});
}

// Only mock.module calls for EXTERNAL packages are placed at the top level.
// Mocking internal relative-import modules here would permanently replace
// them for ALL test files in the same bun test run, breaking tests that
// import those modules directly (e.g. provider-service.test.ts).
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
	query: (params: { prompt: string; options?: Record<string, unknown> }) => {
		const opts = params.options ?? {};
		// Capture options only from the title-generation call, which is the one
		// that carries thinking: { type: 'disabled' }. Model-loading calls use
		// maxTurns: 0 with no thinking option and are not interesting here.
		if ('thinking' in opts) {
			lastTitleQueryOptions = opts;
		}
		return makeQueryMock(mockSdkMessages);
	},
}));

mock.module('@neokai/shared/sdk/type-guards', () => ({
	isSDKAssistantMessage: (msg: { type: string }) => msg.type === 'assistant',
}));

import {
	SessionLifecycle,
	type SessionLifecycleConfig,
} from '../../../src/lib/session/session-lifecycle';
import type { Database } from '../../../src/storage/database';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { WorktreeManager } from '../../../src/lib/worktree-manager';
import type { SessionCache, AgentSessionFactory } from '../../../src/lib/session/session-cache';
import type { ToolsConfigManager } from '../../../src/lib/session/tools-config';
import type { MessageHub } from '@neokai/shared';
import { DEFAULT_GLOBAL_SETTINGS } from '@neokai/shared';

describe('SessionLifecycle - generateTitleWithSdk (thinking disabled)', () => {
	let lifecycle: SessionLifecycle;
	let mockDb: Database;
	let mockWorktreeManager: WorktreeManager;
	let mockSessionCache: SessionCache;
	let mockEventBus: DaemonHub;
	let mockMessageHub: MessageHub;
	let mockToolsConfigManager: ToolsConfigManager;
	let mockAgentSessionFactory: AgentSessionFactory;
	let config: SessionLifecycleConfig;

	const makeSessionCache = () => {
		const mockAgentSession = {
			cleanup: mock(async () => {}),
			updateMetadata: mock(() => {}),
			getSessionData: mock(() => ({
				id: 'test-id',
				title: 'New Session',
				workspacePath: '/test',
				status: 'active',
				metadata: { titleGenerated: false, worktreeChoice: undefined },
				config: {},
				worktree: undefined,
			})),
		};
		return {
			mockAgentSession,
			mockSessionCache: {
				set: mock(() => {}),
				get: mock(() => mockAgentSession),
				has: mock(() => true),
				remove: mock(() => {}),
				clear: mock(() => {}),
				getAsync: mock(async () => mockAgentSession),
			} as unknown as SessionCache,
		};
	};

	beforeEach(() => {
		lastTitleQueryOptions = undefined;
		// Default: assistant message with a plain text block
		mockSdkMessages = [
			{
				type: 'assistant',
				message: {
					content: [{ type: 'text', text: 'My Generated Title' }],
				},
			},
		];

		// Set a fake API key so the real provider service proceeds past the key
		// check and calls generateTitleWithSdk. Cleared in afterEach.
		process.env.ANTHROPIC_API_KEY = 'test-api-key';

		mockDb = {
			createSession: mock(() => {}),
			updateSession: mock(() => {}),
			deleteSession: mock(() => {}),
			getSession: mock(() => null),
			getGlobalSettings: mock(() => ({
				...DEFAULT_GLOBAL_SETTINGS,
				settingSources: ['user', 'project', 'local'],
				disabledMcpServers: [],
			})),
		} as unknown as Database;

		mockWorktreeManager = {
			detectGitSupport: mock(async () => ({ isGitRepo: false, isBare: false })),
			createWorktree: mock(async () => null),
			removeWorktree: mock(async () => {}),
			verifyWorktree: mock(async () => false),
			renameBranch: mock(async () => true),
			getCurrentBranch: mock(async () => 'main'),
		} as unknown as WorktreeManager;

		const { mockAgentSession, mockSessionCache: sessionCache } = makeSessionCache();
		mockSessionCache = sessionCache;
		mockAgentSessionFactory = mock(() => mockAgentSession) as unknown as AgentSessionFactory;

		mockEventBus = {
			on: mock(() => () => {}),
			emit: mock(async () => {}),
		} as unknown as DaemonHub;

		mockMessageHub = {
			event: mock(async () => {}),
			onRequest: mock(() => () => {}),
			query: mock(async () => ({})),
			command: mock(async () => {}),
		} as unknown as MessageHub;

		mockToolsConfigManager = {
			getDefaultForNewSession: mock(() => ({
				useClaudeCodePreset: true,
				settingSources: ['project', 'local'],
				disabledMcpServers: [],
			})),
		} as unknown as ToolsConfigManager;

		config = {
			defaultModel: 'claude-sonnet-4-20250514',
			maxTokens: 8192,
			temperature: 1.0,
			workspaceRoot: '/default/workspace',
			disableWorktrees: true,
		};

		lifecycle = new SessionLifecycle(
			mockDb,
			mockWorktreeManager,
			mockSessionCache,
			mockEventBus,
			mockMessageHub,
			config,
			mockToolsConfigManager,
			mockAgentSessionFactory
		);
	});

	afterEach(() => {
		// Restore the empty API key set by unit-test setup.ts
		process.env.ANTHROPIC_API_KEY = '';
	});

	it('should disable thinking when calling SDK query for title generation', async () => {
		const result = await lifecycle.generateTitleAndRenameBranch('test-id', 'Create a login form');

		expect(result.isFallback).toBe(false);
		expect(lastTitleQueryOptions).toBeDefined();
		expect(lastTitleQueryOptions?.thinking).toEqual({ type: 'disabled' });
	});

	it('should extract title from text blocks', async () => {
		const result = await lifecycle.generateTitleAndRenameBranch('test-id', 'Create a login form');

		expect(result.isFallback).toBe(false);
		expect(result.title).toBe('My Generated Title');
	});

	it('should strip markdown formatting from extracted title', async () => {
		mockSdkMessages = [
			{
				type: 'assistant',
				message: {
					content: [{ type: 'text', text: '**Bold Title Here**' }],
				},
			},
		];

		const result = await lifecycle.generateTitleAndRenameBranch('test-id', 'Create a login form');

		expect(result.isFallback).toBe(false);
		expect(result.title).toBe('Bold Title Here');
	});

	it('should fall back to message text when assistant message contains only thinking blocks', async () => {
		// Regression test for the original bug: models with adaptive thinking (e.g. Opus 4.6)
		// may return an assistant message whose content array contains only thinking blocks with
		// no text block. Without `thinking: { type: 'disabled' }` in the query options, this
		// caused a "No text content in SDK response" error. With the fix in place, this scenario
		// cannot occur in production, but the defensive fallback path should still work correctly.
		mockSdkMessages = [
			{
				type: 'assistant',
				message: {
					content: [{ type: 'thinking', thinking: 'Long internal reasoning about the title...' }],
				},
			},
		];

		const result = await lifecycle.generateTitleAndRenameBranch('test-id', 'Create a login form');

		expect(result.isFallback).toBe(true);
		expect(result.title).toBe('Create a login form');
	});

	it('should fall back to message text when SDK returns no assistant messages', async () => {
		mockSdkMessages = [{ type: 'result', subtype: 'success' }];

		const result = await lifecycle.generateTitleAndRenameBranch('test-id', 'Create a login form');

		expect(result.isFallback).toBe(true);
		expect(result.title).toBe('Create a login form');
	});
});
