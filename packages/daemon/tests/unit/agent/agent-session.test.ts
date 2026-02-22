/**
 * AgentSession Tests
 *
 * Tests for the main agent orchestration class.
 * Note: AgentSession has many dependencies, so we test what we can without
 * using mock.module() which affects other test files globally.
 */

import { describe, expect, it, mock, beforeEach } from 'bun:test';
import type {
	Session,
	ContextInfo,
	AgentProcessingState,
	SelectiveRewindResult,
	RewindMode,
} from '@neokai/shared';
import { AgentSession } from '../../../src/lib/agent/agent-session';
import type { Database } from '../../../src/storage/database';
import type { MessageHub, DaemonHub } from '@neokai/shared';

// Test the AgentSession class indirectly through its components
// since direct testing with mock.module() causes global mock pollution

describe('AgentSession', () => {
	describe('session data structure', () => {
		it('should have required session fields', () => {
			const mockSession: Session = {
				id: 'test-session-id',
				title: 'Test Session',
				workspacePath: '/test/workspace',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-20250514',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			};

			expect(mockSession.id).toBe('test-session-id');
			expect(mockSession.title).toBe('Test Session');
			expect(mockSession.status).toBe('active');
			expect(mockSession.config.model).toBe('claude-sonnet-4-20250514');
			expect(mockSession.metadata.messageCount).toBe(0);
		});

		it('should support optional worktree fields', () => {
			const mockSession: Session = {
				id: 'test-session-id',
				title: 'Test Session',
				workspacePath: '/test/workspace',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-20250514',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
				worktree: {
					worktreePath: '/test/worktree',
					mainRepoPath: '/test/repo',
					branch: 'session/test',
				},
			};

			expect(mockSession.worktree).toBeDefined();
			expect(mockSession.worktree?.worktreePath).toBe('/test/worktree');
			expect(mockSession.worktree?.branch).toBe('session/test');
		});
	});

	describe('processing state structure', () => {
		it('should have idle state', () => {
			const state: AgentProcessingState = {
				status: 'idle',
				phase: null,
			};

			expect(state.status).toBe('idle');
			expect(state.phase).toBeNull();
		});

		it('should have processing state with phase', () => {
			const state: AgentProcessingState = {
				status: 'processing',
				phase: 'thinking',
			};

			expect(state.status).toBe('processing');
			expect(state.phase).toBe('thinking');
		});

		it('should have waiting_for_input state', () => {
			const state: AgentProcessingState = {
				status: 'waiting_for_input',
				phase: null,
				pendingQuestion: {
					toolUseId: 'test-tool-id',
					questions: [],
				},
			};

			expect(state.status).toBe('waiting_for_input');
			expect(state.pendingQuestion?.toolUseId).toBe('test-tool-id');
		});
	});

	describe('context info structure', () => {
		it('should have required context fields', () => {
			const contextInfo: ContextInfo = {
				currentTokens: 1000,
				maxTokens: 200000,
				usagePercentage: 0.5,
				modelName: 'claude-sonnet-4',
				breakdown: {
					systemPrompt: 500,
					conversation: 400,
					tools: 100,
				},
			};

			expect(contextInfo.currentTokens).toBe(1000);
			expect(contextInfo.maxTokens).toBe(200000);
			expect(contextInfo.usagePercentage).toBe(0.5);
			expect(contextInfo.breakdown.systemPrompt).toBe(500);
		});
	});

	describe('metadata updates', () => {
		it('should support partial metadata updates', () => {
			const metadata = {
				messageCount: 5,
				totalTokens: 1000,
				inputTokens: 600,
				outputTokens: 400,
				totalCost: 0.01,
				toolCallCount: 3,
			};

			// Simulate partial update
			const updates = { toolCallCount: 10 };
			const merged = { ...metadata, ...updates };

			expect(merged.messageCount).toBe(5);
			expect(merged.toolCallCount).toBe(10);
		});

		it('should support config updates', () => {
			const config = {
				model: 'claude-sonnet-4-20250514',
				maxTokens: 8192,
				temperature: 1.0,
			};

			const updates = { model: 'claude-opus-4-20250514' };
			const merged = { ...config, ...updates };

			expect(merged.model).toBe('claude-opus-4-20250514');
			expect(merged.maxTokens).toBe(8192);
		});
	});

	describe('model switching interface', () => {
		it('should have correct model switch result structure', () => {
			const successResult = {
				success: true,
				model: 'claude-opus-4-20250514',
			};

			expect(successResult.success).toBe(true);
			expect(successResult.model).toBe('claude-opus-4-20250514');
		});

		it('should have correct model switch error structure', () => {
			const errorResult = {
				success: false,
				model: 'claude-opus-4-20250514',
				error: 'Model not available',
			};

			expect(errorResult.success).toBe(false);
			expect(errorResult.error).toBe('Model not available');
		});
	});

	describe('checkpoint structure', () => {
		it('should have correct checkpoint fields', () => {
			const checkpoint = {
				id: 'checkpoint-123',
				messageId: 'msg-123',
				timestamp: Date.now(),
				userMessagePreview: 'Help me with...',
				sdkMessageIndex: 5,
			};

			expect(checkpoint.id).toBe('checkpoint-123');
			expect(checkpoint.messageId).toBe('msg-123');
			expect(checkpoint.userMessagePreview).toBe('Help me with...');
		});
	});

	describe('question response structure', () => {
		it('should have correct question response fields', () => {
			const response = {
				questionIndex: 0,
				selectedOptionIndices: [0, 2],
				customText: 'custom input',
			};

			expect(response.questionIndex).toBe(0);
			expect(response.selectedOptionIndices).toEqual([0, 2]);
			expect(response.customText).toBe('custom input');
		});
	});

	describe('component initialization', () => {
		let mockSession: Session;
		let mockDb: Database;
		let mockMessageHub: MessageHub;
		let mockDaemonHub: DaemonHub;
		let mockGetApiKey: () => Promise<string | null>;
		let agentSession: AgentSession;

		beforeEach(() => {
			mockSession = {
				id: 'test-session-id',
				title: 'Test Session',
				workspacePath: '/test/workspace',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-20250514',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			} as Session;

			mockDb = {
				getSession: mock(() => mockSession),
				updateSession: mock(() => {}),
				getUserMessages: mock(() => []),
				getSDKMessages: mock(() => ({ messages: [], hasMore: false })),
				deleteMessagesAfter: mock(() => 0),
				deleteMessagesAtAndAfter: mock(() => 0),
				getUserMessageByUuid: mock(() => undefined),
				countMessagesAfter: mock(() => 0),
				getMessagesByStatus: mock(() => []),
				updateMessage: mock(() => {}),
				getSDKMessageCount: mock(() => 0),
			} as unknown as Database;

			mockMessageHub = {
				sendMessage: mock(() => {}),
			} as unknown as MessageHub;

			mockDaemonHub = {
				emit: mock(async () => {}),
				on: mock(() => mock(() => {})),
			} as unknown as DaemonHub;

			mockGetApiKey = mock(async () => 'test-api-key');

			agentSession = new AgentSession(
				mockSession,
				mockDb,
				mockMessageHub,
				mockDaemonHub,
				mockGetApiKey
			);
		});

		it('should initialize messageQueue component', () => {
			expect(agentSession.messageQueue).toBeDefined();
			expect(agentSession.messageQueue.isRunning()).toBe(false);
		});

		it('should initialize stateManager component', () => {
			expect(agentSession.stateManager).toBeDefined();
			expect(agentSession.stateManager.getState().status).toBe('idle');
		});

		it('should initialize contextTracker component', () => {
			expect(agentSession.contextTracker).toBeDefined();
		});

		it('should initialize messageHandler component', () => {
			expect(agentSession.messageHandler).toBeDefined();
		});

		it('should initialize lifecycleManager component', () => {
			expect(agentSession.lifecycleManager).toBeDefined();
		});

		it('should initialize modelSwitchHandler component', () => {
			expect(agentSession.modelSwitchHandler).toBeDefined();
		});

		it('should initialize askUserQuestionHandler component', () => {
			expect(agentSession.askUserQuestionHandler).toBeDefined();
		});

		it('should initialize optionsBuilder component', () => {
			expect(agentSession.optionsBuilder).toBeDefined();
		});

		it('should initialize interruptHandler component', () => {
			expect(agentSession.interruptHandler).toBeDefined();
		});

		it('should initialize queryModeHandler component', () => {
			expect(agentSession.queryModeHandler).toBeDefined();
		});

		it('should initialize with null query state', () => {
			expect(agentSession.queryObject).toBeNull();
			expect(agentSession.queryPromise).toBeNull();
			expect(agentSession.queryAbortController).toBeNull();
		});

		it('should initialize with false firstMessageReceived', () => {
			expect(agentSession.firstMessageReceived).toBe(false);
		});

		it('should initialize with false cleaningUp state', () => {
			expect(agentSession.isCleaningUp()).toBe(false);
		});
	});

	describe('getter methods', () => {
		let mockSession: Session;
		let mockDb: Database;
		let mockMessageHub: MessageHub;
		let mockDaemonHub: DaemonHub;
		let mockGetApiKey: () => Promise<string | null>;
		let agentSession: AgentSession;

		beforeEach(() => {
			mockSession = {
				id: 'test-session-id',
				title: 'Test Session',
				workspacePath: '/test/workspace',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-20250514',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 5,
					totalTokens: 100,
					inputTokens: 50,
					outputTokens: 50,
					totalCost: 0.01,
					toolCallCount: 2,
				},
			} as Session;

			mockDb = {
				getSession: mock(() => mockSession),
				updateSession: mock(() => {}),
				getSDKMessages: mock(() => ({ messages: [{ id: 'msg1' }], hasMore: false })),
				getSDKMessageCount: mock(() => 10),
			} as unknown as Database;

			mockMessageHub = {
				sendMessage: mock(() => {}),
			} as unknown as MessageHub;

			mockDaemonHub = {
				emit: mock(async () => {}),
				on: mock(() => mock(() => {})),
			} as unknown as DaemonHub;

			mockGetApiKey = mock(async () => 'test-api-key');

			agentSession = new AgentSession(
				mockSession,
				mockDb,
				mockMessageHub,
				mockDaemonHub,
				mockGetApiKey
			);
		});

		it('getProcessingState should delegate to stateManager', () => {
			const state = agentSession.getProcessingState();
			expect(state.status).toBe('idle');
		});

		it('getContextInfo should delegate to contextTracker', () => {
			const info = agentSession.getContextInfo();
			// May be null if no context has been tracked yet
			expect(info).toBeNull();
		});

		it('getQueryObject should return query object', () => {
			expect(agentSession.getQueryObject()).toBeNull();
		});

		it('getFirstMessageReceived should return firstMessageReceived flag', () => {
			expect(agentSession.getFirstMessageReceived()).toBe(false);
		});

		it('getSessionData should return session data', () => {
			const data = agentSession.getSessionData();
			expect(data.id).toBe('test-session-id');
			expect(data.title).toBe('Test Session');
		});

		it('getSDKMessages should delegate to database', () => {
			const { messages, hasMore } = agentSession.getSDKMessages(10);
			expect(messages).toEqual([{ id: 'msg1' }]);
			expect(hasMore).toBe(false);
		});

		it('getSDKMessageCount should delegate to database', () => {
			const count = agentSession.getSDKMessageCount();
			expect(count).toBe(10);
		});

		it('getSDKSessionId should return null when no query object', () => {
			expect(agentSession.getSDKSessionId()).toBeNull();
		});

		it('getSDKSessionId should return sessionId when query object has it', () => {
			agentSession.queryObject = {
				sessionId: 'sdk-session-123',
			} as unknown as AgentSession['queryObject'];
			expect(agentSession.getSDKSessionId()).toBe('sdk-session-123');
		});

		it('getCurrentModel should delegate to modelSwitchHandler', () => {
			const model = agentSession.getCurrentModel();
			expect(model.id).toBe('claude-sonnet-4-20250514');
		});
	});

	describe('delegation methods', () => {
		let mockSession: Session;
		let mockDb: Database;
		let mockMessageHub: MessageHub;
		let mockDaemonHub: DaemonHub;
		let mockGetApiKey: () => Promise<string | null>;
		let agentSession: AgentSession;

		beforeEach(() => {
			mockSession = {
				id: 'test-session-id',
				title: 'Test Session',
				workspacePath: '/test/workspace',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-20250514',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			} as Session;

			mockDb = {
				getSession: mock(() => mockSession),
				updateSession: mock(() => {}),
				getUserMessages: mock(() => []),
				getSDKMessages: mock(() => ({ messages: [], hasMore: false })),
				deleteMessagesAfter: mock(() => 0),
				deleteMessagesAtAndAfter: mock(() => 0),
				getUserMessageByUuid: mock(() => undefined),
				countMessagesAfter: mock(() => 0),
				getMessagesByStatus: mock(() => []),
				updateMessage: mock(() => {}),
			} as unknown as Database;

			mockMessageHub = {
				sendMessage: mock(() => {}),
			} as unknown as MessageHub;

			mockDaemonHub = {
				emit: mock(async () => {}),
				on: mock(() => mock(() => {})),
			} as unknown as DaemonHub;

			mockGetApiKey = mock(async () => 'test-api-key');

			agentSession = new AgentSession(
				mockSession,
				mockDb,
				mockMessageHub,
				mockDaemonHub,
				mockGetApiKey
			);
		});

		it('handleModelSwitch should delegate to modelSwitchHandler', async () => {
			const mockResult = { success: true, model: 'claude-opus-4-20250514' };
			const switchModelSpy = mock(() => mockResult);
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).modelSwitchHandler = {
				switchModel: switchModelSpy,
			};

			const result = await agentSession.handleModelSwitch('claude-opus-4-20250514');

			expect(switchModelSpy).toHaveBeenCalledWith('claude-opus-4-20250514');
			expect(result).toEqual(mockResult);
		});

		it('handleQuestionResponse should delegate to askUserQuestionHandler', async () => {
			const handleQuestionResponseSpy = mock(async () => {});
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).askUserQuestionHandler = {
				handleQuestionResponse: handleQuestionResponseSpy,
			};

			await agentSession.handleQuestionResponse('tool-123', []);

			expect(handleQuestionResponseSpy).toHaveBeenCalledWith('tool-123', []);
		});

		it('updateQuestionDraft should delegate to askUserQuestionHandler', async () => {
			const updateQuestionDraftSpy = mock(async () => {});
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).askUserQuestionHandler = {
				updateQuestionDraft: updateQuestionDraftSpy,
			};

			await agentSession.updateQuestionDraft([]);

			expect(updateQuestionDraftSpy).toHaveBeenCalledWith([]);
		});

		it('handleQuestionCancel should delegate to askUserQuestionHandler', async () => {
			const handleQuestionCancelSpy = mock(async () => {});
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).askUserQuestionHandler = {
				handleQuestionCancel: handleQuestionCancelSpy,
			};

			await agentSession.handleQuestionCancel('tool-456');

			expect(handleQuestionCancelSpy).toHaveBeenCalledWith('tool-456');
		});

		it('handleInterrupt should delegate to interruptHandler', async () => {
			const handleInterruptSpy = mock(async () => {});
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).interruptHandler = {
				handleInterrupt: handleInterruptSpy,
			};

			await agentSession.handleInterrupt();

			expect(handleInterruptSpy).toHaveBeenCalled();
		});

		it('resetQuery should delegate to lifecycleManager', async () => {
			const resetSpy = mock(async () => ({ success: true }));
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).lifecycleManager = {
				reset: resetSpy,
			};

			const result = await agentSession.resetQuery({ restartQuery: true });

			expect(resetSpy).toHaveBeenCalledWith({ restartAfter: true });
			expect(result).toEqual({ success: true });
		});

		it('updateConfig should delegate to sessionConfigHandler', async () => {
			const updateConfigSpy = mock(async () => {});
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).sessionConfigHandler = {
				updateConfig: updateConfigSpy,
			};

			await agentSession.updateConfig({ maxTokens: 4096 });

			expect(updateConfigSpy).toHaveBeenCalledWith({ maxTokens: 4096 });
		});

		it('updateMetadata should delegate to sessionConfigHandler', () => {
			const updateMetadataSpy = mock(() => {});
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).sessionConfigHandler = {
				updateMetadata: updateMetadataSpy,
			};

			agentSession.updateMetadata({ title: 'New Title' });

			expect(updateMetadataSpy).toHaveBeenCalledWith({ title: 'New Title' });
		});

		it('getRewindPoints should delegate to rewindHandler', () => {
			const mockPoints = [{ id: 'cp1', messageId: 'msg1', timestamp: Date.now() }];
			const getRewindPointsSpy = mock(() => mockPoints);
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).rewindHandler = {
				getRewindPoints: getRewindPointsSpy,
			};

			const result = agentSession.getRewindPoints();

			expect(getRewindPointsSpy).toHaveBeenCalled();
			expect(result).toEqual(mockPoints);
		});

		it('previewRewind should delegate to rewindHandler', async () => {
			const mockPreview = { messagesToDelete: [], filesToRevert: [] };
			const previewRewindSpy = mock(async () => mockPreview);
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).rewindHandler = {
				previewRewind: previewRewindSpy,
			};

			const result = await agentSession.previewRewind('cp-123');

			expect(previewRewindSpy).toHaveBeenCalledWith('cp-123');
			expect(result).toEqual(mockPreview);
		});

		it('executeRewind should delegate to rewindHandler', async () => {
			const mockResult = { success: true, messagesDeleted: 5, filesReverted: [] };
			const executeRewindSpy = mock(async () => mockResult);
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).rewindHandler = {
				executeRewind: executeRewindSpy,
			};

			const result = await agentSession.executeRewind('cp-456', 'conversation');

			expect(executeRewindSpy).toHaveBeenCalledWith('cp-456', 'conversation');
			expect(result).toEqual(mockResult);
		});

		it('previewSelectiveRewind should delegate to rewindHandler', async () => {
			const mockPreview = { messagesToDelete: [], filesToRevert: [] };
			const previewSelectiveRewindSpy = mock(async () => mockPreview);
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).rewindHandler = {
				previewSelectiveRewind: previewSelectiveRewindSpy,
			};

			const result = await agentSession.previewSelectiveRewind(['msg1', 'msg2']);

			expect(previewSelectiveRewindSpy).toHaveBeenCalledWith(['msg1', 'msg2']);
			expect(result).toEqual(mockPreview);
		});

		it('setMaxThinkingTokens should delegate to sdkRuntimeConfig', async () => {
			const mockResult = { success: true };
			const setMaxThinkingTokensSpy = mock(async () => mockResult);
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).sdkRuntimeConfig = {
				setMaxThinkingTokens: setMaxThinkingTokensSpy,
			};

			const result = await agentSession.setMaxThinkingTokens(1000);

			expect(setMaxThinkingTokensSpy).toHaveBeenCalledWith(1000);
			expect(result).toEqual(mockResult);
		});

		it('setPermissionMode should delegate to sdkRuntimeConfig', async () => {
			const mockResult = { success: true };
			const setPermissionModeSpy = mock(async () => mockResult);
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).sdkRuntimeConfig = {
				setPermissionMode: setPermissionModeSpy,
			};

			const result = await agentSession.setPermissionMode('auto');

			expect(setPermissionModeSpy).toHaveBeenCalledWith('auto');
			expect(result).toEqual(mockResult);
		});

		it('getMcpServerStatus should delegate to sdkRuntimeConfig', async () => {
			const mockStatus = [{ name: 'server1', status: 'connected' }];
			const getMcpServerStatusSpy = mock(async () => mockStatus);
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).sdkRuntimeConfig = {
				getMcpServerStatus: getMcpServerStatusSpy,
			};

			const result = await agentSession.getMcpServerStatus();

			expect(getMcpServerStatusSpy).toHaveBeenCalled();
			expect(result).toEqual(mockStatus);
		});

		it('updateToolsConfig should delegate to sdkRuntimeConfig', async () => {
			const mockResult = { success: true };
			const updateToolsConfigSpy = mock(async () => mockResult);
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).sdkRuntimeConfig = {
				updateToolsConfig: updateToolsConfigSpy,
			};

			const result = await agentSession.updateToolsConfig({ allowedTools: ['tool1'] });

			expect(updateToolsConfigSpy).toHaveBeenCalledWith({ allowedTools: ['tool1'] });
			expect(result).toEqual(mockResult);
		});

		it('handleQueryTrigger should delegate to queryModeHandler', async () => {
			const mockResult = { success: true, messageCount: 1 };
			const handleQueryTriggerSpy = mock(async () => mockResult);
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).queryModeHandler = {
				handleQueryTrigger: handleQueryTriggerSpy,
			};

			const result = await agentSession.handleQueryTrigger();

			expect(handleQueryTriggerSpy).toHaveBeenCalled();
			expect(result).toEqual(mockResult);
		});

		it('cleanup should delegate to lifecycleManager', async () => {
			const cleanupSpy = mock(async () => {});
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).lifecycleManager = {
				cleanup: cleanupSpy,
			};

			await agentSession.cleanup();

			expect(cleanupSpy).toHaveBeenCalled();
		});
	});

	describe('query generation tracking', () => {
		let mockSession: Session;
		let mockDb: Database;
		let mockMessageHub: MessageHub;
		let mockDaemonHub: DaemonHub;
		let mockGetApiKey: () => Promise<string | null>;
		let agentSession: AgentSession;

		beforeEach(() => {
			mockSession = {
				id: 'test-session-id',
				title: 'Test Session',
				workspacePath: '/test/workspace',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-20250514',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			} as Session;

			mockDb = {
				getSession: mock(() => mockSession),
				updateSession: mock(() => {}),
			} as unknown as Database;

			mockMessageHub = {} as unknown as MessageHub;

			mockDaemonHub = {
				emit: mock(async () => {}),
				on: mock(() => mock(() => {})),
			} as unknown as DaemonHub;

			mockGetApiKey = mock(async () => 'test-api-key');

			agentSession = new AgentSession(
				mockSession,
				mockDb,
				mockMessageHub,
				mockDaemonHub,
				mockGetApiKey
			);
		});

		it('should start with generation 0', () => {
			expect(agentSession.getQueryGeneration()).toBe(0);
		});

		it('incrementQueryGeneration should increment and return new value', () => {
			const gen1 = agentSession.incrementQueryGeneration();
			expect(gen1).toBe(1);
			expect(agentSession.getQueryGeneration()).toBe(1);

			const gen2 = agentSession.incrementQueryGeneration();
			expect(gen2).toBe(2);
			expect(agentSession.getQueryGeneration()).toBe(2);
		});

		it('setCleaningUp should update cleaning up state', () => {
			expect(agentSession.isCleaningUp()).toBe(false);

			agentSession.setCleaningUp(true);
			expect(agentSession.isCleaningUp()).toBe(true);

			agentSession.setCleaningUp(false);
			expect(agentSession.isCleaningUp()).toBe(false);
		});
	});

	describe('executeSelectiveRewind', () => {
		let mockSession: Session;
		let mockDb: Database;
		let mockMessageHub: MessageHub;
		let mockDaemonHub: DaemonHub;
		let mockGetApiKey: () => Promise<string | null>;
		let agentSession: AgentSession;

		beforeEach(() => {
			// Create minimal mock session
			mockSession = {
				id: 'test-session-id',
				title: 'Test Session',
				workspacePath: '/test/workspace',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-20250514',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			} as Session;

			// Create minimal mock database
			mockDb = {
				getSession: mock(() => mockSession),
				updateSession: mock(() => {}),
				getUserMessages: mock(() => []),
				getSDKMessages: mock(() => ({ messages: [], hasMore: false })),
				deleteMessagesAfter: mock(() => 0),
				deleteMessagesAtAndAfter: mock(() => 0),
				getUserMessageByUuid: mock(() => undefined),
				countMessagesAfter: mock(() => 0),
				getMessagesByStatus: mock(() => []),
				updateMessage: mock(() => {}),
			} as unknown as Database;

			// Create minimal mock message hub
			mockMessageHub = {
				sendMessage: mock(() => {}),
			} as unknown as MessageHub;

			// Create minimal mock daemon hub
			mockDaemonHub = {
				emit: mock(async () => {}),
				on: mock(() => mock(() => {})), // Returns unsubscribe function
			} as unknown as DaemonHub;

			// Create mock API key getter
			mockGetApiKey = mock(async () => 'test-api-key');

			// Create AgentSession instance
			agentSession = new AgentSession(
				mockSession,
				mockDb,
				mockMessageHub,
				mockDaemonHub,
				mockGetApiKey
			);
		});

		it('should delegate to rewindHandler.executeSelectiveRewind with messageIds and mode', async () => {
			const messageIds = ['msg-1', 'msg-2'];
			const mode: RewindMode = 'both';
			const expectedResult: SelectiveRewindResult = {
				success: true,
				messagesDeleted: 2,
				filesReverted: ['file1.ts', 'file2.ts'],
				rewindCase: 'sdk-native',
			};

			// Mock the rewindHandler's executeSelectiveRewind method
			const executeSelectiveRewindSpy = mock(() => Promise.resolve(expectedResult));
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).rewindHandler = {
				executeSelectiveRewind: executeSelectiveRewindSpy,
			};

			// Call the method
			const result = await agentSession.executeSelectiveRewind(messageIds, mode);

			// Verify the handler was called with correct arguments
			expect(executeSelectiveRewindSpy).toHaveBeenCalledTimes(1);
			expect(executeSelectiveRewindSpy).toHaveBeenCalledWith(messageIds, mode);
			expect(result).toEqual(expectedResult);
		});

		it('should delegate to rewindHandler.executeSelectiveRewind without mode parameter', async () => {
			const messageIds = ['msg-1', 'msg-2'];
			const expectedResult: SelectiveRewindResult = {
				success: true,
				messagesDeleted: 2,
				filesReverted: ['file1.ts'],
				rewindCase: 'diff-based',
			};

			// Mock the rewindHandler's executeSelectiveRewind method
			const executeSelectiveRewindSpy = mock(() => Promise.resolve(expectedResult));
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).rewindHandler = {
				executeSelectiveRewind: executeSelectiveRewindSpy,
			};

			// Call the method without mode parameter
			const result = await agentSession.executeSelectiveRewind(messageIds);

			// Verify the handler was called with correct arguments (mode should be undefined)
			expect(executeSelectiveRewindSpy).toHaveBeenCalledTimes(1);
			expect(executeSelectiveRewindSpy).toHaveBeenCalledWith(messageIds, undefined);
			expect(result).toEqual(expectedResult);
		});

		it('should handle different rewind modes', async () => {
			const messageIds = ['msg-1'];
			const modes: RewindMode[] = ['files', 'conversation', 'both'];

			for (const mode of modes) {
				const expectedResult: SelectiveRewindResult = {
					success: true,
					messagesDeleted: 1,
					filesReverted: [],
				};

				const executeSelectiveRewindSpy = mock(() => Promise.resolve(expectedResult));
				// biome-ignore lint: test mock access
				(agentSession as unknown as Record<string, unknown>).rewindHandler = {
					executeSelectiveRewind: executeSelectiveRewindSpy,
				};

				await agentSession.executeSelectiveRewind(messageIds, mode);

				expect(executeSelectiveRewindSpy).toHaveBeenCalledWith(messageIds, mode);
			}
		});
	});

	describe('startStreamingQuery', () => {
		let mockSession: Session;
		let mockDb: Database;
		let mockMessageHub: MessageHub;
		let mockDaemonHub: DaemonHub;
		let mockGetApiKey: () => Promise<string | null>;
		let agentSession: AgentSession;

		beforeEach(() => {
			mockSession = {
				id: 'test-session-id',
				title: 'Test Session',
				workspacePath: '/test/workspace',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-20250514',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			} as Session;

			mockDb = {
				getSession: mock(() => mockSession),
				updateSession: mock(() => {}),
			} as unknown as Database;

			mockMessageHub = {} as unknown as MessageHub;

			mockDaemonHub = {
				emit: mock(async () => {}),
				on: mock(() => mock(() => {})),
			} as unknown as DaemonHub;

			mockGetApiKey = mock(async () => 'test-api-key');

			agentSession = new AgentSession(
				mockSession,
				mockDb,
				mockMessageHub,
				mockDaemonHub,
				mockGetApiKey
			);
		});

		it('should delegate to queryRunner.start', async () => {
			const startSpy = mock(async () => {});
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).queryRunner = {
				start: startSpy,
			};

			await agentSession.startStreamingQuery();

			expect(startSpy).toHaveBeenCalled();
		});
	});

	describe('ensureQueryStarted', () => {
		let mockSession: Session;
		let mockDb: Database;
		let mockMessageHub: MessageHub;
		let mockDaemonHub: DaemonHub;
		let mockGetApiKey: () => Promise<string | null>;
		let agentSession: AgentSession;

		beforeEach(() => {
			mockSession = {
				id: 'test-session-id',
				title: 'Test Session',
				workspacePath: '/test/workspace',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-20250514',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			} as Session;

			mockDb = {
				getSession: mock(() => mockSession),
				updateSession: mock(() => {}),
			} as unknown as Database;

			mockMessageHub = {} as unknown as MessageHub;

			mockDaemonHub = {
				emit: mock(async () => {}),
				on: mock(() => mock(() => {})),
			} as unknown as DaemonHub;

			mockGetApiKey = mock(async () => 'test-api-key');

			agentSession = new AgentSession(
				mockSession,
				mockDb,
				mockMessageHub,
				mockDaemonHub,
				mockGetApiKey
			);
		});

		it('should delegate to lifecycleManager.ensureQueryStarted', async () => {
			const ensureQueryStartedSpy = mock(async () => {});
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).lifecycleManager = {
				ensureQueryStarted: ensureQueryStartedSpy,
			};

			await agentSession.ensureQueryStarted();

			expect(ensureQueryStartedSpy).toHaveBeenCalled();
		});
	});

	describe('startQueryAndEnqueue', () => {
		let mockSession: Session;
		let mockDb: Database;
		let mockMessageHub: MessageHub;
		let mockDaemonHub: DaemonHub;
		let mockGetApiKey: () => Promise<string | null>;
		let agentSession: AgentSession;

		beforeEach(() => {
			mockSession = {
				id: 'test-session-id',
				title: 'Test Session',
				workspacePath: '/test/workspace',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-20250514',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			} as Session;

			mockDb = {
				getSession: mock(() => mockSession),
				updateSession: mock(() => {}),
			} as unknown as Database;

			mockMessageHub = {} as unknown as MessageHub;

			mockDaemonHub = {
				emit: mock(async () => {}),
				on: mock(() => mock(() => {})),
			} as unknown as DaemonHub;

			mockGetApiKey = mock(async () => 'test-api-key');

			agentSession = new AgentSession(
				mockSession,
				mockDb,
				mockMessageHub,
				mockDaemonHub,
				mockGetApiKey
			);
		});

		it('should delegate to lifecycleManager.startQueryAndEnqueue', async () => {
			const startQueryAndEnqueueSpy = mock(async () => {});
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).lifecycleManager = {
				startQueryAndEnqueue: startQueryAndEnqueueSpy,
			};

			await agentSession.startQueryAndEnqueue('msg-id', 'test content');

			expect(startQueryAndEnqueueSpy).toHaveBeenCalledWith('msg-id', 'test content');
		});

		it('should handle MessageContent array', async () => {
			const startQueryAndEnqueueSpy = mock(async () => {});
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).lifecycleManager = {
				startQueryAndEnqueue: startQueryAndEnqueueSpy,
			};

			const content = [{ type: 'text', text: 'hello' }];
			await agentSession.startQueryAndEnqueue('msg-id', content);

			expect(startQueryAndEnqueueSpy).toHaveBeenCalledWith('msg-id', content);
		});
	});

	describe('restartQuery', () => {
		let mockSession: Session;
		let mockDb: Database;
		let mockMessageHub: MessageHub;
		let mockDaemonHub: DaemonHub;
		let mockGetApiKey: () => Promise<string | null>;
		let agentSession: AgentSession;

		beforeEach(() => {
			mockSession = {
				id: 'test-session-id',
				title: 'Test Session',
				workspacePath: '/test/workspace',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-20250514',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			} as Session;

			mockDb = {
				getSession: mock(() => mockSession),
				updateSession: mock(() => {}),
			} as unknown as Database;

			mockMessageHub = {} as unknown as MessageHub;

			mockDaemonHub = {
				emit: mock(async () => {}),
				on: mock(() => mock(() => {})),
			} as unknown as DaemonHub;

			mockGetApiKey = mock(async () => 'test-api-key');

			agentSession = new AgentSession(
				mockSession,
				mockDb,
				mockMessageHub,
				mockDaemonHub,
				mockGetApiKey
			);
		});

		it('should delegate to lifecycleManager.restartQuery', async () => {
			const restartQuerySpy = mock(async () => {});
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).lifecycleManager = {
				restartQuery: restartQuerySpy,
			};

			await agentSession.restartQuery();

			expect(restartQuerySpy).toHaveBeenCalled();
		});
	});

	describe('onSDKMessage', () => {
		let mockSession: Session;
		let mockDb: Database;
		let mockMessageHub: MessageHub;
		let mockDaemonHub: DaemonHub;
		let mockGetApiKey: () => Promise<string | null>;
		let agentSession: AgentSession;

		beforeEach(() => {
			mockSession = {
				id: 'test-session-id',
				title: 'Test Session',
				workspacePath: '/test/workspace',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-20250514',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			} as Session;

			mockDb = {
				getSession: mock(() => mockSession),
				updateSession: mock(() => {}),
			} as unknown as Database;

			mockMessageHub = {} as unknown as MessageHub;

			mockDaemonHub = {
				emit: mock(async () => {}),
				on: mock(() => mock(() => {})),
			} as unknown as DaemonHub;

			mockGetApiKey = mock(async () => 'test-api-key');

			agentSession = new AgentSession(
				mockSession,
				mockDb,
				mockMessageHub,
				mockDaemonHub,
				mockGetApiKey
			);
		});

		it('should delegate to messageHandler.handleMessage', async () => {
			const handleMessageSpy = mock(async () => {});
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).messageHandler = {
				handleMessage: handleMessageSpy,
			};

			const message = { type: 'assistant', message: { content: [] } };
			await agentSession.onSDKMessage(message as never);

			expect(handleMessageSpy).toHaveBeenCalledWith(message);
		});
	});

	describe('onSlashCommandsFetched', () => {
		let mockSession: Session;
		let mockDb: Database;
		let mockMessageHub: MessageHub;
		let mockDaemonHub: DaemonHub;
		let mockGetApiKey: () => Promise<string | null>;
		let agentSession: AgentSession;

		beforeEach(() => {
			mockSession = {
				id: 'test-session-id',
				title: 'Test Session',
				workspacePath: '/test/workspace',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-20250514',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			} as Session;

			mockDb = {
				getSession: mock(() => mockSession),
				updateSession: mock(() => {}),
			} as unknown as Database;

			mockMessageHub = {} as unknown as MessageHub;

			mockDaemonHub = {
				emit: mock(async () => {}),
				on: mock(() => mock(() => {})),
			} as unknown as DaemonHub;

			mockGetApiKey = mock(async () => 'test-api-key');

			agentSession = new AgentSession(
				mockSession,
				mockDb,
				mockMessageHub,
				mockDaemonHub,
				mockGetApiKey
			);
		});

		it('should delegate to slashCommandManager.fetchAndCache', async () => {
			const fetchAndCacheSpy = mock(async () => {});
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).slashCommandManager = {
				fetchAndCache: fetchAndCacheSpy,
			};

			await agentSession.onSlashCommandsFetched();

			expect(fetchAndCacheSpy).toHaveBeenCalled();
		});
	});

	describe('onMarkApiSuccess', () => {
		let mockSession: Session;
		let mockDb: Database;
		let mockMessageHub: MessageHub;
		let mockDaemonHub: DaemonHub;
		let mockGetApiKey: () => Promise<string | null>;
		let agentSession: AgentSession;

		beforeEach(() => {
			mockSession = {
				id: 'test-session-id',
				title: 'Test Session',
				workspacePath: '/test/workspace',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-20250514',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			} as Session;

			mockDb = {
				getSession: mock(() => mockSession),
				updateSession: mock(() => {}),
			} as unknown as Database;

			mockMessageHub = {} as unknown as MessageHub;

			mockDaemonHub = {
				emit: mock(async () => {}),
				on: mock(() => mock(() => {})),
			} as unknown as DaemonHub;

			mockGetApiKey = mock(async () => 'test-api-key');

			agentSession = new AgentSession(
				mockSession,
				mockDb,
				mockMessageHub,
				mockDaemonHub,
				mockGetApiKey
			);
		});

		it('should call errorManager.markApiSuccess', async () => {
			const markApiSuccessSpy = mock(() => {});
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).errorManager = {
				markApiSuccess: markApiSuccessSpy,
			};

			await agentSession.onMarkApiSuccess();

			expect(markApiSuccessSpy).toHaveBeenCalled();
		});
	});

	describe('getSlashCommands', () => {
		let mockSession: Session;
		let mockDb: Database;
		let mockMessageHub: MessageHub;
		let mockDaemonHub: DaemonHub;
		let mockGetApiKey: () => Promise<string | null>;
		let agentSession: AgentSession;

		beforeEach(() => {
			mockSession = {
				id: 'test-session-id',
				title: 'Test Session',
				workspacePath: '/test/workspace',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-20250514',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			} as Session;

			mockDb = {
				getSession: mock(() => mockSession),
				updateSession: mock(() => {}),
			} as unknown as Database;

			mockMessageHub = {} as unknown as MessageHub;

			mockDaemonHub = {
				emit: mock(async () => {}),
				on: mock(() => mock(() => {})),
			} as unknown as DaemonHub;

			mockGetApiKey = mock(async () => 'test-api-key');

			agentSession = new AgentSession(
				mockSession,
				mockDb,
				mockMessageHub,
				mockDaemonHub,
				mockGetApiKey
			);
		});

		it('should delegate to slashCommandManager.getSlashCommands', async () => {
			const mockCommands = ['/test', '/help'];
			const getSlashCommandsSpy = mock(async () => mockCommands);
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).slashCommandManager = {
				getSlashCommands: getSlashCommandsSpy,
			};

			const result = await agentSession.getSlashCommands();

			expect(getSlashCommandsSpy).toHaveBeenCalled();
			expect(result).toEqual(mockCommands);
		});
	});

	describe('cleanupEventSubscriptions', () => {
		let mockSession: Session;
		let mockDb: Database;
		let mockMessageHub: MessageHub;
		let mockDaemonHub: DaemonHub;
		let mockGetApiKey: () => Promise<string | null>;
		let agentSession: AgentSession;

		beforeEach(() => {
			mockSession = {
				id: 'test-session-id',
				title: 'Test Session',
				workspacePath: '/test/workspace',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-20250514',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			} as Session;

			mockDb = {
				getSession: mock(() => mockSession),
				updateSession: mock(() => {}),
			} as unknown as Database;

			mockMessageHub = {} as unknown as MessageHub;

			mockDaemonHub = {
				emit: mock(async () => {}),
				on: mock(() => mock(() => {})),
			} as unknown as DaemonHub;

			mockGetApiKey = mock(async () => 'test-api-key');

			agentSession = new AgentSession(
				mockSession,
				mockDb,
				mockMessageHub,
				mockDaemonHub,
				mockGetApiKey
			);
		});

		it('should delegate to eventSubscriptionSetup.cleanup', () => {
			const cleanupSpy = mock(() => {});
			// biome-ignore lint: test mock access
			(agentSession as unknown as Record<string, unknown>).eventSubscriptionSetup = {
				cleanup: cleanupSpy,
			};

			agentSession.cleanupEventSubscriptions();

			expect(cleanupSpy).toHaveBeenCalled();
		});
	});

	describe('pendingRestartReason', () => {
		let mockSession: Session;
		let mockDb: Database;
		let mockMessageHub: MessageHub;
		let mockDaemonHub: DaemonHub;
		let mockGetApiKey: () => Promise<string | null>;
		let agentSession: AgentSession;

		beforeEach(() => {
			mockSession = {
				id: 'test-session-id',
				title: 'Test Session',
				workspacePath: '/test/workspace',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-20250514',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			} as Session;

			mockDb = {
				getSession: mock(() => mockSession),
				updateSession: mock(() => {}),
			} as unknown as Database;

			mockMessageHub = {} as unknown as MessageHub;

			mockDaemonHub = {
				emit: mock(async () => {}),
				on: mock(() => mock(() => {})),
			} as unknown as DaemonHub;

			mockGetApiKey = mock(async () => 'test-api-key');

			agentSession = new AgentSession(
				mockSession,
				mockDb,
				mockMessageHub,
				mockDaemonHub,
				mockGetApiKey
			);
		});

		it('should initialize with null pendingRestartReason', () => {
			expect(agentSession.pendingRestartReason).toBeNull();
		});

		it('should allow setting pendingRestartReason', () => {
			agentSession.pendingRestartReason = 'settings.local.json';
			expect(agentSession.pendingRestartReason).toBe('settings.local.json');

			agentSession.pendingRestartReason = null;
			expect(agentSession.pendingRestartReason).toBeNull();
		});
	});

	describe('originalEnvVars', () => {
		let mockSession: Session;
		let mockDb: Database;
		let mockMessageHub: MessageHub;
		let mockDaemonHub: DaemonHub;
		let mockGetApiKey: () => Promise<string | null>;
		let agentSession: AgentSession;

		beforeEach(() => {
			mockSession = {
				id: 'test-session-id',
				title: 'Test Session',
				workspacePath: '/test/workspace',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-20250514',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			} as Session;

			mockDb = {
				getSession: mock(() => mockSession),
				updateSession: mock(() => {}),
			} as unknown as Database;

			mockMessageHub = {} as unknown as MessageHub;

			mockDaemonHub = {
				emit: mock(async () => {}),
				on: mock(() => mock(() => {})),
			} as unknown as DaemonHub;

			mockGetApiKey = mock(async () => 'test-api-key');

			agentSession = new AgentSession(
				mockSession,
				mockDb,
				mockMessageHub,
				mockDaemonHub,
				mockGetApiKey
			);
		});

		it('should initialize with empty originalEnvVars', () => {
			expect(agentSession.originalEnvVars).toEqual({});
		});

		it('should allow storing and retrieving env vars', () => {
			agentSession.originalEnvVars = { ANTHROPIC_API_KEY: 'old-key' };
			expect(agentSession.originalEnvVars).toEqual({ ANTHROPIC_API_KEY: 'old-key' });
		});
	});

	describe('createSessionFromInit', () => {
		it('should create a session without mcpServers in config to avoid cyclic serialization errors', () => {
			// Simulate what createSdkMcpServer returns - an object with a non-serializable instance
			const mockMcpServer = {
				type: 'sdk' as const,
				name: 'lobby-agent-tools',
				// This instance property contains cyclic references
				instance: {
					connect: () => {},
					// Create a cyclic reference
					self: null as unknown,
				},
			};
			mockMcpServer.instance.self = mockMcpServer.instance;

			const init = {
				sessionId: 'lobby:default',
				workspacePath: '/test/workspace',
				systemPrompt: 'Test system prompt',
				mcpServers: {
					'lobby-agent-tools': mockMcpServer,
				},
				features: {
					rewind: false,
					worktree: false,
					coordinator: false,
					archive: false,
					sessionInfo: false,
				},
				context: { lobbyId: 'default' },
				type: 'lobby' as const,
				model: 'claude-sonnet-4-5-20250929',
			};

			const session = AgentSession.createSessionFromInit(init, 'claude-sonnet-4-5-20250929');

			// Verify the session was created
			expect(session.id).toBe('lobby:default');
			expect(session.type).toBe('lobby');
			expect(session.config.model).toBe('claude-sonnet-4-5-20250929');

			// Most importantly, mcpServers should NOT be in the persisted config
			// because it contains non-serializable objects
			expect(session.config.mcpServers).toBeUndefined();

			// The config should be JSON-serializable without errors
			expect(() => JSON.stringify(session.config)).not.toThrow();

			// Verify the serialized JSON doesn't contain mcpServers
			const serialized = JSON.stringify(session.config);
			expect(serialized).not.toContain('mcpServers');
		});

		it('should create a room session with serializable config', () => {
			const init = {
				sessionId: 'room:test-room',
				workspacePath: '/test/workspace',
				systemPrompt: 'Room system prompt',
				mcpServers: {
					'room-agent-tools': {
						type: 'sdk' as const,
						name: 'room-agent-tools',
						instance: { cyclic: null as unknown },
					},
				},
				features: {
					rewind: false,
					worktree: false,
					coordinator: false,
					archive: false,
					sessionInfo: false,
				},
				context: { roomId: 'test-room' },
				type: 'room' as const,
				model: 'claude-sonnet-4-5-20250929',
			};
			init.mcpServers!['room-agent-tools'].instance.cyclic =
				init.mcpServers!['room-agent-tools'].instance;

			const session = AgentSession.createSessionFromInit(init, 'claude-sonnet-4-5-20250929');

			expect(session.id).toBe('room:test-room');
			expect(session.type).toBe('room');
			expect(session.context?.roomId).toBe('test-room');

			// Config should not contain mcpServers
			expect(session.config.mcpServers).toBeUndefined();

			// Should be serializable
			expect(() => JSON.stringify(session.config)).not.toThrow();
		});

		it('should preserve other config fields like systemPrompt and features', () => {
			const init = {
				sessionId: 'test-session',
				workspacePath: '/test/workspace',
				systemPrompt: 'Custom system prompt',
				features: {
					rewind: true,
					worktree: true,
					coordinator: false,
					archive: false,
					sessionInfo: true,
				},
				type: 'room' as const,
				model: 'claude-opus-4-20250514',
			};

			const session = AgentSession.createSessionFromInit(init, 'claude-sonnet-4-5-20250929');

			expect(session.config.systemPrompt).toBe('Custom system prompt');
			expect(session.config.features).toEqual({
				rewind: true,
				worktree: true,
				coordinator: false,
				archive: false,
				sessionInfo: true,
			});
			expect(session.config.model).toBe('claude-opus-4-20250514');
		});
	});

	describe('fromInit', () => {
		it('should merge mcpServers into session config at runtime for query options builder', () => {
			// Create a mock cyclic MCP server instance
			const mockMcpServer = {
				type: 'sdk' as const,
				name: 'test-tools',
				instance: { self: null as unknown },
			};
			mockMcpServer.instance.self = mockMcpServer.instance;

			const init = {
				sessionId: 'test:runtime',
				workspacePath: '/test/workspace',
				mcpServers: {
					'test-tools': mockMcpServer,
				},
				type: 'lobby' as const,
				model: 'claude-sonnet-4-5-20250929',
			};

			// Create a mock database that returns null for getSession (new session)
			const mockDb = {
				getSession: mock(() => null),
				createSession: mock(() => {}),
				updateSession: mock(() => {}),
				getMessagesByStatus: mock(() => []),
			} as unknown as Database;

			const mockMessageHub = {} as MessageHub;
			const mockDaemonHub = {
				emit: mock(async () => {}),
				on: mock(() => mock(() => {})),
			} as unknown as DaemonHub;
			const mockGetApiKey = mock(async () => 'test-key');

			const agentSession = AgentSession.fromInit(
				init,
				mockDb,
				mockMessageHub,
				mockDaemonHub,
				mockGetApiKey,
				'claude-sonnet-4-5-20250929'
			);

			// The runtime session should have mcpServers available for query options builder
			const sessionData = agentSession.getSessionData();
			expect(sessionData.config.mcpServers).toBeDefined();
			expect(sessionData.config.mcpServers!['test-tools']).toEqual(mockMcpServer);

			// The database should have been called with a session that has NO mcpServers
			// (because we don't persist non-serializable objects)
			const createSessionCall = (mockDb as unknown as { createSession: ReturnType<typeof mock> })
				.createSession.mock.calls[0];
			const persistedSession = createSessionCall[0] as Session;
			expect(persistedSession.config.mcpServers).toBeUndefined();
		});

		it('should update workspacePath for existing init sessions', () => {
			const existingSession = {
				id: 'room:test',
				title: 'Room Agent',
				workspacePath: '/old/workspace',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active' as const,
				config: {
					model: 'default',
					maxTokens: 8192,
					temperature: 1,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
				type: 'room' as const,
				context: { roomId: 'test' },
			} as Session;

			const init = {
				sessionId: 'room:test',
				workspacePath: '/new/workspace',
				type: 'room' as const,
				model: 'default',
			};

			const mockDb = {
				getSession: mock(() => existingSession),
				createSession: mock(() => {}),
				updateSession: mock(() => {}),
				getMessagesByStatus: mock(() => []),
			} as unknown as Database;

			const mockMessageHub = {} as MessageHub;
			const mockDaemonHub = {
				emit: mock(async () => {}),
				on: mock(() => mock(() => {})),
			} as unknown as DaemonHub;
			const mockGetApiKey = mock(async () => 'test-key');

			const agentSession = AgentSession.fromInit(
				init,
				mockDb,
				mockMessageHub,
				mockDaemonHub,
				mockGetApiKey,
				'default'
			);

			expect(
				(mockDb as unknown as { updateSession: ReturnType<typeof mock> }).updateSession.mock
					.calls[0]
			).toEqual(['room:test', { workspacePath: '/new/workspace' }]);
			expect(agentSession.getSessionData().workspacePath).toBe('/new/workspace');
		});

		it('should clear stale worktree when loading existing room session', () => {
			const existingSession = {
				id: 'room:test',
				title: 'Room Agent',
				workspacePath: '/old/workspace',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active' as const,
				config: {
					model: 'default',
					maxTokens: 8192,
					temperature: 1,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
				type: 'worker' as const,
				worktree: {
					isWorktree: true,
					worktreePath: '/stale/worktree',
					mainRepoPath: '/stale/repo',
					branch: 'session/stale',
				},
			} as Session;

			const init = {
				sessionId: 'room:test',
				workspacePath: '/new/workspace',
				type: 'room' as const,
				context: { roomId: 'test' },
				model: 'default',
			};

			const mockDb = {
				getSession: mock(() => existingSession),
				createSession: mock(() => {}),
				updateSession: mock(() => {}),
				getMessagesByStatus: mock(() => []),
			} as unknown as Database;

			const mockMessageHub = {} as MessageHub;
			const mockDaemonHub = {
				emit: mock(async () => {}),
				on: mock(() => mock(() => {})),
			} as unknown as DaemonHub;
			const mockGetApiKey = mock(async () => 'test-key');

			const agentSession = AgentSession.fromInit(
				init,
				mockDb,
				mockMessageHub,
				mockDaemonHub,
				mockGetApiKey,
				'default'
			);

			expect(
				(mockDb as unknown as { updateSession: ReturnType<typeof mock> }).updateSession.mock
					.calls[0]
			).toEqual([
				'room:test',
				{
					workspacePath: '/new/workspace',
					type: 'room',
					context: { roomId: 'test' },
					worktree: undefined,
				},
			]);
			expect(agentSession.getSessionData().worktree).toBeUndefined();
			expect(agentSession.getSessionData().workspacePath).toBe('/new/workspace');
			expect(agentSession.getSessionData().type).toBe('room');
		});
	});

	describe('startupTimeoutTimer', () => {
		let mockSession: Session;
		let mockDb: Database;
		let mockMessageHub: MessageHub;
		let mockDaemonHub: DaemonHub;
		let mockGetApiKey: () => Promise<string | null>;
		let agentSession: AgentSession;

		beforeEach(() => {
			mockSession = {
				id: 'test-session-id',
				title: 'Test Session',
				workspacePath: '/test/workspace',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: {
					model: 'claude-sonnet-4-20250514',
					maxTokens: 8192,
					temperature: 1.0,
				},
				metadata: {
					messageCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					toolCallCount: 0,
				},
			} as Session;

			mockDb = {
				getSession: mock(() => mockSession),
				updateSession: mock(() => {}),
			} as unknown as Database;

			mockMessageHub = {} as unknown as MessageHub;

			mockDaemonHub = {
				emit: mock(async () => {}),
				on: mock(() => mock(() => {})),
			} as unknown as DaemonHub;

			mockGetApiKey = mock(async () => 'test-api-key');

			agentSession = new AgentSession(
				mockSession,
				mockDb,
				mockMessageHub,
				mockDaemonHub,
				mockGetApiKey
			);
		});

		it('should initialize with null startupTimeoutTimer', () => {
			expect(agentSession.startupTimeoutTimer).toBeNull();
		});

		it('should allow setting and clearing timeout', () => {
			const timer = setTimeout(() => {}, 1000);
			agentSession.startupTimeoutTimer = timer;
			expect(agentSession.startupTimeoutTimer).toBe(timer);

			clearTimeout(timer);
			agentSession.startupTimeoutTimer = null;
			expect(agentSession.startupTimeoutTimer).toBeNull();
		});
	});
});
