import { describe, expect, it } from 'bun:test';
import {
	buildPlannerSystemPrompt,
	buildPlannerTaskMessage,
	buildPlanWriterAgentDef,
	buildPlanWriterPrompt,
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

			// Phase 2: Task Creation
			expect(prompt).toContain('Phase 2: Task Creation');
			expect(prompt).toContain('create_task');
			expect(prompt).toContain('depends_on');
		});

		it('should instruct to spawn the plan-writer sub-agent in Phase 1', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			expect(prompt).toContain('plan-writer');
			expect(prompt).toContain('plan-writer');
		});

		it('should instruct to parse ---PLAN_RESULT--- from plan-writer response', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			expect(prompt).toContain('---PLAN_RESULT---');
			expect(prompt).toContain('pr_number');
			expect(prompt).toContain('plan_files');
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

		it('should reference goal title for plan path', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			expect(prompt).toContain('docs/plans/build-stock-app');
		});

		it('should use default plan name when no goal title', () => {
			const prompt = buildPlannerSystemPrompt();
			expect(prompt).toContain('docs/plans/plan');
		});

		it('should mention tools are disabled during planning phase', () => {
			const prompt = buildPlannerSystemPrompt('Test');
			expect(prompt).toContain('Do NOT call');
			expect(prompt).toContain('disabled');
		});

		it('should instruct to merge PR before creating tasks in Phase 2', () => {
			const prompt = buildPlannerSystemPrompt('Test');
			expect(prompt).toContain('gh pr merge');
			expect(prompt).toContain('pr_number');
		});

		it('should describe multi-file plan structure for large goals', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			expect(prompt).toContain('00-overview.md');
			expect(prompt).toContain('multi');
		});
	});

	describe('buildPlanWriterPrompt', () => {
		it('should include git sync pre-work', () => {
			const prompt = buildPlanWriterPrompt();
			expect(prompt).toContain('git fetch origin && git rebase origin/$DEFAULT_BRANCH');
			expect(prompt).toContain('git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null');
		});

		it('should instruct to stop on rebase conflict', () => {
			const prompt = buildPlanWriterPrompt();
			expect(prompt).toContain('rebase fails with conflicts, stop immediately');
		});

		it('should include Explore sub-agent guidance for codebase exploration', () => {
			const prompt = buildPlanWriterPrompt();
			expect(prompt).toContain('Explore');
			expect(prompt).toContain('subagent_type');
		});

		it('should recommend spawning multiple Explore agents in parallel', () => {
			const prompt = buildPlanWriterPrompt();
			expect(prompt).toContain('parallel');
		});

		it('should define small vs large scope thresholds', () => {
			const prompt = buildPlanWriterPrompt();
			expect(prompt).toContain('Small scope');
			expect(prompt).toContain('Large scope');
			expect(prompt).toContain('5 milestones');
		});

		it('should describe single-file path for small scope using placeholder', () => {
			const prompt = buildPlanWriterPrompt();
			expect(prompt).toContain('<single_plan_path>');
		});

		it('should describe multi-file folder structure for large scope', () => {
			const prompt = buildPlanWriterPrompt();
			expect(prompt).toContain('<plan_dir>');
			expect(prompt).toContain('00-overview.md');
		});

		it('should describe iterative two-pass approach for large scope', () => {
			const prompt = buildPlanWriterPrompt();
			expect(prompt).toContain('Two-Pass');
			expect(prompt).toContain('Pass 1');
			expect(prompt).toContain('Pass 2');
		});

		it('should describe numbered file naming convention', () => {
			const prompt = buildPlanWriterPrompt();
			expect(prompt).toContain('NN-<milestone-slug>.md');
			expect(prompt).toContain('01-');
			expect(prompt).toContain('02-');
		});

		it('should use subshell with empty-check fallback for gh pr create --base', () => {
			const prompt = buildPlanWriterPrompt();
			expect(prompt).toContain(
				`gh pr create --fill --base $(b=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'); [ -z "$b" ] && b=$(git remote show origin | sed -n '/HEAD branch/s/.*: //p'); echo "$b")`
			);
		});

		it('should require ---PLAN_RESULT--- structured output block', () => {
			const prompt = buildPlanWriterPrompt();
			expect(prompt).toContain('---PLAN_RESULT---');
			expect(prompt).toContain('---END_PLAN_RESULT---');
			expect(prompt).toContain('pr_number');
			expect(prompt).toContain('plan_files');
			expect(prompt).toContain('structure: single | multi');
		});

		it('should instruct to create a feature branch with plan slug', () => {
			const prompt = buildPlanWriterPrompt();
			expect(prompt).toContain('git checkout -b plan/<plan_slug>');
		});
	});

	describe('buildPlanWriterAgentDef', () => {
		it('substitutes plan slug placeholders in prompt', () => {
			const def = buildPlanWriterAgentDef('my-goal');
			expect(def.prompt).toContain('docs/plans/my-goal.md');
			expect(def.prompt).toContain('docs/plans/my-goal/');
			expect(def.prompt).toContain('plan/my-goal');
		});

		it('does NOT contain raw placeholders after substitution', () => {
			const def = buildPlanWriterAgentDef('my-goal');
			expect(def.prompt).not.toContain('<single_plan_path>');
			expect(def.prompt).not.toContain('<plan_dir>');
			expect(def.prompt).not.toContain('<plan_slug>');
		});

		it('has Task tool for spawning Explore sub-agents', () => {
			const def = buildPlanWriterAgentDef('my-goal');
			expect(def.tools).toContain('Task');
			expect(def.tools).toContain('TaskOutput');
			expect(def.tools).toContain('TaskStop');
		});

		it('has standard codebase tools', () => {
			const def = buildPlanWriterAgentDef('my-goal');
			expect(def.tools).toContain('Read');
			expect(def.tools).toContain('Write');
			expect(def.tools).toContain('Edit');
			expect(def.tools).toContain('Bash');
		});

		it('uses inherit model', () => {
			const def = buildPlanWriterAgentDef('my-goal');
			expect(def.model).toBe('inherit');
		});

		it('prompt includes iterative multi-file instructions', () => {
			const def = buildPlanWriterAgentDef('my-goal');
			expect(def.prompt).toContain('00-overview.md');
			expect(def.prompt).toContain('Two-Pass');
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

		it('agents map includes plan-writer sub-agent', () => {
			const init = createPlannerAgentInit(sharedBaseConfig);
			expect(init.agents).toHaveProperty('plan-writer');
		});

		it('plan-writer agent has Task tool for spawning Explore sub-agents', () => {
			const init = createPlannerAgentInit(sharedBaseConfig);
			const planWriter = init.agents?.['plan-writer'];
			expect(planWriter?.tools).toContain('Task');
		});

		it('plan-writer agent uses inherit model', () => {
			const init = createPlannerAgentInit(sharedBaseConfig);
			expect(init.agents?.['plan-writer']?.model).toBe('inherit');
		});

		it('plan-writer prompt has concrete file paths derived from goal title', () => {
			const init = createPlannerAgentInit(sharedBaseConfig);
			const planWriterPrompt = init.agents?.['plan-writer']?.prompt ?? '';
			expect(planWriterPrompt).toContain('docs/plans/build-stock-app');
		});

		it('Planner agent def includes Task tool for spawning plan-writer', () => {
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
