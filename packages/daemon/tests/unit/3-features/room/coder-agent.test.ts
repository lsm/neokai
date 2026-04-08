import { describe, expect, it } from 'bun:test';
import {
	buildCoderExplorerAgentDef,
	buildCoderHelperAgentPrompt,
	buildCoderSystemPrompt,
	buildCoderTaskMessage,
	buildTesterAgentDef,
	buildWorkerHelperAgents,
	createCoderAgentInit,
	getWorkerSubagents,
	type CoderAgentConfig,
} from '../../../../src/lib/room/agents/coder-agent';
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
			expect(prompt).toContain('Do NOT commit directly to the main/dev branch');
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

		it('checks for existing PR before creating to avoid duplicates', () => {
			const prompt = buildCoderSystemPrompt();
			// Step 5 should check for an existing PR first
			expect(prompt).toContain('EXISTING_PR=$(gh pr list --head');
			expect(prompt).toContain('--state open --json url --jq');
			// Uses `// empty` to convert jq null output to empty string (avoids the "null" string bug)
			expect(prompt).toContain('// empty');
			expect(prompt).toContain('if [ -z "$EXISTING_PR" ]');
			// Only create PR when none exists
			expect(prompt).toContain('gh pr create --fill --base');
			// Acknowledge when PR already exists
			expect(prompt).toContain('PR already exists');
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

		it('always includes sub-agent usage section even without custom helpers', () => {
			const prompt = buildCoderSystemPrompt();
			expect(prompt).toContain('Sub-Agent Usage');
			expect(prompt).toContain('coder-tester');
			expect(prompt).toContain('coder-explorer');
		});

		it('always includes coder-tester instructions with TEST_RESULT block reference', () => {
			const prompt = buildCoderSystemPrompt();
			expect(prompt).toContain('coder-tester');
			expect(prompt).toContain('---TEST_RESULT---');
		});

		it('always includes coder-explorer instructions with EXPLORE_RESULT block reference', () => {
			const prompt = buildCoderSystemPrompt();
			expect(prompt).toContain('coder-explorer');
			expect(prompt).toContain('---EXPLORE_RESULT---');
		});

		it('always includes task complexity strategy guidance', () => {
			const prompt = buildCoderSystemPrompt();
			expect(prompt).toContain('Simple tasks');
			expect(prompt).toContain('Complex tasks');
			expect(prompt).toContain('Large multi-component tasks');
		});

		it('strategy guidance includes concrete examples for each complexity level', () => {
			const prompt = buildCoderSystemPrompt();
			// Simple example
			expect(prompt).toContain('fix typo in error message');
			// Complex example
			expect(prompt).toContain('refactor session cleanup logic');
			// Large example
			expect(prompt).toContain('WebSocket reconnection');
		});

		it('does NOT include custom helpers section when no custom helpers provided', () => {
			const prompt = buildCoderSystemPrompt();
			expect(prompt).not.toContain('Custom helpers:');
		});

		it('includes custom helpers section when custom helper names provided', () => {
			const prompt = buildCoderSystemPrompt(['helper-haiku', 'helper-sonnet']);
			expect(prompt).toContain('Custom helpers: helper-haiku, helper-sonnet');
			expect(prompt).toContain('---SUBTASK_RESULT---');
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

		it('should include existing PR URL when task has prUrl', () => {
			const message = buildCoderTaskMessage(
				makeConfig({
					task: makeTask({ prUrl: 'https://github.com/org/repo/pull/42' }),
				})
			);
			expect(message).toContain('https://github.com/org/repo/pull/42');
			expect(message).toContain('Existing Pull Request');
			// Should say "existing" not "open" — prUrl may be closed
			expect(message).toContain('existing pull request');
			expect(message).not.toContain('open pull request');
			expect(message).toContain('do NOT create a new one');
		});

		it('should omit existing PR section when task has no prUrl', () => {
			const message = buildCoderTaskMessage(makeConfig());
			expect(message).not.toContain('Existing Pull Request');
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

		it('always uses agent/agents pattern even without worker sub-agents configured', () => {
			const init = createCoderAgentInit(makeConfig());
			expect(init.agent).toBe('Coder');
			expect(init.agents).toBeDefined();
		});

		it('uses claude_code preset without append (system prompt is in agent def prompt field)', () => {
			const init = createCoderAgentInit(makeConfig());
			expect(init.systemPrompt).toEqual({
				type: 'preset',
				preset: 'claude_code',
			});
			// No append key — prompt lives in Coder agent def
			expect(init.systemPrompt).not.toHaveProperty('append');
		});

		it('Coder agent def prompt includes git workflow instructions', () => {
			const init = createCoderAgentInit(makeConfig());
			const coderPrompt = init.agents?.['Coder']?.prompt ?? '';
			expect(coderPrompt).toContain('Git Workflow (MANDATORY)');
			// Should NOT contain task-specific content
			expect(coderPrompt).not.toContain('Add GET /health endpoint');
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

		it('always includes Coder in agents map', () => {
			const init = createCoderAgentInit(makeConfig());
			expect(init.agents).toHaveProperty('Coder');
		});

		it('always includes coder-explorer in agents map', () => {
			const init = createCoderAgentInit(makeConfig());
			expect(init.agents).toHaveProperty('coder-explorer');
		});

		it('always includes coder-tester in agents map', () => {
			const init = createCoderAgentInit(makeConfig());
			expect(init.agents).toHaveProperty('coder-tester');
		});

		it('agents map has exactly 3 entries (built-ins only) when no worker sub-agents configured', () => {
			// Verifies the always-on pattern: no conditional branching — Coder, coder-explorer,
			// coder-tester are always present; no extra agents without worker config.
			const init = createCoderAgentInit(makeConfig());
			expect(Object.keys(init.agents ?? {})).toHaveLength(3);
			expect(Object.keys(init.agents ?? {})).toEqual(
				expect.arrayContaining(['Coder', 'coder-explorer', 'coder-tester'])
			);
		});

		it('Coder agent def includes Task, TaskOutput, TaskStop tools', () => {
			const init = createCoderAgentInit(makeConfig());
			const coderDef = init.agents?.['Coder'];
			expect(coderDef?.tools).toContain('Task');
			expect(coderDef?.tools).toContain('TaskOutput');
			expect(coderDef?.tools).toContain('TaskStop');
		});

		it('Coder agent def includes standard coding tools', () => {
			const init = createCoderAgentInit(makeConfig());
			const coderDef = init.agents?.['Coder'];
			expect(coderDef?.tools).toContain('Read');
			expect(coderDef?.tools).toContain('Bash');
			expect(coderDef?.tools).toContain('Edit');
			expect(coderDef?.tools).toContain('Write');
			expect(coderDef?.tools).toContain('Grep');
			expect(coderDef?.tools).toContain('Glob');
		});

		it('Coder agent def includes WebFetch and WebSearch for direct fact-checking', () => {
			const init = createCoderAgentInit(makeConfig());
			const coderDef = init.agents?.['Coder'];
			expect(coderDef?.tools).toContain('WebFetch');
			expect(coderDef?.tools).toContain('WebSearch');
		});

		it('Coder agent def uses inherit model', () => {
			const init = createCoderAgentInit(makeConfig());
			expect(init.agents?.['Coder']?.model).toBe('inherit');
		});

		it('Coder system prompt always includes sub-agent usage section', () => {
			const init = createCoderAgentInit(makeConfig());
			const coderPrompt = init.agents?.['Coder']?.prompt ?? '';
			expect(coderPrompt).toContain('Sub-Agent Usage');
			expect(coderPrompt).toContain('coder-tester');
			expect(coderPrompt).toContain('coder-explorer');
		});

		it('Coder system prompt includes task complexity strategy guidance', () => {
			const init = createCoderAgentInit(makeConfig());
			const coderPrompt = init.agents?.['Coder']?.prompt ?? '';
			expect(coderPrompt).toContain('Simple tasks');
			expect(coderPrompt).toContain('Complex tasks');
			expect(coderPrompt).toContain('Large multi-component tasks');
		});

		it('coder-tester agent has Write and Edit tools', () => {
			const init = createCoderAgentInit(makeConfig());
			const tester = init.agents?.['coder-tester'];
			expect(tester?.tools).toContain('Write');
			expect(tester?.tools).toContain('Edit');
		});

		it('coder-tester agent does NOT have Task tool', () => {
			const init = createCoderAgentInit(makeConfig());
			const tester = init.agents?.['coder-tester'];
			expect(tester?.tools).not.toContain('Task');
		});

		it('coder-tester agent uses inherit model', () => {
			const init = createCoderAgentInit(makeConfig());
			expect(init.agents?.['coder-tester']?.model).toBe('inherit');
		});

		it('coder-explorer agent has only Read, Grep, Glob, Bash tools', () => {
			const init = createCoderAgentInit(makeConfig());
			const explorer = init.agents?.['coder-explorer'];
			expect(explorer?.tools).toContain('Read');
			expect(explorer?.tools).toContain('Grep');
			expect(explorer?.tools).toContain('Glob');
			expect(explorer?.tools).toContain('Bash');
			expect(explorer?.tools).not.toContain('Write');
			expect(explorer?.tools).not.toContain('Edit');
			expect(explorer?.tools).not.toContain('Task');
		});

		it('coder-explorer agent uses inherit model', () => {
			const init = createCoderAgentInit(makeConfig());
			expect(init.agents?.['coder-explorer']?.model).toBe('inherit');
		});

		it('coder-explorer in agents map is the canonical buildCoderExplorerAgentDef() output', () => {
			// Ensures createCoderAgentInit delegates to the builder rather than inlining
			// a different definition — keeps the two in sync.
			const init = createCoderAgentInit(makeConfig());
			const inMap = init.agents?.['coder-explorer'];
			const standalone = buildCoderExplorerAgentDef();
			expect(inMap?.tools).toEqual(standalone.tools);
			expect(inMap?.model).toBe(standalone.model);
			expect(inMap?.prompt).toBe(standalone.prompt);
			expect(inMap?.description).toBe(standalone.description);
		});

		describe('with worker sub-agents configured', () => {
			function makeConfigWithWorkers(workerConfigs = [{ model: 'haiku' }]): CoderAgentConfig {
				return makeConfig({
					room: makeRoom({
						config: {
							agentSubagents: { worker: workerConfigs },
						},
					}),
				});
			}

			it('includes helper agents in agents map alongside built-ins', () => {
				const init = createCoderAgentInit(makeConfigWithWorkers([{ model: 'haiku' }]));
				const agentKeys = Object.keys(init.agents ?? {});
				expect(agentKeys).toContain('Coder');
				expect(agentKeys).toContain('coder-explorer');
				expect(agentKeys).toContain('coder-tester');
				expect(agentKeys.some((k) => k.startsWith('helper-'))).toBe(true);
			});

			it('Coder system prompt includes custom helpers section when helpers configured', () => {
				const init = createCoderAgentInit(makeConfigWithWorkers());
				const coderPrompt = init.agents?.['Coder']?.prompt ?? '';
				expect(coderPrompt).toContain('Custom helpers:');
				expect(coderPrompt).toContain('helper-');
			});

			it('handles multiple worker configs with deduplication', () => {
				const init = createCoderAgentInit(
					makeConfigWithWorkers([{ model: 'haiku' }, { model: 'haiku' }])
				);
				// Filter out built-ins; count only user helper sub-agents
				const keys = Object.keys(init.agents ?? {}).filter(
					(k) => k !== 'Coder' && k !== 'coder-explorer' && k !== 'coder-tester'
				);
				// Two haiku configs should produce unique names
				expect(keys.length).toBe(2);
				expect(new Set(keys).size).toBe(2);
			});

			it('built-in agents are never overwritten by user helpers (helper- prefix ensures no collision)', () => {
				// buildWorkerHelperAgents always prefixes names with `helper-`, so a user
				// helper named 'coder-explorer' produces 'helper-coder-explorer', which cannot
				// overwrite the built-in 'coder-explorer' key. The spread order (built-ins
				// first, helpers last) provides an additional safeguard.
				const init = createCoderAgentInit(
					makeConfigWithWorkers([{ model: 'haiku', name: 'coder-explorer' }])
				);
				const keys = Object.keys(init.agents ?? {});
				// Built-ins are present with their canonical names
				expect(keys).toContain('coder-explorer');
				expect(keys).toContain('coder-tester');
				// User helper gets the helper- prefix, so no collision occurs
				expect(keys).toContain('helper-coder-explorer');
			});
		});
	});

	describe('getWorkerSubagents', () => {
		it('returns undefined when agentSubagents not set', () => {
			expect(getWorkerSubagents({})).toBeUndefined();
		});

		it('returns undefined when worker array is empty', () => {
			expect(getWorkerSubagents({ agentSubagents: { worker: [] } })).toBeUndefined();
		});

		it('returns configs when worker sub-agents are configured', () => {
			const configs = [{ model: 'haiku' }, { model: 'sonnet' }];
			expect(getWorkerSubagents({ agentSubagents: { worker: configs } })).toEqual(configs);
		});

		it('returns undefined when only non-worker keys are set', () => {
			expect(
				getWorkerSubagents({ agentSubagents: { leader: [{ model: 'sonnet' }] } })
			).toBeUndefined();
		});
	});

	describe('buildWorkerHelperAgents', () => {
		it('returns empty map for empty input', () => {
			expect(buildWorkerHelperAgents([])).toEqual({});
		});

		it('creates helper with correct name prefix', () => {
			const agents = buildWorkerHelperAgents([{ model: 'haiku' }]);
			const keys = Object.keys(agents);
			expect(keys.length).toBe(1);
			expect(keys[0]).toMatch(/^helper-/);
		});

		it('creates multiple helpers for multiple configs', () => {
			const agents = buildWorkerHelperAgents([{ model: 'haiku' }, { model: 'sonnet' }]);
			expect(Object.keys(agents).length).toBe(2);
		});

		it('deduplicates names when same model used twice', () => {
			const agents = buildWorkerHelperAgents([{ model: 'haiku' }, { model: 'haiku' }]);
			const keys = Object.keys(agents);
			expect(keys.length).toBe(2);
			expect(new Set(keys).size).toBe(2);
		});

		it('uses custom name from config when provided', () => {
			const agents = buildWorkerHelperAgents([{ model: 'haiku', name: 'analyzer' }]);
			expect(Object.keys(agents)[0]).toBe('helper-analyzer');
		});

		it('helpers do NOT have Task tool (no recursive sub-agents)', () => {
			const agents = buildWorkerHelperAgents([{ model: 'haiku' }]);
			const helper = Object.values(agents)[0];
			expect(helper.tools).not.toContain('Task');
		});

		it('helpers have standard coding tools', () => {
			const agents = buildWorkerHelperAgents([{ model: 'haiku' }]);
			const helper = Object.values(agents)[0];
			expect(helper.tools).toContain('Read');
			expect(helper.tools).toContain('Write');
			expect(helper.tools).toContain('Edit');
			expect(helper.tools).toContain('Bash');
		});

		it('maps opus model to opus tier', () => {
			const agents = buildWorkerHelperAgents([{ model: 'claude-opus-4-6' }]);
			expect(Object.values(agents)[0].model).toBe('opus');
		});

		it('maps haiku model to haiku tier', () => {
			const agents = buildWorkerHelperAgents([{ model: 'haiku' }]);
			expect(Object.values(agents)[0].model).toBe('haiku');
		});
	});

	describe('buildTesterAgentDef', () => {
		it('has Read, Write, Edit, Bash, Grep, Glob tools', () => {
			const def = buildTesterAgentDef();
			expect(def.tools).toContain('Read');
			expect(def.tools).toContain('Write');
			expect(def.tools).toContain('Edit');
			expect(def.tools).toContain('Bash');
			expect(def.tools).toContain('Grep');
			expect(def.tools).toContain('Glob');
		});

		it('does NOT have Task tool (no recursive sub-agents)', () => {
			const def = buildTesterAgentDef();
			expect(def.tools).not.toContain('Task');
		});

		it('uses inherit model', () => {
			const def = buildTesterAgentDef();
			expect(def.model).toBe('inherit');
		});

		it('prompt requires ---TEST_RESULT--- structured output block', () => {
			const def = buildTesterAgentDef();
			expect(def.prompt).toContain('---TEST_RESULT---');
			expect(def.prompt).toContain('---END_TEST_RESULT---');
		});

		it('prompt forbids modifying implementation files', () => {
			const def = buildTesterAgentDef();
			expect(def.prompt).toContain('Do not modify implementation files');
		});

		it('prompt forbids recursive sub-agent spawning', () => {
			const def = buildTesterAgentDef();
			expect(def.prompt).toContain('No sub-agents');
		});

		it('prompt instructs to commit test files to current branch', () => {
			const def = buildTesterAgentDef();
			expect(def.prompt).toContain('current branch');
			expect(def.prompt).toContain('do NOT create new PRs');
		});
	});

	describe('buildCoderExplorerAgentDef', () => {
		it('has Read, Grep, Glob, and Bash tools only', () => {
			const def = buildCoderExplorerAgentDef();
			expect(def.tools).toContain('Read');
			expect(def.tools).toContain('Grep');
			expect(def.tools).toContain('Glob');
			expect(def.tools).toContain('Bash');
			expect(def.tools).toHaveLength(4);
		});

		it('does NOT have Write or Edit tools (read-only)', () => {
			const def = buildCoderExplorerAgentDef();
			expect(def.tools).not.toContain('Write');
			expect(def.tools).not.toContain('Edit');
		});

		it('does NOT have Task tool (no sub-agent spawning)', () => {
			const def = buildCoderExplorerAgentDef();
			expect(def.tools).not.toContain('Task');
		});

		it('does NOT have WebFetch or WebSearch tools (local exploration only)', () => {
			const def = buildCoderExplorerAgentDef();
			expect(def.tools).not.toContain('WebFetch');
			expect(def.tools).not.toContain('WebSearch');
		});

		it('uses inherit model', () => {
			const def = buildCoderExplorerAgentDef();
			expect(def.model).toBe('inherit');
		});

		it('description identifies the agent as read-only codebase explorer', () => {
			const def = buildCoderExplorerAgentDef();
			expect(def.description).toBeTruthy();
			expect(def.description.toLowerCase()).toContain('read-only');
			expect(def.description.toLowerCase()).toContain('codebase');
		});

		it('prompt requires ---EXPLORE_RESULT--- structured output block', () => {
			const def = buildCoderExplorerAgentDef();
			expect(def.prompt).toContain('---EXPLORE_RESULT---');
			expect(def.prompt).toContain('---END_EXPLORE_RESULT---');
		});

		it('prompt includes relevant_files, patterns, dependencies, architecture_notes, findings fields', () => {
			const def = buildCoderExplorerAgentDef();
			expect(def.prompt).toContain('relevant_files');
			expect(def.prompt).toContain('patterns');
			expect(def.prompt).toContain('dependencies');
			expect(def.prompt).toContain('architecture_notes');
			expect(def.prompt).toContain('findings');
		});

		it('prompt explicitly forbids file modifications', () => {
			const def = buildCoderExplorerAgentDef();
			expect(def.prompt).toContain('Read-only');
			expect(def.prompt).toContain('MUST NOT');
		});

		it('prompt explicitly forbids spawning sub-agents', () => {
			const def = buildCoderExplorerAgentDef();
			expect(def.prompt).toContain('No sub-agents');
			expect(def.prompt).toContain('MUST NOT spawn');
		});
	});

	describe('buildCoderHelperAgentPrompt', () => {
		it('instructs helper to commit but NOT create new PRs', () => {
			const prompt = buildCoderHelperAgentPrompt();
			expect(prompt).toContain('current branch');
			expect(prompt).toContain('do NOT create new PRs');
		});

		it('requires SUBTASK_RESULT structured output block', () => {
			const prompt = buildCoderHelperAgentPrompt();
			expect(prompt).toContain('---SUBTASK_RESULT---');
			expect(prompt).toContain('---END_SUBTASK_RESULT---');
		});

		it('forbids recursive sub-agent spawning', () => {
			const prompt = buildCoderHelperAgentPrompt();
			expect(prompt).toContain('No sub-agents');
		});
	});
});
