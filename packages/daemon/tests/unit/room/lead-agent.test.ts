import { describe, expect, it } from 'bun:test';
import {
	buildLeadSystemPrompt,
	createLeadToolHandlers,
	createLeadAgentInit,
	type LeadAgentConfig,
	type LeadToolCallbacks,
} from '../../../src/lib/room/lead-agent';
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

function makeConfig(overrides?: Partial<LeadAgentConfig>): LeadAgentConfig {
	return {
		task: makeTask(),
		goal: makeGoal(),
		room: makeRoom(),
		sessionId: 'lead:room-1:task-1',
		workspacePath: '/workspace',
		pairId: 'pair-1',
		...overrides,
	};
}

function makeCallbacks(): LeadToolCallbacks & {
	calls: Array<{ method: string; args: unknown[] }>;
} {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	return {
		calls,
		async sendToCraft(pairId: string, message: string) {
			calls.push({ method: 'sendToCraft', args: [pairId, message] });
			return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }] };
		},
		async completeTask(pairId: string, summary: string) {
			calls.push({ method: 'completeTask', args: [pairId, summary] });
			return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }] };
		},
		async failTask(pairId: string, reason: string) {
			calls.push({ method: 'failTask', args: [pairId, reason] });
			return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }] };
		},
	};
}

describe('Lead Agent', () => {
	describe('buildLeadSystemPrompt', () => {
		it('should include tool contract instructions', () => {
			const prompt = buildLeadSystemPrompt(makeConfig());
			expect(prompt).toContain('MUST call exactly one tool per turn');
			expect(prompt).toContain('send_to_craft');
			expect(prompt).toContain('complete_task');
			expect(prompt).toContain('fail_task');
		});

		it('should include task context', () => {
			const prompt = buildLeadSystemPrompt(makeConfig());
			expect(prompt).toContain('Add GET /health endpoint');
			expect(prompt).toContain('GET /health endpoint that returns 200 OK');
		});

		it('should include goal context', () => {
			const prompt = buildLeadSystemPrompt(makeConfig());
			expect(prompt).toContain('Implement health check');
		});

		it('should include room review policy when present', () => {
			const prompt = buildLeadSystemPrompt(
				makeConfig({
					room: makeRoom({ instructions: 'Require 100% test coverage' }),
				})
			);
			expect(prompt).toContain('Require 100% test coverage');
		});

		it('should include review guidelines', () => {
			const prompt = buildLeadSystemPrompt(makeConfig());
			expect(prompt).toContain('Review Guidelines');
		});
	});

	describe('createLeadToolHandlers', () => {
		it('should route send_to_craft to callback with pairId', async () => {
			const callbacks = makeCallbacks();
			const handlers = createLeadToolHandlers('pair-1', callbacks);

			await handlers.send_to_craft({ message: 'Fix the error handling' });

			expect(callbacks.calls).toHaveLength(1);
			expect(callbacks.calls[0].method).toBe('sendToCraft');
			expect(callbacks.calls[0].args).toEqual(['pair-1', 'Fix the error handling']);
		});

		it('should route complete_task to callback with pairId', async () => {
			const callbacks = makeCallbacks();
			const handlers = createLeadToolHandlers('pair-1', callbacks);

			await handlers.complete_task({ summary: 'All requirements met' });

			expect(callbacks.calls).toHaveLength(1);
			expect(callbacks.calls[0].method).toBe('completeTask');
			expect(callbacks.calls[0].args).toEqual(['pair-1', 'All requirements met']);
		});

		it('should route fail_task to callback with pairId', async () => {
			const callbacks = makeCallbacks();
			const handlers = createLeadToolHandlers('pair-1', callbacks);

			await handlers.fail_task({ reason: 'API does not support this' });

			expect(callbacks.calls).toHaveLength(1);
			expect(callbacks.calls[0].method).toBe('failTask');
			expect(callbacks.calls[0].args).toEqual(['pair-1', 'API does not support this']);
		});
	});

	describe('createLeadAgentInit', () => {
		it('should create init with correct session type', () => {
			const callbacks = makeCallbacks();
			const init = createLeadAgentInit(makeConfig(), callbacks);
			expect(init.type).toBe('lead');
		});

		it('should use custom system prompt (not Claude Code preset)', () => {
			const callbacks = makeCallbacks();
			const init = createLeadAgentInit(makeConfig(), callbacks);
			expect(typeof init.systemPrompt).toBe('string');
			expect(init.systemPrompt as string).toContain('Lead Agent');
		});

		it('should include lead-agent-tools MCP server', () => {
			const callbacks = makeCallbacks();
			const init = createLeadAgentInit(makeConfig(), callbacks);
			expect(init.mcpServers).toBeDefined();
			expect(init.mcpServers!['lead-agent-tools']).toBeDefined();
		});

		it('should use provided session ID and workspace path', () => {
			const callbacks = makeCallbacks();
			const init = createLeadAgentInit(
				makeConfig({
					sessionId: 'lead:room-99:task-42',
					workspacePath: '/custom/path',
				}),
				callbacks
			);
			expect(init.sessionId).toBe('lead:room-99:task-42');
			expect(init.workspacePath).toBe('/custom/path');
		});

		it('should use default model when not specified', () => {
			const callbacks = makeCallbacks();
			const init = createLeadAgentInit(makeConfig(), callbacks);
			expect(init.model).toBe('claude-sonnet-4-5-20250929');
		});

		it('should disable all features', () => {
			const callbacks = makeCallbacks();
			const init = createLeadAgentInit(makeConfig(), callbacks);
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
			const init = createLeadAgentInit(makeConfig(), callbacks);
			expect(init.context).toEqual({ roomId: 'room-1' });
		});
	});
});
