import { describe, expect, it } from 'bun:test';
import {
	buildPlannerExplorerAgentDef,
	buildPlannerFactCheckerAgentDef,
	buildPlannerSystemPrompt,
	buildPlannerTaskMessage,
	buildPlanWriterAgentDef,
	buildPlanWriterPrompt,
	createPlannerAgentInit,
	toPlanSlug,
	type PlannerAgentConfig,
	type ReplanContext,
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

		it('should describe 3-stage pipeline in Phase 1', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			expect(prompt).toContain('3-Stage Pipeline');
			expect(prompt).toContain('Stage 1');
			expect(prompt).toContain('Stage 2');
			expect(prompt).toContain('Stage 3');
		});

		it('should instruct to spawn planner-explorer in Stage 1', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			expect(prompt).toContain('planner-explorer');
			expect(prompt).toContain('Stage 1: Codebase Exploration');
		});

		it('should instruct to collect ---EXPLORER_FINDINGS--- from planner-explorer', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			expect(prompt).toContain('---EXPLORER_FINDINGS---');
		});

		it('should instruct to spawn planner-fact-checker in Stage 2 with explorer findings', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			expect(prompt).toContain('planner-fact-checker');
			expect(prompt).toContain('Stage 2: Fact-Checking');
			// Must pass explorer findings to fact-checker
			expect(prompt).toContain('## Explorer Findings');
		});

		it('should instruct to collect ---FACT_CHECK_RESULT--- from planner-fact-checker', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			expect(prompt).toContain('---FACT_CHECK_RESULT---');
		});

		it('should instruct to spawn plan-writer in Stage 3 with both findings', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			expect(prompt).toContain('plan-writer');
			expect(prompt).toContain('Stage 3: Plan Writing');
			// Must pass both explorer findings and fact-check results to plan-writer
			expect(prompt).toContain('## Fact-Check Results');
		});

		it('should have stages in correct order (1 before 2 before 3)', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			const stage1Idx = prompt.indexOf('Stage 1:');
			const stage2Idx = prompt.indexOf('Stage 2:');
			const stage3Idx = prompt.indexOf('Stage 3:');
			expect(stage1Idx).toBeGreaterThanOrEqual(0);
			expect(stage2Idx).toBeGreaterThanOrEqual(0);
			expect(stage3Idx).toBeGreaterThanOrEqual(0);
			expect(stage1Idx).toBeLessThan(stage2Idx);
			expect(stage2Idx).toBeLessThan(stage3Idx);
		});

		it('should document context-passing: explorer findings passed verbatim to fact-checker', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			// verbatim keyword must appear near the context-passing instructions
			const explorerFindingsIdx = prompt.indexOf('---EXPLORER_FINDINGS--- block>');
			expect(explorerFindingsIdx).toBeGreaterThan(0);
		});

		it('should provide graceful degradation when planner-explorer fails', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			// If explorer fails, proceed directly to Stage 3 (plan-writer)
			expect(prompt).toContain('planner-explorer fails or times out');
			expect(prompt).toContain('Skip Stage 2 and proceed directly to Stage 3');
		});

		it('should provide graceful degradation when planner-fact-checker fails', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			// If fact-checker fails, proceed to plan-writer with explorer findings only
			expect(prompt).toContain('planner-fact-checker fails or times out');
			expect(prompt).toContain('explorer findings only');
			expect(prompt).toContain('fact-checking was skipped');
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

		it('should mention WebSearch and WebFetch in pre-planning setup section', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			expect(prompt).toContain('WebSearch');
			expect(prompt).toContain('WebFetch');
			// The note should appear in the Pre-Planning Setup section (before Phase 1)
			const setupIdx = prompt.indexOf('Pre-Planning Setup (MANDATORY)');
			const webSearchIdx = prompt.indexOf('WebSearch');
			const phase1Idx = prompt.indexOf('Phase 1: Planning');
			expect(setupIdx).toBeGreaterThanOrEqual(0);
			expect(webSearchIdx).toBeGreaterThanOrEqual(0);
			expect(webSearchIdx).toBeGreaterThan(setupIdx);
			expect(webSearchIdx).toBeLessThan(phase1Idx);
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
			expect(prompt).toContain('do NOT use --delete-branch');
			expect(prompt).toContain('pr_number');
		});

		it('should describe multi-file plan structure for large goals', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			expect(prompt).toContain('00-overview.md');
			expect(prompt).toContain('multi');
		});

		it('should instruct plan-writer to use explorer and fact-checker context as foundation', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			expect(prompt).toContain('explorer + fact-checker context as its foundation');
		});

		it('should include feedback handling instruction for plan edits', () => {
			const prompt = buildPlannerSystemPrompt('Build stock app');
			expect(prompt).toContain('Leader sends feedback on the plan');
			expect(prompt).toContain('Edit the plan files directly');
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

		it('should instruct to explore using own tools, not spawn sub-agents', () => {
			const prompt = buildPlanWriterPrompt();
			expect(prompt).toContain('do NOT attempt to spawn further sub-agents');
			expect(prompt).not.toContain('Task(subagent_type:');
			expect(prompt).not.toContain('subagent_type: "Explore"');
		});

		it('should describe codebase exploration using Read/Grep/Glob/Bash', () => {
			const prompt = buildPlanWriterPrompt();
			expect(prompt).toContain('Read, Grep, Glob, and Bash');
			expect(prompt).toContain('Step 1: Codebase Exploration');
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

		it('should include web research guidance (WebSearch/WebFetch) for verification', () => {
			const prompt = buildPlanWriterPrompt();
			expect(prompt).toContain('WebSearch');
			expect(prompt).toContain('WebFetch');
		});

		it('should position codebase exploration step before scope assessment', () => {
			const prompt = buildPlanWriterPrompt();
			const exploreIdx = prompt.indexOf('Step 1: Codebase Exploration');
			const scopeIdx = prompt.indexOf('Step 2: Scope Assessment');
			expect(exploreIdx).toBeGreaterThanOrEqual(0);
			expect(scopeIdx).toBeGreaterThanOrEqual(0);
			expect(exploreIdx).toBeLessThan(scopeIdx);
		});

		it('should clarify when NOT to use web search for general patterns', () => {
			const prompt = buildPlanWriterPrompt();
			expect(prompt).toContain('not for general patterns you already know');
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

		it('does NOT have Task/TaskOutput/TaskStop tools (cannot spawn sub-agents)', () => {
			const def = buildPlanWriterAgentDef('my-goal');
			expect(def.tools).not.toContain('Task');
			expect(def.tools).not.toContain('TaskOutput');
			expect(def.tools).not.toContain('TaskStop');
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

		it('should not include metric section without replanContext', () => {
			const msg = buildPlannerTaskMessage(baseConfig);
			expect(msg).not.toContain('Metric Targets');
		});

		it('should include metric section when metricContext is provided', () => {
			const rc: ReplanContext = {
				completedTasks: [{ title: 'Task A', result: 'done' }],
				failedTask: { title: 'Metric targets not met', error: 'coverage not met' },
				attempt: 2,
				metricContext: {
					metrics: [
						{
							name: 'coverage',
							current: 50,
							target: 80,
							direction: 'increase',
							met: false,
							recentHistory: [30, 40, 50],
						},
						{
							name: 'latency_p99',
							current: 250,
							target: 100,
							direction: 'decrease',
							baseline: 500,
							met: false,
							recentHistory: [450, 350, 250],
						},
					],
				},
			};
			const msg = buildPlannerTaskMessage({ ...baseConfig, replanContext: rc });
			expect(msg).toContain('Metric Targets');
			expect(msg).toContain('coverage');
			expect(msg).toContain('current=50');
			// Format is "need to increase to 80" (not "target=80")
			expect(msg).toContain('increase to 80');
			expect(msg).toContain('[NOT MET]');
			expect(msg).toContain('latency_p99');
			expect(msg).toContain('baseline=500');
			expect(msg).toContain('30 → 40 → 50');
		});

		it('should mark met metrics as [MET]', () => {
			const rc: ReplanContext = {
				completedTasks: [],
				failedTask: { title: 'Metric targets not met', error: 'some not met' },
				attempt: 1,
				metricContext: {
					metrics: [
						{
							name: 'coverage',
							current: 90,
							target: 80,
							direction: 'increase',
							met: true,
						},
					],
				},
			};
			const msg = buildPlannerTaskMessage({ ...baseConfig, replanContext: rc });
			expect(msg).toContain('[MET]');
			expect(msg).not.toContain('[NOT MET]');
		});

		it('should handle replanContext without metricContext (backward compat)', () => {
			const rc: ReplanContext = {
				completedTasks: [{ title: 'Task A', result: 'done' }],
				failedTask: { title: 'Task B', error: 'build failed' },
				attempt: 2,
			};
			const msg = buildPlannerTaskMessage({ ...baseConfig, replanContext: rc });
			expect(msg).toContain('Replanning Context');
			expect(msg).toContain('Task B');
			expect(msg).not.toContain('Metric Targets');
		});

		it('should include attempt number in replanning context', () => {
			const rc: ReplanContext = {
				completedTasks: [],
				failedTask: { title: 'Failed Task', error: 'error' },
				attempt: 3,
			};
			const msg = buildPlannerTaskMessage({ ...baseConfig, replanContext: rc });
			expect(msg).toContain('Attempt 3');
		});
	});

	describe('buildPlannerExplorerAgentDef', () => {
		it('returns a valid AgentDefinition', () => {
			const def = buildPlannerExplorerAgentDef();
			expect(def).toBeDefined();
			expect(def.tools).toBeDefined();
			expect(def.model).toBeDefined();
			expect(def.prompt).toBeDefined();
		});

		it('has only read-only codebase tools', () => {
			const def = buildPlannerExplorerAgentDef();
			expect(def.tools).toContain('Read');
			expect(def.tools).toContain('Grep');
			expect(def.tools).toContain('Glob');
			expect(def.tools).toContain('Bash');
		});

		it('does NOT have write or edit tools', () => {
			const def = buildPlannerExplorerAgentDef();
			expect(def.tools).not.toContain('Write');
			expect(def.tools).not.toContain('Edit');
		});

		it('does NOT have sub-agent spawning tools', () => {
			const def = buildPlannerExplorerAgentDef();
			expect(def.tools).not.toContain('Task');
			expect(def.tools).not.toContain('TaskOutput');
			expect(def.tools).not.toContain('TaskStop');
		});

		it('does NOT have web tools', () => {
			const def = buildPlannerExplorerAgentDef();
			expect(def.tools).not.toContain('WebSearch');
			expect(def.tools).not.toContain('WebFetch');
		});

		it('uses inherit model', () => {
			const def = buildPlannerExplorerAgentDef();
			expect(def.model).toBe('inherit');
		});

		it('prompt instructs to return ---EXPLORER_FINDINGS--- block', () => {
			const def = buildPlannerExplorerAgentDef();
			expect(def.prompt).toContain('---EXPLORER_FINDINGS---');
			expect(def.prompt).toContain('---END_EXPLORER_FINDINGS---');
		});

		it('prompt includes all required sections in findings block', () => {
			const def = buildPlannerExplorerAgentDef();
			expect(def.prompt).toContain('Relevant Files');
			expect(def.prompt).toContain('Patterns Found');
			expect(def.prompt).toContain('Dependencies');
			expect(def.prompt).toContain('Estimated Complexity');
			expect(def.prompt).toContain('Key Concerns');
		});

		it('prompt instructs not to write or edit files', () => {
			const def = buildPlannerExplorerAgentDef();
			expect(def.prompt).toContain('Do NOT write');
		});

		it('prompt instructs not to spawn sub-agents', () => {
			const def = buildPlannerExplorerAgentDef();
			expect(def.prompt).toContain('Do NOT spawn');
		});
	});

	describe('buildPlannerFactCheckerAgentDef', () => {
		it('returns a valid AgentDefinition', () => {
			const def = buildPlannerFactCheckerAgentDef();
			expect(def).toBeDefined();
			expect(def.tools).toBeDefined();
			expect(def.model).toBeDefined();
			expect(def.prompt).toBeDefined();
		});

		it('has only web tools', () => {
			const def = buildPlannerFactCheckerAgentDef();
			expect(def.tools).toContain('WebSearch');
			expect(def.tools).toContain('WebFetch');
			expect(def.tools).toHaveLength(2);
		});

		it('does NOT have codebase tools', () => {
			const def = buildPlannerFactCheckerAgentDef();
			expect(def.tools).not.toContain('Read');
			expect(def.tools).not.toContain('Grep');
			expect(def.tools).not.toContain('Glob');
			expect(def.tools).not.toContain('Bash');
		});

		it('does NOT have write or edit tools', () => {
			const def = buildPlannerFactCheckerAgentDef();
			expect(def.tools).not.toContain('Write');
			expect(def.tools).not.toContain('Edit');
		});

		it('does NOT have sub-agent spawning tools', () => {
			const def = buildPlannerFactCheckerAgentDef();
			expect(def.tools).not.toContain('Task');
			expect(def.tools).not.toContain('TaskOutput');
			expect(def.tools).not.toContain('TaskStop');
		});

		it('uses inherit model', () => {
			const def = buildPlannerFactCheckerAgentDef();
			expect(def.model).toBe('inherit');
		});

		it('prompt instructs to return ---FACT_CHECK_RESULT--- block', () => {
			const def = buildPlannerFactCheckerAgentDef();
			expect(def.prompt).toContain('---FACT_CHECK_RESULT---');
			expect(def.prompt).toContain('---END_FACT_CHECK_RESULT---');
		});

		it('prompt includes all required sections in fact-check block', () => {
			const def = buildPlannerFactCheckerAgentDef();
			expect(def.prompt).toContain('Validated Assumptions');
			expect(def.prompt).toContain('Flagged Issues');
			expect(def.prompt).toContain('Recommended Versions/Patterns');
			expect(def.prompt).toContain('Corrections to Explorer Findings');
		});

		it('prompt instructs not to read local files', () => {
			const def = buildPlannerFactCheckerAgentDef();
			expect(def.prompt).toContain('Do NOT read any local files');
		});

		it('prompt instructs not to spawn sub-agents', () => {
			const def = buildPlannerFactCheckerAgentDef();
			expect(def.prompt).toContain('Do NOT spawn');
		});

		it('prompt instructs to use explorer findings as input', () => {
			const def = buildPlannerFactCheckerAgentDef();
			expect(def.prompt).toContain('explorer findings');
		});
	});

	describe('createPlannerAgentInit', () => {
		it('should always use agent/agents pattern', () => {
			const init = createPlannerAgentInit(sharedBaseConfig);
			expect(init.agent).toBe('Planner');
			expect(init.agents).toBeDefined();
			expect(init.agents).toHaveProperty('Planner');
		});

		it('agents map includes all 3-stage pipeline sub-agents', () => {
			const init = createPlannerAgentInit(sharedBaseConfig);
			expect(init.agents).toHaveProperty('planner-explorer');
			expect(init.agents).toHaveProperty('planner-fact-checker');
			expect(init.agents).toHaveProperty('plan-writer');
		});

		it('planner-explorer sub-agent has only read-only codebase tools', () => {
			const init = createPlannerAgentInit(sharedBaseConfig);
			const explorer = init.agents?.['planner-explorer'];
			expect(explorer?.tools).toContain('Read');
			expect(explorer?.tools).toContain('Grep');
			expect(explorer?.tools).toContain('Glob');
			expect(explorer?.tools).not.toContain('Write');
			expect(explorer?.tools).not.toContain('Task');
		});

		it('planner-fact-checker sub-agent has only web tools', () => {
			const init = createPlannerAgentInit(sharedBaseConfig);
			const factChecker = init.agents?.['planner-fact-checker'];
			expect(factChecker?.tools).toContain('WebSearch');
			expect(factChecker?.tools).toContain('WebFetch');
			expect(factChecker?.tools).not.toContain('Read');
			expect(factChecker?.tools).not.toContain('Task');
		});

		it('plan-writer agent does NOT have Task tool (cannot spawn sub-agents)', () => {
			const init = createPlannerAgentInit(sharedBaseConfig);
			const planWriter = init.agents?.['plan-writer'];
			expect(planWriter?.tools).not.toContain('Task');
			expect(planWriter?.tools).not.toContain('TaskOutput');
			expect(planWriter?.tools).not.toContain('TaskStop');
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

		it('agents map has exactly 4 entries: Planner + 3 sub-agents', () => {
			const init = createPlannerAgentInit(sharedBaseConfig);
			const keys = Object.keys(init.agents ?? {});
			expect(keys).toHaveLength(4);
			expect(keys).toContain('Planner');
			expect(keys).toContain('planner-explorer');
			expect(keys).toContain('planner-fact-checker');
			expect(keys).toContain('plan-writer');
		});

		it('no sub-agent has Task/TaskOutput/TaskStop (one level max)', () => {
			const init = createPlannerAgentInit(sharedBaseConfig);
			const subAgents = ['planner-explorer', 'planner-fact-checker', 'plan-writer'] as const;
			for (const name of subAgents) {
				const tools = init.agents?.[name]?.tools ?? [];
				expect(tools).not.toContain('Task');
				expect(tools).not.toContain('TaskOutput');
				expect(tools).not.toContain('TaskStop');
			}
		});

		it('planner-explorer uses inherit model', () => {
			const init = createPlannerAgentInit(sharedBaseConfig);
			expect(init.agents?.['planner-explorer']?.model).toBe('inherit');
		});

		it('planner-fact-checker uses inherit model', () => {
			const init = createPlannerAgentInit(sharedBaseConfig);
			expect(init.agents?.['planner-fact-checker']?.model).toBe('inherit');
		});

		it('MCP server config contains only planner-tools (no extra servers)', () => {
			const init = createPlannerAgentInit(sharedBaseConfig);
			const mcpKeys = Object.keys(init.mcpServers ?? {});
			expect(mcpKeys).toHaveLength(1);
			expect(mcpKeys).toContain('planner-tools');
		});
	});
});
