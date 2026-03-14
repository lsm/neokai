import { describe, expect, it } from 'bun:test';
import {
	buildPlannerSystemPrompt,
	buildPlannerTaskMessage,
	createPlannerAgentInit,
	toPlanSlug,
	type PlannerAgentConfig,
} from '../../../src/lib/room/agents/planner-agent';

const sharedBaseConfig: PlannerAgentConfig = {
	task: {
		id: 'task-1',
		roomId: 'room-1',
		title: 'Plan: Build stock app',
		description: 'Break down the goal',
		status: 'in_progress',
		priority: 'normal',
		createdAt: Date.now(),
		taskType: 'planning',
	},
	goal: {
		id: 'goal-1',
		roomId: 'room-1',
		title: 'Build stock app',
		description: 'A stock tracking web app',
		status: 'active',
		priority: 'normal',
		progress: 0,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	},
	room: {
		id: 'room-1',
		name: 'Test Room',
		allowedPaths: [{ path: '/workspace', label: 'ws' }],
		defaultPath: '/workspace',
		sessionIds: [],
		status: 'active',
		createdAt: Date.now(),
		updatedAt: Date.now(),
	},
	sessionId: 'session-1',
	workspacePath: '/workspace',
	createDraftTask: async () => ({ id: 'draft-1', title: 'Draft' }),
	updateDraftTask: async () => ({ id: 'draft-1', title: 'Draft' }),
	removeDraftTask: async () => true,
};

