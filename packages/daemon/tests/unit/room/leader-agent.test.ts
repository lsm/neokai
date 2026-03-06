import { describe, expect, it } from 'bun:test';
import {
	buildLeaderSystemPrompt,
	buildLeaderTaskContext,
	buildReviewerAgents,
	createLeaderToolHandlers,
	createLeaderAgentInit,
	toAgentModel,
	type LeaderAgentConfig,
	type LeaderToolCallbacks,
} from '../../../src/lib/room/agents/leader-agent';
import type { Room, RoomGoal, NeoTask } from '@neokai/shared';

function makeRoom(overrides?: Partial<Room>): Room {
	return {
		id: 'room-1',
		name: 'Test Room',
		allowedPaths: [{ path: '/workspace', label: 'ws' }],
		defaultPath: '/workspace',
		sessionIds: [],
		status: 'active',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeGoal(overrides?: Partial<RoomGoal>): RoomGoal {
	return {
		id: 'goal-1',
		roomId: 'room-1',
		title: 'Implement health check',
		description: 'Add a health check endpoint to the API',
		status: 'active',
		priority: 'normal',
		progress: 0,
		linkedTaskIds: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeTask(overrides?: Partial<NeoTask>): NeoTask {
	return {
		id: 'task-1',
		roomId: 'room-1',
		title: 'Add GET /health endpoint',
		description: 'Create a GET /health endpoint that returns 200 OK with uptime info',
		status: 'in_progress',
		priority: 'normal',
		dependsOn: [],
		createdAt: Date.now(),
		...overrides,
	};
}

function makeConfig(overrides?: Partial<LeaderAgentConfig>): LeaderAgentConfig {
	return {
		task: makeTask(),
		goal: makeGoal(),
		room: makeRoom(),
		sessionId: 'leader:room-1:task-1',
		workspacePath: '/workspace',
		groupId: 'group-1',
		...overrides,
	};
}

function makeCallbacks(): LeaderToolCallbacks & {
	calls: Array<{ method: string; args: unknown[] }>;
} {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	return {
		calls,
		async sendToWorker(groupId: string, message: string) {
			calls.push({ method: 'sendToWorker', args: [groupId, message] });
			return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }] };
		},
		async completeTask(groupId: string, summary: string) {
			calls.push({ method: 'completeTask', args: [groupId, summary] });
			return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }] };
		},
		async failTask(groupId: string, reason: string) {
			calls.push({ method: 'failTask', args: [groupId, reason] });
			return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }] };
		},
		async replanGoal(groupId: string, reason: string) {
			calls.push({ method: 'replanGoal', args: [groupId, reason] });
			return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }] };
		},
		async submitForReview(groupId: string, prUrl: string) {
			calls.push({ method: 'submitForReview', args: [groupId, prUrl] });
			return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }] };
		},
	};
}

