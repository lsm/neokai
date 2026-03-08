import { describe, expect, it } from 'bun:test';
import { renderTemplate } from '../utils';

describe('renderTemplate', () => {
	it('replaces single variable', () => {
		const result = renderTemplate('Hello, {{name}}!', { name: 'World' });
		expect(result).toBe('Hello, World!');
	});

	it('replaces multiple variables', () => {
		const result = renderTemplate('Fix: {{description}}\nIn: {{target}}', {
			description: 'Login is broken',
			target: 'auth.ts',
		});
		expect(result).toBe('Fix: Login is broken\nIn: auth.ts');
	});

	it('leaves unmatched placeholders', () => {
		const result = renderTemplate('{{known}} and {{unknown}}', { known: 'yes' });
		expect(result).toBe('yes and {{unknown}}');
	});

	it('handles empty variables', () => {
		const result = renderTemplate('{{a}} and {{b}}', {});
		expect(result).toBe('{{a}} and {{b}}');
	});

	it('handles template without placeholders', () => {
		const result = renderTemplate('no placeholders here', { foo: 'bar' });
		expect(result).toBe('no placeholders here');
	});

	it('handles empty string', () => {
		const result = renderTemplate('', { foo: 'bar' });
		expect(result).toBe('');
	});

	it('replaces same variable multiple times', () => {
		const result = renderTemplate('{{x}} + {{x}} = 2*{{x}}', { x: '3' });
		expect(result).toBe('3 + 3 = 2*3');
	});
});
