/**
 * Models Tests
 *
 * Tests for Claude model definitions and utility functions
 */

import { describe, test, expect } from 'bun:test';
import {
	CLAUDE_MODELS,
	DEFAULT_MODEL,
	MODEL_ALIASES,
	getModelInfo,
	isValidModel,
	resolveModelAlias,
	getModelsByFamily,
	formatModelInfo,
	getFormattedModelList,
	type ModelInfo,
} from '../src/models';

describe('CLAUDE_MODELS', () => {
	test('should have at least one model', () => {
		expect(CLAUDE_MODELS.length).toBeGreaterThan(0);
	});

	test('should have valid structure for all models', () => {
		for (const model of CLAUDE_MODELS) {
			expect(model.id).toBeString();
			expect(model.id.length).toBeGreaterThan(0);
			expect(model.name).toBeString();
			expect(model.alias).toBeString();
			expect(['opus', 'sonnet', 'haiku']).toContain(model.family);
			expect(model.contextWindow).toBeNumber();
			expect(model.contextWindow).toBeGreaterThan(0);
			expect(model.description).toBeString();
			expect(model.releaseDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(typeof model.available).toBe('boolean');
		}
	});

	test('should have unique IDs and aliases', () => {
		const ids = CLAUDE_MODELS.map((m) => m.id);
		const aliases = CLAUDE_MODELS.map((m) => m.alias);

		expect(new Set(ids).size).toBe(ids.length);
		expect(new Set(aliases).size).toBe(aliases.length);
	});
});

describe('DEFAULT_MODEL', () => {
	test('should be a valid model ID', () => {
		expect(isValidModel(DEFAULT_MODEL)).toBe(true);
	});

	test('should reference an available model', () => {
		const model = getModelInfo(DEFAULT_MODEL);
		expect(model).toBeDefined();
		expect(model!.available).toBe(true);
	});
});

describe('MODEL_ALIASES', () => {
	test('should have same number of entries as CLAUDE_MODELS', () => {
		expect(MODEL_ALIASES.size).toBe(CLAUDE_MODELS.length);
	});

	test('should map all aliases to valid model IDs', () => {
		for (const [alias, id] of MODEL_ALIASES) {
			expect(alias).toBeString();
			expect(id).toBeString();
			expect(CLAUDE_MODELS.find((m) => m.id === id)).toBeDefined();
		}
	});
});

describe('getModelInfo', () => {
	test('should return model info by exact ID', () => {
		const model = getModelInfo('claude-opus-4-5-20251101');
		expect(model).toBeDefined();
		expect(model!.id).toBe('claude-opus-4-5-20251101');
		expect(model!.family).toBe('opus');
	});

	test('should return model info by alias', () => {
		const model = getModelInfo('sonnet');
		expect(model).toBeDefined();
		expect(model!.family).toBe('sonnet');
	});

	test('should return undefined for invalid ID', () => {
		expect(getModelInfo('invalid-model')).toBeUndefined();
	});

	test('should return undefined for empty string', () => {
		expect(getModelInfo('')).toBeUndefined();
	});
});

describe('isValidModel', () => {
	test('should return true for valid model ID', () => {
		expect(isValidModel('claude-opus-4-5-20251101')).toBe(true);
	});

	test('should return true for valid alias', () => {
		expect(isValidModel('opus')).toBe(true);
		expect(isValidModel('sonnet')).toBe(true);
		expect(isValidModel('haiku')).toBe(true);
	});

	test('should return false for invalid model', () => {
		expect(isValidModel('invalid-model')).toBe(false);
		expect(isValidModel('')).toBe(false);
	});
});

describe('resolveModelAlias', () => {
	test('should resolve alias to full ID', () => {
		const id = resolveModelAlias('opus');
		expect(id).toBe('claude-opus-4-5-20251101');
	});

	test('should return full ID unchanged', () => {
		const id = resolveModelAlias('claude-opus-4-5-20251101');
		expect(id).toBe('claude-opus-4-5-20251101');
	});

	test('should return input unchanged for invalid model', () => {
		const id = resolveModelAlias('invalid-model');
		expect(id).toBe('invalid-model');
	});
});

describe('getModelsByFamily', () => {
	test('should return models grouped by family', () => {
		const grouped = getModelsByFamily();

		expect(grouped).toHaveProperty('opus');
		expect(grouped).toHaveProperty('sonnet');
		expect(grouped).toHaveProperty('haiku');

		expect(Array.isArray(grouped.opus)).toBe(true);
		expect(Array.isArray(grouped.sonnet)).toBe(true);
		expect(Array.isArray(grouped.haiku)).toBe(true);
	});

	test('should only include available models', () => {
		const grouped = getModelsByFamily();

		for (const family of ['opus', 'sonnet', 'haiku'] as const) {
			for (const model of grouped[family]) {
				expect(model.available).toBe(true);
			}
		}
	});

	test('should have correct family assignments', () => {
		const grouped = getModelsByFamily();

		for (const model of grouped.opus) {
			expect(model.family).toBe('opus');
		}
		for (const model of grouped.sonnet) {
			expect(model.family).toBe('sonnet');
		}
		for (const model of grouped.haiku) {
			expect(model.family).toBe('haiku');
		}
	});
});

describe('formatModelInfo', () => {
	const testModel: ModelInfo = {
		id: 'test-model',
		name: 'Test Model',
		alias: 'test',
		family: 'sonnet',
		contextWindow: 100000,
		description: 'A test model for unit testing',
		releaseDate: '2025-01-01',
		available: true,
	};

	test('should format model with description by default', () => {
		const formatted = formatModelInfo(testModel);
		expect(formatted).toBe('Test Model (test) - A test model for unit testing');
	});

	test('should format model without description when requested', () => {
		const formatted = formatModelInfo(testModel, false);
		expect(formatted).toBe('Test Model (test)');
	});

	test('should format real model correctly', () => {
		const model = getModelInfo('opus')!;
		const formatted = formatModelInfo(model);

		expect(formatted).toContain(model.name);
		expect(formatted).toContain(`(${model.alias})`);
		expect(formatted).toContain(model.description);
	});
});

describe('getFormattedModelList', () => {
	test('should return formatted string', () => {
		const list = getFormattedModelList();

		expect(typeof list).toBe('string');
		expect(list.length).toBeGreaterThan(0);
	});

	test('should include header', () => {
		const list = getFormattedModelList();
		expect(list).toContain('Available Claude Models:');
	});

	test('should include all family sections', () => {
		const list = getFormattedModelList();

		expect(list).toContain('Opus');
		expect(list).toContain('Sonnet');
		expect(list).toContain('Haiku');
	});

	test('should include model names', () => {
		const list = getFormattedModelList();

		for (const model of CLAUDE_MODELS.filter((m) => m.available)) {
			expect(list).toContain(model.name);
		}
	});

	test('should include emojis for each section', () => {
		const list = getFormattedModelList();

		expect(list).toContain('🎯'); // Opus
		expect(list).toContain('⚡'); // Sonnet
		expect(list).toContain('🚀'); // Haiku
	});
});
