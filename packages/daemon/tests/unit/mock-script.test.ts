/**
 * Unit tests for script-based mock SDK system
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
	parseMockScript,
	MockScripts,
	simpleTextResponse,
	normalizeTurns,
} from '../helpers/mock-sdk';

describe('Mock Script Parser', () => {
	describe('parseMockScript', () => {
		test('should parse simple text response', () => {
			const script = MockScripts.simpleText('Hello!', 0);
			const turns = parseMockScript(script);

			expect(turns.length).toBe(1);
			expect(turns[0].length).toBe(3); // system:init, assistant message, result

			// First message should be system:init
			expect(turns[0][0].message?.type).toBe('system');
			expect(turns[0][0].message?.subtype).toBe('init');

			// Last should be result
			const lastItem = turns[0][turns[0].length - 1];
			expect(lastItem.message?.type).toBe('result');
			expect(lastItem.message?.subtype).toBe('success');
		});

		test('should parse timing delays', () => {
			const script = `
				100ms
				builtin:system:init
				50ms
				builtin:result
			`;
			const turns = parseMockScript(script);

			expect(turns.length).toBe(1);
			expect(turns[0].length).toBe(4); // 100ms delay, init, 50ms delay, result

			expect(turns[0][0].delay).toBe(100);
			expect(turns[0][1].message?.type).toBe('system');
			expect(turns[0][2].delay).toBe(50);
			expect(turns[0][3].message?.type).toBe('result');
		});

		test('should parse multi-turn scripts with --- separator', () => {
			const script = MockScripts.multiTurn(['First', 'Second'], 0);
			const turns = parseMockScript(script);

			expect(turns.length).toBe(2);
		});

		test('should parse JSON objects', () => {
			const script = `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi"}]}}`;
			const turns = parseMockScript(script);

			expect(turns.length).toBe(1);
			expect(turns[0].length).toBe(1);
			expect(turns[0][0].message?.type).toBe('assistant');
		});

		test('should parse builtin messages', () => {
			const script = 'builtin:system:init\nbuiltin:result';
			const turns = parseMockScript(script);

			expect(turns[0].length).toBe(2);
			expect(turns[0][0].message?.type).toBe('system');
			expect(turns[0][1].message?.type).toBe('result');
		});

		test('should parse builtin with custom tokens', () => {
			const script = 'builtin:result:tokens:100:50';
			const turns = parseMockScript(script);

			expect(turns[0].length).toBe(1);
			expect(turns[0][0].message?.type).toBe('result');
			expect(turns[0][0].message?.usage?.input_tokens).toBe(100);
			expect(turns[0][0].message?.usage?.output_tokens).toBe(50);
		});

		test('should parse error messages', () => {
			const script = 'builtin:error';
			const turns = parseMockScript(script);

			expect(turns[0][0].message?.type).toBe('result');
			expect(turns[0][0].message?.subtype).toBe('error_during_execution');
		});

		test('should parse rate_limit error', () => {
			const script = 'builtin:error:rate_limit';
			const turns = parseMockScript(script);

			expect(turns[0][0].message?.type).toBe('result');
			expect((turns[0][0].message as Record<string, unknown>).error).toBe('rate_limit_error');
		});

		test('should skip comments and empty lines', () => {
			const script = `
				# This is a comment
				builtin:system:init

				# Another comment
				builtin:result
			`;
			const turns = parseMockScript(script);

			expect(turns[0].length).toBe(2);
		});

		test('should handle environment variable references', () => {
			const originalValue = process.env.TEST_MOCK_MESSAGE;
			process.env.TEST_MOCK_MESSAGE =
				'{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"From env"}]}}';

			try {
				const script = 'TEST_MOCK_MESSAGE';
				const turns = parseMockScript(script);

				expect(turns[0][0].message?.type).toBe('assistant');
			} finally {
				if (originalValue !== undefined) {
					process.env.TEST_MOCK_MESSAGE = originalValue;
				} else {
					delete process.env.TEST_MOCK_MESSAGE;
				}
			}
		});

		test('should treat plain text env var as assistant text', () => {
			const originalValue = process.env.TEST_PLAIN_MESSAGE;
			process.env.TEST_PLAIN_MESSAGE = 'Plain text response';

			try {
				const script = 'TEST_PLAIN_MESSAGE';
				const turns = parseMockScript(script);

				expect(turns[0][0].message?.type).toBe('assistant');
				const content = turns[0][0].message?.message?.content as Array<{ text: string }>;
				expect(content?.[0]?.text).toBe('Plain text response');
			} finally {
				if (originalValue !== undefined) {
					process.env.TEST_PLAIN_MESSAGE = originalValue;
				} else {
					delete process.env.TEST_PLAIN_MESSAGE;
				}
			}
		});
	});

	describe('MockScripts helpers', () => {
		test('simpleText should generate valid script', () => {
			const script = MockScripts.simpleText('Test', 100);

			expect(script).toContain('100ms');
			expect(script).toContain('builtin:system:init');
			expect(script).toContain('builtin:result');
			expect(script).toContain('Test');
		});

		test('multiTurn should separate turns with ---', () => {
			const script = MockScripts.multiTurn(['A', 'B', 'C'], 50);

			expect(script).toContain('---');
			const parts = script.split('---');
			expect(parts.length).toBe(3);
		});

		test('error should generate error result', () => {
			const script = MockScripts.error();

			expect(script).toContain('builtin:system:init');
			expect(script).toContain('builtin:error');
		});

		test('rateLimit should generate rate_limit error', () => {
			const script = MockScripts.rateLimit();

			expect(script).toContain('builtin:error:rate_limit');
		});

		test('toolUse should generate tool use flow', () => {
			const script = MockScripts.toolUse('Read', { file_path: '/test.txt' }, 'File contents');

			expect(script).toContain('tool_use');
			expect(script).toContain('Read');
			expect(script).toContain('tool_result');
			expect(script).toContain('File contents');
		});
	});
});
