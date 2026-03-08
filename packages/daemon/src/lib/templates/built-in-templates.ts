/**
 * Built-in Session/Room Templates
 *
 * Seeded into the database on first run. Users cannot delete built-in templates.
 */

import type { SessionTemplate } from '@neokai/shared';

const now = Date.now();

export const BUILT_IN_TEMPLATES: SessionTemplate[] = [
	{
		id: 'builtin:bug-fix',
		name: 'Bug Fix',
		description: 'Reproduce and fix a bug with automated verification.',
		scope: 'session',
		config: {
			systemPrompt: [
				'Reproduce and fix the following bug:',
				'{{description}}',
				'',
				'After fixing:',
				'1. Ensure related tests pass',
				'2. No TypeScript type errors',
				'3. No lint errors',
			].join('\n'),
		},
		variables: [
			{
				name: 'description',
				label: 'Bug Description',
				type: 'textarea',
				required: true,
			},
		],
		builtIn: true,
		createdAt: now,
		updatedAt: now,
	},
	{
		id: 'builtin:code-review',
		name: 'Code Review',
		description: 'Review code changes for correctness, security, and quality.',
		scope: 'session',
		config: {
			systemPrompt: [
				'Review the following changes: {{target}}',
				'',
				'Focus on: correctness, security, performance, readability.',
				'Provide actionable feedback with specific file and line references.',
			].join('\n'),
		},
		variables: [
			{
				name: 'target',
				label: 'PR URL or branch name',
				type: 'text',
				required: true,
			},
		],
		builtIn: true,
		createdAt: now,
		updatedAt: now,
	},
	{
		id: 'builtin:refactor',
		name: 'Refactor',
		description: 'Refactor code while preserving behavior.',
		scope: 'session',
		config: {
			systemPrompt: [
				'Refactor the following code: {{target}}',
				'',
				'Goal: {{goal}}',
				'',
				'Ensure all existing tests still pass after refactoring.',
				'Do not change external behavior.',
			].join('\n'),
		},
		variables: [
			{
				name: 'target',
				label: 'File or module to refactor',
				type: 'text',
				required: true,
			},
			{
				name: 'goal',
				label: 'Refactoring goal',
				type: 'textarea',
				required: true,
				default: 'Improve readability and reduce complexity',
			},
		],
		builtIn: true,
		createdAt: now,
		updatedAt: now,
	},
	{
		id: 'builtin:feature-room',
		name: 'Feature Development',
		description: 'Multi-agent room for developing a new feature.',
		scope: 'room',
		config: {
			systemPrompt: 'You are a feature development team. Goal: {{goal}}',
		},
		roomConfig: {
			maxConcurrentGroups: 2,
			maxFeedbackIterations: 3,
			retryPolicy: 'auto',
			maxRetries: 2,
		},
		variables: [
			{
				name: 'goal',
				label: 'Feature goal',
				type: 'textarea',
				required: true,
			},
		],
		builtIn: true,
		createdAt: now,
		updatedAt: now,
	},
	{
		id: 'builtin:test-writing',
		name: 'Write Tests',
		description: 'Write tests for existing code.',
		scope: 'session',
		config: {
			systemPrompt: [
				'Write comprehensive tests for: {{target}}',
				'',
				'Requirements:',
				'- Cover happy path, edge cases, and error conditions',
				'- Follow existing test patterns in the codebase',
				'- Ensure all tests pass',
			].join('\n'),
		},
		variables: [
			{
				name: 'target',
				label: 'Code to test (file, module, or function)',
				type: 'text',
				required: true,
			},
		],
		builtIn: true,
		createdAt: now,
		updatedAt: now,
	},
];
