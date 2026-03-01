import { describe, expect, it } from 'bun:test';
import {
	buildCoderSystemPrompt,
	createCoderAgentInit,
	type CoderAgentConfig,
} from '../../../src/lib/room/coder-agent';
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
		status: 'pending',
		priority: 'normal',
		dependsOn: [],
		createdAt: Date.now(),
		...overrides,
	};
}

function makeConfig(overrides?: Partial<CoderAgentConfig>): CoderAgentConfig {
	return {
		task: makeTask(),
		goal: makeGoal(),
		room: makeRoom(),
		sessionId: 'coder:room-1:task-1',
		workspacePath: '/workspace',
		...overrides,
	};
}

describe('Coder Agent', () => {
	describe('buildCoderSystemPrompt', () => {
		it('should include task title and description', () => {
			const prompt = buildCoderSystemPrompt(makeConfig());
			expect(prompt).toContain('Add GET /health endpoint');
			expect(prompt).toContain('GET /health endpoint that returns 200 OK');
		});

		it('should include goal context', () => {
			const prompt = buildCoderSystemPrompt(makeConfig());
			expect(prompt).toContain('Implement health check');
			expect(prompt).toContain('health check endpoint to the API');
		});

		it('should include room background when present', () => {
			const prompt = buildCoderSystemPrompt(
				makeConfig({
					room: makeRoom({ background: 'This is a Node.js REST API project' }),
				})
			);
			expect(prompt).toContain('Node.js REST API project');
		});

		it('should include room instructions when present', () => {
			const prompt = buildCoderSystemPrompt(
				makeConfig({
					room: makeRoom({ instructions: 'Always write tests first' }),
				})
			);
			expect(prompt).toContain('Always write tests first');
		});

		it('should include previous task summaries when provided', () => {
			const prompt = buildCoderSystemPrompt(
				makeConfig({
					previousTaskSummaries: [
						'Set up Express server with basic routing',
						'Added database connection module',
					],
				})
			);
			expect(prompt).toContain('Set up Express server');
			expect(prompt).toContain('database connection module');
			expect(prompt).toContain('Previous Work');
		});

		it('should omit previous work section when no summaries', () => {
			const prompt = buildCoderSystemPrompt(makeConfig());
			expect(prompt).not.toContain('Previous Work');
		});

		it('includes mandatory git workflow with feature branch and PR instructions', () => {
			const prompt = buildCoderSystemPrompt(makeConfig());
			expect(prompt).toContain('Git Workflow (MANDATORY)');
			expect(prompt).toContain('feature branch');
			expect(prompt).toContain('gh pr create');
			expect(prompt).toContain('Do NOT commit directly to the main/dev/master branch');
		});
	});

	describe('createCoderAgentInit', () => {
		it('should create init with correct session type', () => {
			const init = createCoderAgentInit(makeConfig());
			expect(init.type).toBe('coder');
		});

		it('should use claude_code preset with appended prompt', () => {
			const init = createCoderAgentInit(makeConfig());
			expect(init.systemPrompt).toEqual({
				type: 'preset',
				preset: 'claude_code',
				append: expect.stringContaining('Add GET /health endpoint'),
			});
		});

		it('should use provided session ID and workspace path', () => {
			const init = createCoderAgentInit(
				makeConfig({
					sessionId: 'coder:room-99:task-42',
					workspacePath: '/custom/path',
				})
			);
			expect(init.sessionId).toBe('coder:room-99:task-42');
			expect(init.workspacePath).toBe('/custom/path');
		});

		it('should use default model when not specified', () => {
			const init = createCoderAgentInit(makeConfig());
			expect(init.model).toBe('claude-sonnet-4-5-20250929');
		});

		it('should use custom model when specified', () => {
			const init = createCoderAgentInit(makeConfig({ model: 'claude-opus-4-6' }));
			expect(init.model).toBe('claude-opus-4-6');
		});

		it('should disable all features', () => {
			const init = createCoderAgentInit(makeConfig());
			expect(init.features).toEqual({
				rewind: false,
				worktree: false,
				coordinator: false,
				archive: false,
				sessionInfo: false,
			});
		});

		it('should include room ID in context', () => {
			const init = createCoderAgentInit(makeConfig());
			expect(init.context).toEqual({ roomId: 'room-1' });
		});
	});
});