describe('Leader Agent', () => {
	describe('buildLeaderSystemPrompt', () => {
		it('should include tool contract instructions', () => {
			const prompt = buildLeaderSystemPrompt(makeConfig());
			expect(prompt).toContain('MUST call exactly one tool per turn');
			expect(prompt).toContain('send_to_worker');
			expect(prompt).toContain('complete_task');
			expect(prompt).toContain('fail_task');
			expect(prompt).toContain('replan_goal');
		});

		it('should NOT include task-specific context', () => {
			const prompt = buildLeaderSystemPrompt(makeConfig());
			// Task/goal details belong in buildLeaderTaskContext, not the system prompt
			expect(prompt).not.toContain('Add GET /health endpoint');
			expect(prompt).not.toContain('Implement health check');
		});

		it('should NOT include room review policy', () => {
			const prompt = buildLeaderSystemPrompt(
				makeConfig({
					room: makeRoom({ instructions: 'Require 100% test coverage' }),
				})
			);
			// Review policy belongs in buildLeaderTaskContext, not the system prompt
			expect(prompt).not.toContain('Require 100% test coverage');
		});

		it('should include code review guidelines by default', () => {
			const prompt = buildLeaderSystemPrompt(makeConfig());
			expect(prompt).toContain('Review Guidelines');
		});

		it('should include plan review guidelines when reviewContext is plan_review', () => {
			const prompt = buildLeaderSystemPrompt(makeConfig({ reviewContext: 'plan_review' }));
			expect(prompt).toContain('Plan Review Guidelines');
			expect(prompt).toContain('task breakdown');
			expect(prompt).toContain('replan_goal');
		});

		it('should include replan_goal guidance in code review guidelines', () => {
			const prompt = buildLeaderSystemPrompt(makeConfig());
			expect(prompt).toContain('replan_goal');
			expect(prompt).toContain('overall approach needs rethinking');
		});

		it('should include orchestration workflow when sub-agents configured', () => {
			const prompt = buildLeaderSystemPrompt(
				makeConfig({
					room: makeRoom({
						config: {
							agentSubagents: {
								leader: [{ model: 'claude-opus-4-6' }, { model: 'claude-sonnet-4-6' }],
							},
						},
					}),
				})
			);
			expect(prompt).toContain('Review Orchestration Workflow');
			expect(prompt).toContain('reviewer-opus');
			expect(prompt).toContain('reviewer-sonnet');
			expect(prompt).toContain('---REVIEW_POSTED---');
			expect(prompt).toContain('Task(subagent_type:');
			// Routing decision criteria (P0-P3 severity-based)
			expect(prompt).toContain('P0/P1/P2 issues');
			expect(prompt).toContain('P3 nits');
		});

		it('should use simple review guidelines without sub-agents', () => {
			const prompt = buildLeaderSystemPrompt(makeConfig());
			expect(prompt).toContain('Review Guidelines');
			expect(prompt).not.toContain('Review Orchestration Workflow');
			expect(prompt).not.toContain('---REVIEW_POSTED---');
		});

		it('includes available specialists when sub-agents configured', () => {
			const prompt = buildLeaderSystemPrompt(
				makeConfig({
					room: makeRoom({
						config: {
							agentSubagents: {
								leader: [{ model: 'claude-opus-4-6' }, { model: 'claude-sonnet-4-6' }],
							},
						},
					}),
				})
			);
			expect(prompt).toContain('Available Specialists (via Task subagent_type)');
			expect(prompt).toContain('reviewer-opus, reviewer-sonnet');
			expect(prompt).toContain('Dispatch Reviewer Sub-agents');
		});

		it('recommends submit_for_review in simple review path', () => {
			const prompt = buildLeaderSystemPrompt(makeConfig());
			expect(prompt).toContain('submit_for_review');
			expect(prompt).toContain('non-coding tasks');
		});
	});

	describe('buildLeaderTaskContext', () => {
		it('should include task title and description', () => {
			const ctx = buildLeaderTaskContext(makeConfig());
			expect(ctx).toContain('Add GET /health endpoint');
			expect(ctx).toContain('GET /health endpoint that returns 200 OK');
		});

		it('should include goal context', () => {
			const ctx = buildLeaderTaskContext(makeConfig());
			expect(ctx).toContain('Implement health check');
		});

		it('should include room review policy when present', () => {
			const ctx = buildLeaderTaskContext(
				makeConfig({
					room: makeRoom({ instructions: 'Require 100% test coverage' }),
				})
			);
			expect(ctx).toContain('Require 100% test coverage');
			expect(ctx).toContain('Review Policy');
		});

		it('should omit review policy section when no instructions', () => {
			const ctx = buildLeaderTaskContext(makeConfig());
			expect(ctx).not.toContain('Review Policy');
		});

		it('should include task priority when set', () => {
			const ctx = buildLeaderTaskContext(makeConfig({ task: makeTask({ priority: 'urgent' }) }));
			expect(ctx).toContain('urgent');
		});
	});

	describe('createLeaderToolHandlers', () => {
		it('should route send_to_worker to callback with groupId', async () => {
			const callbacks = makeCallbacks();
			const handlers = createLeaderToolHandlers('group-1', callbacks);

			await handlers.send_to_worker({ message: 'Fix the error handling' });

			expect(callbacks.calls).toHaveLength(1);
			expect(callbacks.calls[0].method).toBe('sendToWorker');
			expect(callbacks.calls[0].args).toEqual(['group-1', 'Fix the error handling']);
		});

		it('should route complete_task to callback with groupId', async () => {
			const callbacks = makeCallbacks();
			const handlers = createLeaderToolHandlers('group-1', callbacks);

			await handlers.complete_task({ summary: 'All requirements met' });

			expect(callbacks.calls).toHaveLength(1);
			expect(callbacks.calls[0].method).toBe('completeTask');
			expect(callbacks.calls[0].args).toEqual(['group-1', 'All requirements met']);
		});

		it('should route fail_task to callback with groupId', async () => {
			const callbacks = makeCallbacks();
			const handlers = createLeaderToolHandlers('group-1', callbacks);

			await handlers.fail_task({ reason: 'API does not support this' });

			expect(callbacks.calls).toHaveLength(1);
			expect(callbacks.calls[0].method).toBe('failTask');
			expect(callbacks.calls[0].args).toEqual(['group-1', 'API does not support this']);
		});

		it('should route submit_for_review to callback with groupId and prUrl', async () => {
			const callbacks = makeCallbacks();
			const handlers = createLeaderToolHandlers('group-1', callbacks);

			await handlers.submit_for_review({ pr_url: 'https://github.com/org/repo/pull/42' });

			expect(callbacks.calls).toHaveLength(1);
			expect(callbacks.calls[0].method).toBe('submitForReview');
			expect(callbacks.calls[0].args).toEqual([
				'group-1',
				'https://github.com/org/repo/pull/42',
			]);
		});

		it('should route replan_goal to callback with groupId', async () => {
			const callbacks = makeCallbacks();
			const handlers = createLeaderToolHandlers('group-1', callbacks);

			await handlers.replan_goal({ reason: 'Wrong approach, need different strategy' });

			expect(callbacks.calls).toHaveLength(1);
			expect(callbacks.calls[0].method).toBe('replanGoal');
			expect(callbacks.calls[0].args).toEqual([
				'group-1',
				'Wrong approach, need different strategy',
			]);
		});
	});

	describe('createLeaderAgentInit', () => {
		it('should create init with correct session type', () => {
			const callbacks = makeCallbacks();
			const init = createLeaderAgentInit(makeConfig(), callbacks);
			expect(init.type).toBe('leader');
		});

		it('should use Claude Code preset with leader prompt appended', () => {
			const callbacks = makeCallbacks();
			const init = createLeaderAgentInit(makeConfig(), callbacks);
			expect(init.systemPrompt).toEqual({
				type: 'preset',
				preset: 'claude_code',
				append: expect.stringContaining('Leader Agent'),
			});
		});

		it('should include leader-agent-tools MCP server', () => {
			const callbacks = makeCallbacks();
			const init = createLeaderAgentInit(makeConfig(), callbacks);
			expect(init.mcpServers).toBeDefined();
			expect(init.mcpServers!['leader-agent-tools']).toBeDefined();
		});

		it('should use provided session ID and workspace path', () => {
			const callbacks = makeCallbacks();
			const init = createLeaderAgentInit(
				makeConfig({
					sessionId: 'leader:room-99:task-42',
					workspacePath: '/custom/path',
				}),
				callbacks
			);
			expect(init.sessionId).toBe('leader:room-99:task-42');
			expect(init.workspacePath).toBe('/custom/path');
		});

		it('should use default model when not specified', () => {
			const callbacks = makeCallbacks();
			const init = createLeaderAgentInit(makeConfig(), callbacks);
			expect(init.model).toBe('claude-sonnet-4-5-20250929');
		});

		it('should disable all features', () => {
			const callbacks = makeCallbacks();
			const init = createLeaderAgentInit(makeConfig(), callbacks);
			expect(init.features).toEqual({
				rewind: false,
				worktree: false,
				coordinator: false,
				archive: false,
				sessionInfo: false,
			});
		});

		it('should include room ID in context', () => {
			const callbacks = makeCallbacks();
			const init = createLeaderAgentInit(makeConfig(), callbacks);
			expect(init.context).toEqual({ roomId: 'room-1' });
		});

		it('should pass reviewer agents from agentSubagents.leader without coordinatorMode', () => {
			const callbacks = makeCallbacks();
			const init = createLeaderAgentInit(
				makeConfig({
					room: makeRoom({
						config: {
							agentSubagents: {
								leader: [{ model: 'claude-opus-4-6' }],
							},
						},
					}),
				}),
				callbacks
			);
			// coordinatorMode should NOT be set — leader uses its own prompt/tools
			expect(init.coordinatorMode).toBeUndefined();
			// agent: 'Leader' designates Leader as the main thread
			expect(init.agent).toBe('Leader');
			expect(init.agents).toBeDefined();
			// agents map must include both the Leader and reviewer entries
			expect(Object.keys(init.agents!)).toContain('Leader');
			expect(Object.keys(init.agents!)).toContain('reviewer-opus');
		});

		it('should set agent: Leader when reviewers configured', () => {
			const callbacks = makeCallbacks();
			const init = createLeaderAgentInit(
				makeConfig({
					room: makeRoom({
						config: {
							agentSubagents: {
								leader: [{ model: 'claude-opus-4-6' }, { model: 'claude-sonnet-4-6' }],
							},
						},
					}),
				}),
				callbacks
			);
			expect(init.agent).toBe('Leader');
			expect(init.agents).toBeDefined();
			expect(Object.keys(init.agents!)).toHaveLength(3); // Leader + 2 reviewers
			expect(Object.keys(init.agents!)).toContain('Leader');
			expect(Object.keys(init.agents!)).toContain('reviewer-opus');
			expect(Object.keys(init.agents!)).toContain('reviewer-sonnet');
		});

		it('should include Task tools in Leader agent definition', () => {
			const callbacks = makeCallbacks();
			const init = createLeaderAgentInit(
				makeConfig({
					room: makeRoom({
						config: {
							agentSubagents: {
								leader: [{ model: 'claude-opus-4-6' }],
							},
						},
					}),
				}),
				callbacks
			);
			const leaderDef = init.agents!['Leader'];
			expect(leaderDef).toBeDefined();
			expect(leaderDef.tools).toContain('Task');
			expect(leaderDef.tools).toContain('TaskOutput');
			expect(leaderDef.tools).toContain('TaskStop');
			expect(leaderDef.tools).toContain('Read');
			expect(leaderDef.tools).toContain('Grep');
			expect(leaderDef.tools).toContain('Glob');
		});

		it('should use agentSubagents.leader for reviewer config', () => {
			const callbacks = makeCallbacks();
			const init = createLeaderAgentInit(
				makeConfig({
					room: makeRoom({
						config: {
							agentSubagents: {
								leader: [{ model: 'claude-sonnet-4-6' }, { model: 'claude-haiku-4-5' }],
							},
						},
					}),
				}),
				callbacks
			);
			expect(init.coordinatorMode).toBeUndefined();
			expect(init.agent).toBe('Leader');
			expect(Object.keys(init.agents!)).toContain('Leader');
			expect(Object.keys(init.agents!)).toContain('reviewer-sonnet');
			expect(Object.keys(init.agents!)).toContain('reviewer-haiku');
		});

		it('should not set agent or agents when no reviewers configured', () => {
			const callbacks = makeCallbacks();
			const init = createLeaderAgentInit(makeConfig(), callbacks);
			expect(init.coordinatorMode).toBeUndefined();
			expect(init.agent).toBeUndefined();
			expect(init.agents).toBeUndefined();
		});
	});

	describe('buildReviewerAgents', () => {
		it('should create SDK reviewer with review-posted output format in prompt', () => {
			const agents = buildReviewerAgents([{ model: 'claude-opus-4-6' }]);
			const agent = agents['reviewer-opus'];
			expect(agent).toBeDefined();
			expect(agent.prompt).toContain('---REVIEW_POSTED---');
			expect(agent.prompt).toContain('---END_REVIEW_POSTED---');
			expect(agent.prompt).toContain('APPROVE');
			expect(agent.prompt).toContain('REQUEST_CHANGES');
			// Review URL capture
			expect(agent.prompt).toContain('Capture the review URL');
			// P0-P3 severity system
			expect(agent.prompt).toContain('P0 (blocking)');
			expect(agent.prompt).toContain('P3 (nit)');
			// Comprehensive review, not just diff
			expect(agent.prompt).toContain('not just diffs');
			expect(agent.prompt).toContain('original ask');
		});

		it('should create CLI reviewer with review-posted output format in prompt', () => {
			const agents = buildReviewerAgents([
				{ model: 'custom-cli', type: 'cli', driver_model: 'haiku' },
			]);
			const agent = agents['reviewer-custom-cli'];
			expect(agent).toBeDefined();
			expect(agent.model).toBe('haiku');
			expect(agent.prompt).toContain('custom-cli');
			expect(agent.prompt).toContain('---REVIEW_POSTED---');
			expect(agent.prompt).toContain('---END_REVIEW_POSTED---');
		});

		it('should include read-only tools for reviewers', () => {
			const agents = buildReviewerAgents([{ model: 'claude-opus-4-6' }]);
			const agent = agents['reviewer-opus'];
			expect(agent.tools).toContain('Read');
			expect(agent.tools).toContain('Grep');
			expect(agent.tools).toContain('Glob');
			expect(agent.tools).toContain('Bash');
			expect(agent.tools).not.toContain('Edit');
			expect(agent.tools).not.toContain('Write');
		});

		it('should map full model ID to valid AgentModel for SDK-native reviewer', () => {
			const agents = buildReviewerAgents([{ model: 'claude-opus-4-6-20250929' }]);
			const agent = agents['reviewer-opus'];
			expect(agent).toBeDefined();
			expect(agent.model).toBe('opus');
		});

		it('should map full model ID to valid AgentModel for CLI reviewer', () => {
			const agents = buildReviewerAgents([
				{ model: 'custom-cli', type: 'cli', driver_model: 'claude-sonnet-4-5-20250929' },
			]);
			const agent = agents['reviewer-custom-cli'];
			expect(agent).toBeDefined();
			expect(agent.model).toBe('sonnet');
		});

		it('should default CLI reviewer to sonnet when no driver_model given', () => {
			const agents = buildReviewerAgents([{ model: 'custom-cli', type: 'cli' }]);
			const agent = agents['reviewer-custom-cli'];
			expect(agent.model).toBe('sonnet');
		});
	});

	describe('toAgentModel', () => {
		it('should map full opus model ID to opus', () => {
			expect(toAgentModel('claude-opus-4-6-20250929')).toBe('opus');
		});

		it('should map full sonnet model ID to sonnet', () => {
			expect(toAgentModel('claude-sonnet-4-5-20250929')).toBe('sonnet');
		});

		it('should map full haiku model ID to haiku', () => {
			expect(toAgentModel('claude-haiku-3-5-20241022')).toBe('haiku');
		});

		it('should default unknown model to sonnet', () => {
			expect(toAgentModel('some-unknown-model-xyz')).toBe('sonnet');
		});

		it('should map short name opus to opus', () => {
			expect(toAgentModel('opus')).toBe('opus');
		});

		it('should map short name sonnet to sonnet', () => {
			expect(toAgentModel('sonnet')).toBe('sonnet');
		});

		it('should map short name haiku to haiku', () => {
			expect(toAgentModel('haiku')).toBe('haiku');
		});

		it('should map version-pattern opus-4.6 to opus', () => {
			expect(toAgentModel('opus-4.6')).toBe('opus');
		});

		it('should map version-pattern sonnet-4.6 to sonnet', () => {
			expect(toAgentModel('sonnet-4.6')).toBe('sonnet');
		});

		it('should map version-pattern haiku-4.6 to haiku', () => {
			expect(toAgentModel('haiku-4.6')).toBe('haiku');
		});

		it('should map claude-opus-4.6 style IDs to opus', () => {
			expect(toAgentModel('claude-opus-4.6')).toBe('opus');
		});

		it('should map claude-sonnet-4.6 style IDs to sonnet', () => {
			expect(toAgentModel('claude-sonnet-4.6')).toBe('sonnet');
		});
	});
});