describe('planner-agent', () => {
	describe('toPlanSlug', () => {
		it('should convert goal title to kebab-case slug', () => {
			expect(toPlanSlug('Build a stock web app')).toBe('build-a-stock-web-app');
		});

		it('should strip special characters', () => {
			expect(toPlanSlug('Add JWT auth (v2)!')).toBe('add-jwt-auth-v2');
		});

		it('should collapse multiple dashes', () => {
			expect(toPlanSlug('Build -- something -- new')).toBe('build-something-new');
		});

		it('should truncate to 60 chars', () => {
			const longTitle = 'A'.repeat(100);
			expect(toPlanSlug(longTitle).length).toBeLessThanOrEqual(60);
		});

		it('should not end with a dash', () => {
			expect(toPlanSlug('Test goal -')).toBe('test-goal');
		});
	});

	describe('buildPlannerSystemPrompt', () => {
		it('should include both Phase 1 and Phase 2 instructions', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');

			// Phase 1: Planning
			expect(prompt).toContain('Phase 1: Planning');
			expect(prompt).toContain('docs/plans/');
			expect(prompt).toContain('gh pr create');

			// Phase 2: Task Creation
			expect(prompt).toContain('Phase 2: Task Creation');
			expect(prompt).toContain('create_task');
			expect(prompt).toContain('depends_on');
		});

		it('should include pre-planning git sync setup', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			expect(prompt).toContain('Pre-Planning Setup (MANDATORY)');
			expect(prompt).toContain('git fetch origin');
			expect(prompt).toContain('git rebase origin/$DEFAULT_BRANCH');
			expect(prompt).toContain('git symbolic-ref refs/remotes/origin/HEAD');
		});

		it('should instruct to stop on rebase conflict', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			expect(prompt).toContain('rebase fails');
			expect(prompt).toContain('stop immediately and report the error');
		});

		it('should combine sync commands in single bash invocation using the empty-check fallback pattern', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			// Two-step empty check avoids the || pipeline exit code bug
			expect(prompt).toContain(
				`DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')`
			);
			expect(prompt).toContain(
				`[ -z "$DEFAULT_BRANCH" ] && DEFAULT_BRANCH=$(git remote show origin | sed -n '/HEAD branch/s/.*: //p')`
			);
			expect(prompt).toContain('git fetch origin && git rebase origin/$DEFAULT_BRANCH');
		});

		it('should use subshell with empty-check fallback for gh pr create --base', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			expect(prompt).toContain(
				`gh pr create --fill --base $(b=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'); [ -z "$b" ] && b=$(git remote show origin | sed -n '/HEAD branch/s/.*: //p'); echo "$b")`
			);
		});

		it('should include fallback for repos where origin/HEAD is not configured', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			expect(prompt).toContain('git remote show origin');
			expect(prompt).toContain("sed -n '/HEAD branch/s/.*: //p'");
		});

		it('should suppress git symbolic-ref stderr with 2>/dev/null', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			expect(prompt).toContain('git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null');
		});

		it('should place pre-planning setup before Phase 1 planning', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			const syncIdx = prompt.indexOf('Pre-Planning Setup (MANDATORY)');
			const phase1Idx = prompt.indexOf('Phase 1: Planning');
			expect(syncIdx).toBeGreaterThanOrEqual(0);
			expect(phase1Idx).toBeGreaterThanOrEqual(0);
			expect(syncIdx).toBeLessThan(phase1Idx);
		});

		it('should use goal title for plan path', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			expect(prompt).toContain('docs/plans/build-stock-app.md');
		});

		it('should use default plan name when no goal title', () => {
			const prompt = buildPlannerSystemPrompt();
			expect(prompt).toContain('docs/plans/plan.md');
		});

		it('should mention tools are disabled during planning phase', () => {
			const prompt = buildPlannerSystemPrompt('Test');
			expect(prompt).toContain('Do NOT call');
			expect(prompt).toContain('disabled');
		});

		it('should NOT impose a fixed task count limit', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			expect(prompt).not.toContain('3-8');
			expect(prompt).not.toContain('3 to 8');
		});

		it('should encourage granular tasks for complex goals', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			expect(prompt).toContain('granular');
		});

		it('should include Explore sub-agent guidance for codebase exploration', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			expect(prompt).toContain('Explore');
			expect(prompt).toContain('subagent_type');
		});

		it('should recommend spawning multiple Explore agents in parallel', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			expect(prompt).toContain('parallel');
		});

		it('should include Codebase Exploration section before Plan Creation', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			const exploreIdx = prompt.indexOf('Codebase Exploration');
			const planCreationIdx = prompt.indexOf('Plan Creation');
			expect(exploreIdx).toBeGreaterThanOrEqual(0);
			expect(planCreationIdx).toBeGreaterThanOrEqual(0);
			expect(exploreIdx).toBeLessThan(planCreationIdx);
		});
	});

	describe('buildPlannerTaskMessage', () => {
		const baseConfig: PlannerAgentConfig = {
			task: {
				id: 'task-1',
				roomId: 'room-1',
				title: 'Plan: Build stock app',
				description: 'Break down the goal',
				status: 'in_progress',
				priority: 'normal',
				createdAt: Date.now(),
				taskType: 'planning',
			},
			goal: {
				id: 'goal-1',
				roomId: 'room-1',
				title: 'Build stock app',
				description: 'A stock tracking web app',
				status: 'active',
				priority: 'normal',
				progress: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
			room: {
				id: 'room-1',
				name: 'Test Room',
				allowedPaths: [{ path: '/workspace', label: 'ws' }],
				defaultPath: '/workspace',
				sessionIds: [],
				status: 'active',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
			sessionId: 'session-1',
			workspacePath: '/workspace',
			createDraftTask: async () => ({ id: 'draft-1', title: 'Draft' }),
			updateDraftTask: async () => ({ id: 'draft-1', title: 'Draft' }),
			removeDraftTask: async () => true,
		};

		it('should include goal title and description', () => {
			const msg = buildPlannerTaskMessage(baseConfig);
			expect(msg).toContain('Build stock app');
			expect(msg).toContain('A stock tracking web app');
		});

		it('should include room background when present', () => {
			const config = {
				...baseConfig,
				room: { ...baseConfig.room, background: 'This is a fintech project' },
			};
			const msg = buildPlannerTaskMessage(config);
			expect(msg).toContain('fintech project');
		});

		it('should include room instructions when present', () => {
			const config = {
				...baseConfig,
				room: { ...baseConfig.room, instructions: 'Use TypeScript only' },
			};
			const msg = buildPlannerTaskMessage(config);
			expect(msg).toContain('Use TypeScript only');
		});

		it('should include replanning context when provided', () => {
			const config: PlannerAgentConfig = {
				...baseConfig,
				replanContext: {
					completedTasks: [{ title: 'Add login', result: 'JWT login added' }],
					failedTask: { title: 'Add signup', error: 'OAuth not configured' },
					attempt: 2,
				},
			};
			const msg = buildPlannerTaskMessage(config);
			expect(msg).toContain('Replanning Context');
			expect(msg).toContain('Attempt 2');
			expect(msg).toContain('Add login');
			expect(msg).toContain('JWT login added');
			expect(msg).toContain('Add signup');
			expect(msg).toContain('OAuth not configured');
			expect(msg).toContain('DO NOT redo');
		});
	});

	describe('createPlannerAgentInit', () => {
		it('should always use agent/agents pattern', () => {
			const init = createPlannerAgentInit(sharedBaseConfig);
			expect(init.agent).toBe('Planner');
			expect(init.agents).toBeDefined();
			expect(init.agents).toHaveProperty('Planner');
		});

		it('Planner agent def includes Task tool for spawning Explore sub-agents', () => {
			const init = createPlannerAgentInit(sharedBaseConfig);
			expect(init.agents?.['Planner']?.tools).toContain('Task');
		});

		it('Planner agent def includes TaskOutput and TaskStop tools', () => {
			const init = createPlannerAgentInit(sharedBaseConfig);
			const tools = init.agents?.['Planner']?.tools ?? [];
			expect(tools).toContain('TaskOutput');
			expect(tools).toContain('TaskStop');
		});

		it('Planner agent def includes standard codebase tools', () => {
			const init = createPlannerAgentInit(sharedBaseConfig);
			const tools = init.agents?.['Planner']?.tools ?? [];
			expect(tools).toContain('Read');
			expect(tools).toContain('Write');
			expect(tools).toContain('Bash');
			expect(tools).toContain('Grep');
		});

		it('Planner agent def uses inherit model', () => {
			const init = createPlannerAgentInit(sharedBaseConfig);
			expect(init.agents?.['Planner']?.model).toBe('inherit');
		});

		it('should use claude_code preset', () => {
			const init = createPlannerAgentInit(sharedBaseConfig);
			expect(init.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
		});

		it('should include planner-tools MCP server', () => {
			const init = createPlannerAgentInit(sharedBaseConfig);
			expect(init.mcpServers).toHaveProperty('planner-tools');
		});

		it('should set session type to planner', () => {
			const init = createPlannerAgentInit(sharedBaseConfig);
			expect(init.type).toBe('planner');
		});
	});
});
