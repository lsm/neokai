import { describe, expect, it } from 'bun:test';
import {
	buildCoderSystemPrompt,
	buildCoderTaskMessage,
	createCoderAgentInit,
	type CoderAgentConfig,
} from '../../../src/lib/room/agents/coder-agent';
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
		it('includes mandatory git workflow with feature branch and PR instructions', () => {
			const prompt = buildCoderSystemPrompt();
			expect(prompt).toContain('Git Workflow (MANDATORY)');
			expect(prompt).toContain('feature branch');
			expect(prompt).toContain('gh pr create');
			expect(prompt).toContain('Do NOT commit directly to the main/dev/master branch');
		});

		it('includes git fetch and rebase as the first step', () => {
			const prompt = buildCoderSystemPrompt();
			expect(prompt).toContain('Sync with the default branch first');
			expect(prompt).toContain('git fetch origin');
			expect(prompt).toContain('git rebase origin/$DEFAULT_BRANCH');
			expect(prompt).toContain('git symbolic-ref refs/remotes/origin/HEAD');
		});

		it('instructs to stop on rebase conflict rather than continuing', () => {
			const prompt = buildCoderSystemPrompt();
			expect(prompt).toContain('rebase fails');
			expect(prompt).toContain('stop immediately and report the error');
		});

		it('uses subshell with empty-check fallback for gh pr create --base', () => {
			const prompt = buildCoderSystemPrompt();
			// Uses $() subshell so no persistent variable is required across tool calls
			expect(prompt).toContain(
				`gh pr create --fill --base $(b=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'); [ -z "$b" ] && b=$(git remote show origin | sed -n '/HEAD branch/s/.*: //p'); echo "$b")`
			);
		});

		it('combines sync commands in a single bash invocation using the empty-check fallback pattern', () => {
			const prompt = buildCoderSystemPrompt();
			// Two-step empty check: symbolic-ref first, then remote show if empty.
			// This avoids the || pipeline exit code bug where sed exits 0 even when
			// git symbolic-ref fails, causing the || fallback to never trigger.
			expect(prompt).toContain(
				`DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')`
			);
			expect(prompt).toContain(
				`[ -z "$DEFAULT_BRANCH" ] && DEFAULT_BRANCH=$(git remote show origin | sed -n '/HEAD branch/s/.*: //p')`
			);
			expect(prompt).toContain('git fetch origin && git rebase origin/$DEFAULT_BRANCH');
		});

		it('includes fallback for repos where origin/HEAD is not configured', () => {
			const prompt = buildCoderSystemPrompt();
			expect(prompt).toContain('git remote show origin');
			expect(prompt).toContain("sed -n '/HEAD branch/s/.*: //p'");
		});

		it('suppresses git symbolic-ref stderr with 2>/dev/null', () => {
			const prompt = buildCoderSystemPrompt();
			expect(prompt).toContain('git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null');
		});

		it('sync step appears before implementation step', () => {
			const prompt = buildCoderSystemPrompt();
			const syncIdx = prompt.indexOf('Sync with the default branch first');
			const implementIdx = prompt.indexOf('Implement the task');
			expect(syncIdx).toBeGreaterThanOrEqual(0);
			expect(implementIdx).toBeGreaterThanOrEqual(0);
			expect(syncIdx).toBeLessThan(implementIdx);
		});

		it('includes coder agent role description', () => {
			const prompt = buildCoderSystemPrompt();
			expect(prompt).toContain('You are a Coder Agent');
		});

		it('should NOT include task-specific context', () => {
			const prompt = buildCoderSystemPrompt();
			// Task title and description should not be in system prompt
			expect(prompt).not.toContain('Add GET /health endpoint');
			expect(prompt).not.toContain('Implement health check');
		});
	});

	describe('buildCoderTaskMessage', () => {
		it('should include task title and description', () => {
			const message = buildCoderTaskMessage(makeConfig());
			expect(message).toContain('Add GET /health endpoint');
			expect(message).toContain('GET /health endpoint that returns 200 OK');
		});

		it('should include goal context', () => {
			const message = buildCoderTaskMessage(makeConfig());
			expect(message).toContain('Implement health check');
			expect(message).toContain('health check endpoint to the API');
		});

		it('should include room background when present', () => {
			const message = buildCoderTaskMessage(
				makeConfig({
					room: makeRoom({ background: 'This is a Node.js REST API project' }),
				})
			);
			expect(message).toContain('Node.js REST API project');
		});

		it('should include room instructions when present', () => {
			const message = buildCoderTaskMessage(
				makeConfig({
					room: makeRoom({ instructions: 'Always write tests first' }),
				})
			);
			expect(message).toContain('Always write tests first');
		});

		it('should include previous task summaries when provided', () => {
			const message = buildCoderTaskMessage(
				makeConfig({
					previousTaskSummaries: [
						'Set up Express server with basic routing',
						'Added database connection module',
					],
				})
			);
			expect(message).toContain('Set up Express server');
			expect(message).toContain('database connection module');
			expect(message).toContain('Previous Work');
		});

		it('should omit previous work section when no summaries', () => {
			const message = buildCoderTaskMessage(makeConfig());
			expect(message).not.toContain('Previous Work');
		});

		it('should end with begin instruction', () => {
			const message = buildCoderTaskMessage(makeConfig());
			expect(message).toContain('Begin working on this task.');
		});
	});

	describe('createCoderAgentInit', () => {
		it('should create init with correct session type', () => {
			const init = createCoderAgentInit(makeConfig());
			expect(init.type).toBe('coder');
		});

		it('should use claude_code preset with behavioral-only prompt appended', () => {
			const init = createCoderAgentInit(makeConfig());
			expect(init.systemPrompt).toEqual({
				type: 'preset',
				preset: 'claude_code',
				append: expect.stringContaining('Git Workflow (MANDATORY)'),
			});
			// System prompt should NOT contain task-specific content
			if (typeof init.systemPrompt === 'object' && 'append' in init.systemPrompt) {
				expect(init.systemPrompt.append).not.toContain('Add GET /health endpoint');
			}
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
