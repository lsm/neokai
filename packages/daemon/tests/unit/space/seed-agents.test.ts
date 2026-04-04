/**
 * seedPresetAgents Unit Tests
 *
 * Verifies that the six preset SpaceAgent records are created with correct
 * defaults (role, tools, description) and that seeding is idempotent (errors
 * on name collision are captured but do not abort remaining seeds).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SpaceAgentRepository } from '../../../src/storage/repositories/space-agent-repository';
import { SpaceAgentManager } from '../../../src/lib/space/managers/space-agent-manager';
import {
	seedPresetAgents,
	ROLE_TOOLS,
	SUB_SESSION_FEATURES,
	getPresetAgentTemplates,
} from '../../../src/lib/space/agents/seed-agents';
import { KNOWN_TOOLS } from '@neokai/shared';
import { setModelsCache } from '../../../src/lib/model-service';
import { createSpaceAgentSchema, insertSpace } from '../helpers/space-agent-schema';

describe('seedPresetAgents', () => {
	let db: Database;
	let manager: SpaceAgentManager;

	beforeEach(() => {
		db = new Database(':memory:');
		createSpaceAgentSchema(db);
		insertSpace(db);
		const repo = new SpaceAgentRepository(db as any);
		manager = new SpaceAgentManager(repo);
		setModelsCache(new Map()); // skip model validation
	});

	afterEach(() => {
		db.close();
		setModelsCache(new Map());
	});

	it('creates exactly six preset agents', async () => {
		const result = await seedPresetAgents('space-1', manager);

		expect(result.seeded).toHaveLength(6);
		expect(result.errors).toHaveLength(0);
	});

	it('creates agents with correct roles', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);

		const names = seeded.map((a) => a.name.toLowerCase()).sort();
		expect(names).toEqual(['coder', 'general', 'planner', 'qa', 'research', 'reviewer']);
	});

	it('creates agents with correct names', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);

		const names = seeded.map((a) => a.name).sort();
		expect(names).toEqual(['Coder', 'General', 'Planner', 'QA', 'Research', 'Reviewer']);
	});

	it('sets tools on each preset agent', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);

		for (const agent of seeded) {
			expect(Array.isArray(agent.tools)).toBe(true);
			expect((agent.tools?.length ?? 0) > 0).toBe(true);
		}
	});

	it('reviewer has restricted tools (no Write or Edit)', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const reviewer = seeded.find((a) => a.name === 'Reviewer');

		expect(reviewer).toBeDefined();
		expect(reviewer?.tools).not.toContain('Write');
		expect(reviewer?.tools).not.toContain('Edit');
		expect(reviewer?.tools).toContain('Read');
		expect(reviewer?.tools).toContain('Bash');
	});

	it('coder has full coding toolset', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const coder = seeded.find((a) => a.name === 'Coder');

		expect(coder?.tools).toContain('Read');
		expect(coder?.tools).toContain('Write');
		expect(coder?.tools).toContain('Edit');
		expect(coder?.tools).toContain('Bash');
	});

	it('research agent has full coding toolset (Write + Edit for committing findings)', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const research = seeded.find((a) => a.name === 'Research');

		expect(research?.tools).toContain('Read');
		expect(research?.tools).toContain('Write');
		expect(research?.tools).toContain('Edit');
		expect(research?.tools).toContain('Bash');
	});

	it('sets descriptions on all preset agents', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);

		for (const agent of seeded) {
			expect(typeof agent.description).toBe('string');
			expect((agent.description?.length ?? 0) > 0).toBe(true);
		}
	});

	it('assigns agents to the correct spaceId', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);

		for (const agent of seeded) {
			expect(agent.spaceId).toBe('space-1');
		}
	});

	it('is idempotent — records errors but seeds remaining agents on name collision', async () => {
		// Seed once
		await seedPresetAgents('space-1', manager);

		// Seed again — all six names are now taken
		const second = await seedPresetAgents('space-1', manager);

		expect(second.seeded).toHaveLength(0);
		expect(second.errors).toHaveLength(6);
		for (const err of second.errors) {
			expect(err.error).toMatch(/already exists/i);
		}
	});

	it('seeds different spaces independently', async () => {
		insertSpace(db, 'space-2');

		const r1 = await seedPresetAgents('space-1', manager);
		const r2 = await seedPresetAgents('space-2', manager);

		expect(r1.seeded).toHaveLength(6);
		expect(r2.seeded).toHaveLength(6);
		expect(r1.errors).toHaveLength(0);
		expect(r2.errors).toHaveLength(0);

		// Each space has its own independent set
		for (const a of r1.seeded) expect(a.spaceId).toBe('space-1');
		for (const a of r2.seeded) expect(a.spaceId).toBe('space-2');
	});

	it('partial collision — seeds succeed for non-conflicting names', async () => {
		// Pre-create just the 'Coder' agent
		await manager.create({ spaceId: 'space-1', name: 'Coder' });

		const result = await seedPresetAgents('space-1', manager);

		// Coder fails, others succeed
		expect(result.seeded).toHaveLength(5);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].name).toBe('Coder');
	});

	it('General agent has full coding toolset', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const general = seeded.find((a) => a.name === 'General');

		expect(general).toBeDefined();
		expect(general?.tools).toContain('Read');
		expect(general?.tools).toContain('Write');
		expect(general?.tools).toContain('Edit');
		expect(general?.tools).toContain('Bash');
		expect(general?.tools).toContain('Grep');
		expect(general?.tools).toContain('Glob');
	});

	it('QA agent has restricted tools (no Write or Edit)', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const qa = seeded.find((a) => a.name === 'QA');

		expect(qa).toBeDefined();
		expect(qa?.tools).not.toContain('Write');
		expect(qa?.tools).not.toContain('Edit');
		expect(qa?.tools).toContain('Read');
		expect(qa?.tools).toContain('Bash');
		expect(qa?.tools).toContain('Grep');
		expect(qa?.tools).toContain('Glob');
	});

	it('all preset agents have a non-empty system prompt', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);

		for (const agent of seeded) {
			expect(typeof agent.systemPrompt).toBe('string');
			expect(agent.systemPrompt?.length ?? 0).toBeGreaterThan(0);
		}
	});

	it('all preset agents have non-empty instructions', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);

		for (const agent of seeded) {
			expect(typeof agent.instructions).toBe('string');
			expect(agent.instructions?.length ?? 0).toBeGreaterThan(0);
		}
	});

	it('Coder system prompt mentions code and PR', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const coder = seeded.find((a) => a.name === 'Coder');

		expect(coder?.systemPrompt).toContain('software engineer');
		expect(coder?.systemPrompt).toContain('commit');
		expect(coder?.instructions).toContain('PR');
	});

	it('Research system prompt mentions investigation and findings', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const research = seeded.find((a) => a.name === 'Research');

		expect(research?.systemPrompt).toContain('research specialist');
		expect(research?.instructions).toContain('markdown');
		expect(research?.instructions).toContain('PR');
	});

	it('Reviewer system prompt mentions code review', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const reviewer = seeded.find((a) => a.name === 'Reviewer');

		expect(reviewer?.systemPrompt).toContain('code reviewer');
		expect(reviewer?.instructions).toContain('specific feedback');
	});

	it('Planner system prompt mentions planning', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const planner = seeded.find((a) => a.name === 'Planner');

		expect(planner?.systemPrompt).toContain('project manager');
		expect(planner?.instructions).toContain('plan');
	});

	it('QA system prompt mentions quality assurance', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const qa = seeded.find((a) => a.name === 'QA');

		expect(qa?.systemPrompt).toContain('quality assurance');
		expect(qa?.instructions).toContain('test suite');
	});

	it('General system prompt mentions versatile development', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const general = seeded.find((a) => a.name === 'General');

		expect(general?.systemPrompt).toContain('versatile');
		expect(general?.instructions).toContain('implement');
	});
});

// ---------------------------------------------------------------------------
// Exact tool sets, system prompts, instructions, and exports
// ---------------------------------------------------------------------------

describe('preset agent exact definitions', () => {
	let db: Database;
	let manager: SpaceAgentManager;

	beforeEach(() => {
		db = new Database(':memory:');
		createSpaceAgentSchema(db);
		insertSpace(db);
		const repo = new SpaceAgentRepository(db as any);
		manager = new SpaceAgentManager(repo);
		setModelsCache(new Map());
	});

	afterEach(() => {
		db.close();
		setModelsCache(new Map());
	});

	// --- Exact tool sets ---

	const EXPECTED_CODER_TOOLS = KNOWN_TOOLS.filter(
		(t) => !['Task', 'TaskOutput', 'TaskStop'].includes(t)
	) as unknown as string[];

	const EXPECTED_READONLY_TOOLS = ['Read', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];

	it('Coder has exact CODER_TOOLS (KNOWN_TOOLS minus Task/TaskOutput/TaskStop)', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const coder = seeded.find((a) => a.name === 'Coder')!;
		expect(coder.tools).toEqual(EXPECTED_CODER_TOOLS);
	});

	it('Coder tools exclude Task, TaskOutput, TaskStop', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const coder = seeded.find((a) => a.name === 'Coder')!;
		expect(coder.tools).not.toContain('Task');
		expect(coder.tools).not.toContain('TaskOutput');
		expect(coder.tools).not.toContain('TaskStop');
	});

	it('General has exact GENERAL_TOOLS (same as CODER_TOOLS)', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const general = seeded.find((a) => a.name === 'General')!;
		expect(general.tools).toEqual(EXPECTED_CODER_TOOLS);
	});

	it('Planner has exact PLANNER_TOOLS (same as CODER_TOOLS)', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const planner = seeded.find((a) => a.name === 'Planner')!;
		expect(planner.tools).toEqual(EXPECTED_CODER_TOOLS);
	});

	it('Research has exact RESEARCH_TOOLS (same as CODER_TOOLS)', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const research = seeded.find((a) => a.name === 'Research')!;
		expect(research.tools).toEqual(EXPECTED_CODER_TOOLS);
	});

	it('Reviewer has exact REVIEWER_TOOLS', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const reviewer = seeded.find((a) => a.name === 'Reviewer')!;
		expect(reviewer.tools).toEqual(EXPECTED_READONLY_TOOLS);
	});

	it('QA has exact QA_TOOLS', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const qa = seeded.find((a) => a.name === 'QA')!;
		expect(qa.tools).toEqual(EXPECTED_READONLY_TOOLS);
	});

	// --- Exact system prompts ---

	it('Coder has exact system prompt', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const coder = seeded.find((a) => a.name === 'Coder')!;
		expect(coder.systemPrompt).toBe(
			'You are an expert software engineer. You write clean, well-tested code following the ' +
				"project's existing conventions. You always commit your work, keep the working tree clean, " +
				'and open pull requests for review.'
		);
	});

	it('General has exact system prompt', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const general = seeded.find((a) => a.name === 'General')!;
		expect(general.systemPrompt).toBe(
			'You are a versatile software development assistant. You can write code, fix bugs, write documentation, ' +
				'analyze problems, and handle any general development task. You adapt to what is needed.'
		);
	});

	it('Planner has exact system prompt', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const planner = seeded.find((a) => a.name === 'Planner')!;
		expect(planner.systemPrompt).toBe(
			'You are a technical project manager. You analyze goals, break them down into clear actionable ' +
				'tasks, identify dependencies, and produce structured implementation plans.'
		);
	});

	it('Research has exact system prompt', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const research = seeded.find((a) => a.name === 'Research')!;
		expect(research.systemPrompt).toBe(
			'You are a research specialist. You investigate topics thoroughly using web search and code ' +
				'exploration, synthesize findings clearly, and document results in well-structured markdown files.'
		);
	});

	it('Reviewer has exact system prompt', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const reviewer = seeded.find((a) => a.name === 'Reviewer')!;
		expect(reviewer.systemPrompt).toBe(
			'You are an expert code reviewer. You review pull requests for correctness, security, performance, ' +
				'style, and test coverage. You give specific, actionable feedback.'
		);
	});

	it('QA has exact system prompt', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const qa = seeded.find((a) => a.name === 'QA')!;
		expect(qa.systemPrompt).toBe(
			'You are a quality assurance engineer. You verify test coverage, run test suites, check CI status, ' +
				'and ensure the codebase meets quality standards before release.'
		);
	});

	// --- Exact instructions ---

	it('Coder has exact instructions', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const coder = seeded.find((a) => a.name === 'Coder')!;
		expect(coder.instructions).toBe(
			'Before finishing: ensure all tests pass, commit all changes, and open a PR with a clear description.'
		);
	});

	it('General has exact instructions', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const general = seeded.find((a) => a.name === 'General')!;
		expect(general.instructions).toBe(
			'Understand the task, implement the solution, verify it works, and commit your changes.'
		);
	});

	it('Planner has exact instructions', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const planner = seeded.find((a) => a.name === 'Planner')!;
		expect(planner.instructions).toBe(
			'Produce a concrete plan with clear steps. Write the plan to a file and commit it.'
		);
	});

	it('Research has exact instructions', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const research = seeded.find((a) => a.name === 'Research')!;
		expect(research.instructions).toBe(
			'Save all findings to a markdown file, commit the file, and open a PR with a summary of what you found.'
		);
	});

	it('Reviewer has exact instructions', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const reviewer = seeded.find((a) => a.name === 'Reviewer')!;
		expect(reviewer.instructions).toBe(
			'Review the code thoroughly. If satisfied, summarize your findings. If changes are needed, provide ' +
				'specific feedback.'
		);
	});

	it('QA has exact instructions', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const qa = seeded.find((a) => a.name === 'QA')!;
		expect(qa.instructions).toBe(
			'Run the full test suite and report results with specific details on any failures.'
		);
	});

	// --- Exact descriptions ---

	it('each agent has the exact description from PRESET_AGENTS', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);

		const expected: Record<string, string> = {
			Coder:
				'Implementation worker. Writes code, runs tests, commits changes, and opens pull requests.',
			General:
				'General-purpose worker. Handles a wide range of tasks including coding, documentation, ' +
				'debugging, and analysis.',
			Planner:
				'Planning agent. Breaks down goals into actionable tasks and drafts implementation plans.',
			Research:
				'Research agent. Investigates topics, gathers information, writes findings to docs, and opens pull requests with research results.',
			Reviewer:
				'Code review specialist. Reviews pull requests for correctness, style, and test coverage.',
			QA: 'Quality assurance specialist. Verifies test coverage, runs test suites, and checks CI pipeline status.',
		};

		for (const agent of seeded) {
			expect(agent.description).toBe(expected[agent.name]);
		}
	});
});

// ---------------------------------------------------------------------------
// ROLE_TOOLS export
// ---------------------------------------------------------------------------

describe('ROLE_TOOLS export', () => {
	const EXPECTED_CODER_TOOLS = KNOWN_TOOLS.filter(
		(t) => !['Task', 'TaskOutput', 'TaskStop'].includes(t)
	) as unknown as string[];

	const EXPECTED_READONLY_TOOLS = ['Read', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];

	it('has entries for all 6 preset roles', () => {
		expect(Object.keys(ROLE_TOOLS).sort()).toEqual([
			'coder',
			'general',
			'planner',
			'qa',
			'research',
			'reviewer',
		]);
	});

	it('coder role maps to CODER_TOOLS', () => {
		expect(ROLE_TOOLS.coder).toEqual(EXPECTED_CODER_TOOLS);
	});

	it('general role maps to GENERAL_TOOLS (same as CODER_TOOLS)', () => {
		expect(ROLE_TOOLS.general).toEqual(EXPECTED_CODER_TOOLS);
	});

	it('planner role maps to PLANNER_TOOLS (same as CODER_TOOLS)', () => {
		expect(ROLE_TOOLS.planner).toEqual(EXPECTED_CODER_TOOLS);
	});

	it('research role maps to RESEARCH_TOOLS (same as CODER_TOOLS)', () => {
		expect(ROLE_TOOLS.research).toEqual(EXPECTED_CODER_TOOLS);
	});

	it('reviewer role maps to REVIEWER_TOOLS', () => {
		expect(ROLE_TOOLS.reviewer).toEqual(EXPECTED_READONLY_TOOLS);
	});

	it('qa role maps to QA_TOOLS', () => {
		expect(ROLE_TOOLS.qa).toEqual(EXPECTED_READONLY_TOOLS);
	});

	it('ROLE_TOOLS matches what seedPresetAgents actually seeds', async () => {
		const db = new Database(':memory:');
		createSpaceAgentSchema(db);
		insertSpace(db);
		const repo = new SpaceAgentRepository(db as any);
		const mgr = new SpaceAgentManager(repo);
		setModelsCache(new Map());

		const { seeded } = await seedPresetAgents('space-1', mgr);

		for (const agent of seeded) {
			const roleKey = agent.name.toLowerCase();
			expect(ROLE_TOOLS[roleKey]).toBeDefined();
			expect(agent.tools).toEqual(ROLE_TOOLS[roleKey]);
		}

		db.close();
		setModelsCache(new Map());
	});
});

// ---------------------------------------------------------------------------
// SUB_SESSION_FEATURES export
// ---------------------------------------------------------------------------

describe('SUB_SESSION_FEATURES export', () => {
	it('has exactly the expected feature flags', () => {
		expect(SUB_SESSION_FEATURES).toEqual({
			rewind: false,
			worktree: false,
			coordinator: false,
			archive: false,
			sessionInfo: false,
		});
	});

	it('all feature values are false', () => {
		for (const [, value] of Object.entries(SUB_SESSION_FEATURES)) {
			expect(value).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// getPresetAgentTemplates export
// ---------------------------------------------------------------------------

describe('getPresetAgentTemplates', () => {
	it('returns exactly 6 templates', () => {
		const templates = getPresetAgentTemplates();
		expect(templates).toHaveLength(6);
	});

	it('returns all expected agent names', () => {
		const templates = getPresetAgentTemplates();
		const names = templates.map((t) => t.name).sort();
		expect(names).toEqual(['Coder', 'General', 'Planner', 'QA', 'Research', 'Reviewer']);
	});

	it('each template has name, description, tools, systemPrompt, and instructions', () => {
		const templates = getPresetAgentTemplates();
		for (const t of templates) {
			expect(typeof t.name).toBe('string');
			expect(t.name.length).toBeGreaterThan(0);
			expect(typeof t.description).toBe('string');
			expect(t.description.length).toBeGreaterThan(0);
			expect(Array.isArray(t.tools)).toBe(true);
			expect(t.tools.length).toBeGreaterThan(0);
			expect(typeof t.systemPrompt).toBe('string');
			expect(t.systemPrompt.length).toBeGreaterThan(0);
			expect(typeof t.instructions).toBe('string');
			expect(t.instructions.length).toBeGreaterThan(0);
		}
	});

	it('returns cloned arrays — mutating tools does not affect globals', () => {
		const first = getPresetAgentTemplates();
		const coderTools = first.find((t) => t.name === 'Coder')!.tools;
		coderTools.push('FakeTool');

		const second = getPresetAgentTemplates();
		const coderTools2 = second.find((t) => t.name === 'Coder')!.tools;
		expect(coderTools2).not.toContain('FakeTool');
	});

	it('template tools match ROLE_TOOLS', () => {
		const templates = getPresetAgentTemplates();
		for (const t of templates) {
			const roleKey = t.name.toLowerCase();
			expect(t.tools).toEqual(ROLE_TOOLS[roleKey]);
		}
	});
});
