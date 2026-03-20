/**
 * SDK Title Generation Tests
 *
 * Tests for the generateTitleWithSdk private method, covering:
 * - Thinking is disabled to prevent models with adaptive thinking from
 *   returning thinking-only responses (the root cause of the bug fixed in
 *   session/sdk-title-generation-empty-response-error)
 * - Title is correctly extracted from text blocks
 * - Fallback path is used when SDK call fails
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';

// Track query call arguments to verify options
let lastQueryOptions: Record<string, unknown> | undefined;

// Mutable state controlling what messages the SDK query mock returns.
// Tests set this in beforeEach to avoid calling mock.module() inside test bodies,
// which would permanently override the module registry for subsequent tests.
let mockSdkMessages: unknown[] = [];

async function* makeAsyncGen(messages: unknown[]) {
	for (const msg of messages) {
		yield msg;
	}
}

// All mock.module calls must be at the top level — Bun hoists them before imports.
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
	query: (params: { prompt: string; options?: Record<string, unknown> }) => {
		lastQueryOptions = params.options;
		return makeAsyncGen(mockSdkMessages);
	},
}));

mock.module('@neokai/shared/sdk/type-guards', () => ({
	isSDKAssistantMessage: (msg: { type: string }) => msg.type === 'assistant',
}));

mock.module('../../../src/lib/provider-service', () => {
	const mockProviderService = {
		getDefaultProvider: mock(async () => 'anthropic'),
		getProviderApiKey: mock(() => 'test-api-key'),
		isProviderAvailable: mock(async () => true),
		applyEnvVarsToProcessForProvider: mock(() => ({})),
		getEnvVarsForModel: mock(() => ({})),
		restoreEnvVars: mock(() => {}),
		getTitleGenerationConfig: mock(async () => ({ modelId: 'claude-haiku-4-5-20251001' })),
	};
	return {
		getProviderService: () => mockProviderService,
		mergeProviderEnvVars: (vars: Record<string, string>) => ({ ...process.env, ...vars }),
	};
});

mock.module('../../../src/lib/agent/sdk-cli-resolver.js', () => ({
	resolveSDKCliPath: () => '/fake/cli/path',
	isRunningUnderBun: () => false,
}));

mock.module('../../../src/lib/sdk-session-file-manager', () => ({
	deleteSDKSessionFiles: mock(async () => {}),
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
		lastQueryOptions = undefined;
		// Default: assistant message with a plain text block
		mockSdkMessages = [
			{
				type: 'assistant',
				message: {
					content: [{ type: 'text', text: 'My Generated Title' }],
				},
			},
		];

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

	it('should disable thinking when calling SDK query for title generation', async () => {
		const result = await lifecycle.generateTitleAndRenameBranch('test-id', 'Create a login form');

		expect(result.isFallback).toBe(false);
		expect(lastQueryOptions).toBeDefined();
		expect(lastQueryOptions?.thinking).toEqual({ type: 'disabled' });
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
