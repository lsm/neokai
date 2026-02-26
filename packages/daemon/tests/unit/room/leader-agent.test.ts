import { describe, expect, it } from 'bun:test';
import {
	buildLeaderSystemPrompt,
	createLeaderToolHandlers,
	createLeaderAgentInit,
	type LeaderAgentConfig,
	type LeaderToolCallbacks,
} from '../../../src/lib/room/leader-agent';
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
		});

		it('should include task context', () => {
			const prompt = buildLeaderSystemPrompt(makeConfig());
			expect(prompt).toContain('Add GET /health endpoint');
			expect(prompt).toContain('GET /health endpoint that returns 200 OK');
		});

		it('should include goal context', () => {
			const prompt = buildLeaderSystemPrompt(makeConfig());
			expect(prompt).toContain('Implement health check');
		});

		it('should include room review policy when present', () => {
			const prompt = buildLeaderSystemPrompt(
				makeConfig({
					room: makeRoom({ instructions: 'Require 100% test coverage' }),
				})
			);
			expect(prompt).toContain('Require 100% test coverage');
		});

		it('should include code review guidelines by default', () => {
			const prompt = buildLeaderSystemPrompt(makeConfig());
			expect(prompt).toContain('Review Guidelines');
		});

		it('should include plan review guidelines when reviewContext is plan_review', () => {
			const prompt = buildLeaderSystemPrompt(makeConfig({ reviewContext: 'plan_review' }));
			expect(prompt).toContain('Plan Review Guidelines');
			expect(prompt).toContain('task breakdown');
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
	});

	describe('createLeaderAgentInit', () => {
		it('should create init with correct session type', () => {
			const callbacks = makeCallbacks();
			const init = createLeaderAgentInit(makeConfig(), callbacks);
			expect(init.type).toBe('leader');
		});

		it('should use custom system prompt (not Claude Code preset)', () => {
			const callbacks = makeCallbacks();
			const init = createLeaderAgentInit(makeConfig(), callbacks);
			expect(typeof init.systemPrompt).toBe('string');
			expect(init.systemPrompt as string).toContain('Leader Agent');
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
	});
});
