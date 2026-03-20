/**
 * Unit tests for selectWorkflow()
 *
 * Covers all priority chain levels:
 *   1. Explicit workflowId → use it
 *   2. Tag-based matching
 *   3. Keyword/description matching
 *   4. Null fallback (no match)
 *
 * selectWorkflow() is a pure function: no DB, no managers.
 */

import { describe, test, expect } from 'bun:test';
import { selectWorkflow } from '../../../src/lib/space/runtime/workflow-selector.ts';
import type { WorkflowSelectionContext } from '../../../src/lib/space/runtime/workflow-selector.ts';
import type { SpaceWorkflow } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

let idCounter = 0;
function makeId(): string {
	return `wf-${++idCounter}`;
}

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
	const id = makeId();
	return {
		id,
		spaceId: 'space-1',
		name: `Workflow ${id}`,
		description: '',
		steps: [],
		transitions: [],
		startStepId: 'step-1',
		rules: [],
		tags: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeContext(overrides: Partial<WorkflowSelectionContext> = {}): WorkflowSelectionContext {
	return {
		spaceId: 'space-1',
		title: '',
		description: '',
		availableWorkflows: [],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Priority 1: Explicit workflowId
// ---------------------------------------------------------------------------

describe('selectWorkflow — explicit workflowId', () => {
	test('returns the workflow with the matching id', () => {
		const wf1 = makeWorkflow({ id: 'wf-explicit-1' });
		const wf2 = makeWorkflow({ id: 'wf-explicit-2' });
		const ctx = makeContext({
			workflowId: 'wf-explicit-1',
			availableWorkflows: [wf1, wf2],
		});
		expect(selectWorkflow(ctx)).toBe(wf1);
	});

	test('explicit wins over tag match', () => {
		const wfTagMatch = makeWorkflow({ id: 'wf-tag', tags: ['coding'] });
		const wfExplicit = makeWorkflow({ id: 'wf-explicit-3' });
		const ctx = makeContext({
			title: 'build a coding feature',
			workflowId: 'wf-explicit-3',
			availableWorkflows: [wfTagMatch, wfExplicit],
		});
		expect(selectWorkflow(ctx)).toBe(wfExplicit);
	});

	test('explicit wins over description keyword match', () => {
		const wfDesc = makeWorkflow({ id: 'wf-desc', description: 'research and analyze data' });
		const wfExplicit = makeWorkflow({ id: 'wf-explicit-4' });
		const ctx = makeContext({
			title: 'research and analyze data',
			workflowId: 'wf-explicit-4',
			availableWorkflows: [wfDesc, wfExplicit],
		});
		expect(selectWorkflow(ctx)).toBe(wfExplicit);
	});

	test('returns null when explicit id not found in availableWorkflows', () => {
		const wf = makeWorkflow({ id: 'wf-other' });
		const ctx = makeContext({
			workflowId: 'wf-missing',
			availableWorkflows: [wf],
		});
		expect(selectWorkflow(ctx)).toBeNull();
	});

	test('does NOT fall through to heuristics when explicit id is not found', () => {
		// Even if a tag would have matched, explicit missing → null (not fallthrough)
		const wfTag = makeWorkflow({ id: 'wf-tag2', tags: ['coding'] });
		const ctx = makeContext({
			title: 'coding task',
			workflowId: 'wf-does-not-exist',
			availableWorkflows: [wfTag],
		});
		expect(selectWorkflow(ctx)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Priority 2: Tag-based matching
// ---------------------------------------------------------------------------

describe('selectWorkflow — tag matching', () => {
	test('matches a workflow whose tags include a keyword from title', () => {
		const wfCoding = makeWorkflow({ id: 'wf-coding', tags: ['coding', 'default'] });
		const wfResearch = makeWorkflow({ id: 'wf-research', tags: ['research'] });
		const ctx = makeContext({
			title: 'implement a coding feature',
			availableWorkflows: [wfCoding, wfResearch],
		});
		expect(selectWorkflow(ctx)).toBe(wfCoding);
	});

	test('matches a workflow whose tags include a keyword from description', () => {
		const wfResearch = makeWorkflow({ id: 'wf-research2', tags: ['research'] });
		const wfCoding = makeWorkflow({ id: 'wf-coding2', tags: ['coding'] });
		const ctx = makeContext({
			title: 'new initiative',
			description: 'we need to research the market',
			availableWorkflows: [wfCoding, wfResearch],
		});
		expect(selectWorkflow(ctx)).toBe(wfResearch);
	});

	test('picks the workflow with most tag matches', () => {
		const wfA = makeWorkflow({ id: 'wf-a', tags: ['coding'] });
		const wfB = makeWorkflow({ id: 'wf-b', tags: ['coding', 'review'] });
		const ctx = makeContext({
			title: 'code review needed',
			description: 'coding and review',
			availableWorkflows: [wfA, wfB],
		});
		// wfB matches both 'coding' and 'review' keywords
		expect(selectWorkflow(ctx)).toBe(wfB);
	});

	test('tag matching is case-insensitive', () => {
		const wf = makeWorkflow({ id: 'wf-ci', tags: ['CODING'] });
		const ctx = makeContext({
			title: 'coding task',
			availableWorkflows: [wf],
		});
		expect(selectWorkflow(ctx)).toBe(wf);
	});

	test('skips workflows with empty tags for tag matching', () => {
		const wfNoTags = makeWorkflow({ id: 'wf-notags', tags: [] });
		const wfWithTags = makeWorkflow({ id: 'wf-withtags', tags: ['coding'] });
		const ctx = makeContext({
			title: 'coding task',
			availableWorkflows: [wfNoTags, wfWithTags],
		});
		expect(selectWorkflow(ctx)).toBe(wfWithTags);
	});
});

// ---------------------------------------------------------------------------
// Priority 3: Description keyword matching
// ---------------------------------------------------------------------------

describe('selectWorkflow — description keyword matching', () => {
	test('matches workflow whose description contains words from the input title', () => {
		const wfResearch = makeWorkflow({
			id: 'wf-res',
			tags: [],
			description: 'perform research and gather information',
		});
		const wfCoding = makeWorkflow({
			id: 'wf-cod',
			tags: [],
			description: 'write and review code changes',
		});
		const ctx = makeContext({
			title: 'need to gather research information',
			availableWorkflows: [wfCoding, wfResearch],
		});
		// 'research', 'gather', 'information' appear in wfResearch description
		expect(selectWorkflow(ctx)).toBe(wfResearch);
	});

	test('picks the workflow with more description words matching the input', () => {
		const wfA = makeWorkflow({
			id: 'wf-kwa',
			tags: [],
			description: 'design user interface components',
		});
		const wfB = makeWorkflow({
			id: 'wf-kwb',
			tags: [],
			description: 'design and prototype user interface layouts and components',
		});
		const ctx = makeContext({
			title: 'design user interface and components',
			availableWorkflows: [wfA, wfB],
		});
		// wfB has more overlapping words
		expect(selectWorkflow(ctx)).toBe(wfB);
	});

	test('skips workflows with empty description', () => {
		const wfEmpty = makeWorkflow({ id: 'wf-empty-desc', description: '', tags: [] });
		const wfDesc = makeWorkflow({
			id: 'wf-has-desc',
			description: 'build and test features',
			tags: [],
		});
		const ctx = makeContext({
			title: 'build new features',
			availableWorkflows: [wfEmpty, wfDesc],
		});
		expect(selectWorkflow(ctx)).toBe(wfDesc);
	});

	test('tag matching takes priority over description matching', () => {
		const wfTagOnly = makeWorkflow({ id: 'wf-tag-only', tags: ['coding'], description: '' });
		const wfDescOnly = makeWorkflow({
			id: 'wf-desc-only',
			tags: [],
			description: 'implement code features for this project',
		});
		const ctx = makeContext({
			title: 'implement coding features',
			availableWorkflows: [wfDescOnly, wfTagOnly],
		});
		// Tag match should win over description match
		expect(selectWorkflow(ctx)).toBe(wfTagOnly);
	});
});

// ---------------------------------------------------------------------------
// Priority 4: Null fallback
// ---------------------------------------------------------------------------

describe('selectWorkflow — null fallback', () => {
	test('returns null when no workflows are available', () => {
		const ctx = makeContext({ title: 'do something', availableWorkflows: [] });
		expect(selectWorkflow(ctx)).toBeNull();
	});

	test('returns null when no workflow tags or descriptions match', () => {
		const wf = makeWorkflow({
			id: 'wf-nomatch',
			tags: ['xyz'],
			description: 'completely unrelated',
		});
		const ctx = makeContext({
			title: 'aardvark quantum physics',
			description: 'something with no overlap',
			availableWorkflows: [wf],
		});
		// 'aardvark' and 'quantum' don't appear in tags or description words
		// 'something' may match 'something' but let's use truly unrelated words
		// Actually 'unrelated', 'completely' might match from description — let's use safer input
		const ctx2 = makeContext({
			title: 'zymurgy nomenclature',
			description: 'foobarbaz quux',
			availableWorkflows: [wf],
		});
		expect(selectWorkflow(ctx2)).toBeNull();
	});

	test('returns null when all workflows have no tags and no descriptions', () => {
		const wf1 = makeWorkflow({ id: 'wf-bare1', tags: [], description: '' });
		const wf2 = makeWorkflow({ id: 'wf-bare2', tags: [], description: '' });
		const ctx = makeContext({
			title: 'any title',
			description: 'any description',
			availableWorkflows: [wf1, wf2],
		});
		expect(selectWorkflow(ctx)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('selectWorkflow — edge cases', () => {
	test('handles empty title and description with tag match', () => {
		const wf = makeWorkflow({ id: 'wf-emptyinput', tags: ['default'] });
		const ctx = makeContext({ title: '', description: '', availableWorkflows: [wf] });
		// No keywords → no tag match
		expect(selectWorkflow(ctx)).toBeNull();
	});

	test('handles single character words (filtered out)', () => {
		const wf = makeWorkflow({ id: 'wf-shortwords', tags: ['a', 'b', 'coding'] });
		const ctx = makeContext({
			title: 'a b coding',
			availableWorkflows: [wf],
		});
		// 'a' and 'b' are 1 char (filtered), 'coding' is 6 chars → matches
		expect(selectWorkflow(ctx)).toBe(wf);
	});

	test('is deterministic — same input always returns same output', () => {
		const workflows = [
			makeWorkflow({ id: 'wf-det1', tags: ['alpha'] }),
			makeWorkflow({ id: 'wf-det2', tags: ['beta', 'coding'] }),
			makeWorkflow({ id: 'wf-det3', tags: ['coding'] }),
		];
		const ctx = makeContext({ title: 'alpha beta coding', availableWorkflows: workflows });
		const first = selectWorkflow(ctx);
		const second = selectWorkflow(ctx);
		expect(first).toBe(second);
	});
});
