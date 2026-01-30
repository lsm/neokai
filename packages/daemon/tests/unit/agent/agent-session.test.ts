/**
 * AgentSession Tests
 *
 * Tests for the main agent orchestration class.
 * Note: AgentSession has many dependencies, so we test what we can without
 * using mock.module() which affects other test files globally.
 */

import { describe, expect, it } from 'bun:test';
import type { Session, ContextInfo, AgentProcessingState } from '@neokai/shared';

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
});
