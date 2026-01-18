// @ts-nocheck
/**
 * Tests for Design Tokens
 *
 * Tests the centralized design system tokens for spacing, sizing, and styling.
 */

import {
	messageSpacing,
	borderRadius,
	messageColors,
	customColors,
	borderColors,
} from '../design-tokens';

describe('messageSpacing', () => {
	describe('user', () => {
		it('should have bubble spacing for mobile', () => {
			expect(messageSpacing.user.bubble.mobile).toBeDefined();
			expect(messageSpacing.user.bubble.mobile).toContain('px-');
			expect(messageSpacing.user.bubble.mobile).toContain('py-');
		});

		it('should have bubble spacing for desktop', () => {
			expect(messageSpacing.user.bubble.desktop).toBeDefined();
			expect(messageSpacing.user.bubble.desktop).toContain('md:');
		});

		it('should have combined bubble spacing', () => {
			expect(messageSpacing.user.bubble.combined).toBeDefined();
			expect(messageSpacing.user.bubble.combined).toContain('px-');
			expect(messageSpacing.user.bubble.combined).toContain('md:');
		});

		it('should have container spacing', () => {
			expect(messageSpacing.user.container.combined).toBeDefined();
			expect(messageSpacing.user.container.combined).toContain('py-');
		});
	});

	describe('assistant', () => {
		it('should have bubble spacing for mobile', () => {
			expect(messageSpacing.assistant.bubble.mobile).toBeDefined();
			expect(messageSpacing.assistant.bubble.mobile).toContain('px-');
		});

		it('should have bubble spacing for desktop', () => {
			expect(messageSpacing.assistant.bubble.desktop).toBeDefined();
		});

		it('should have combined bubble spacing', () => {
			expect(messageSpacing.assistant.bubble.combined).toBeDefined();
		});

		it('should have container spacing', () => {
			expect(messageSpacing.assistant.container.combined).toBeDefined();
		});
	});

	describe('actions', () => {
		it('should have marginTop', () => {
			expect(messageSpacing.actions.marginTop).toBe('mt-2');
		});

		it('should have gap', () => {
			expect(messageSpacing.actions.gap).toBe('gap-2');
		});

		it('should have padding', () => {
			expect(messageSpacing.actions.padding).toBe('px-1');
		});
	});
});

describe('borderRadius', () => {
	describe('message', () => {
		it('should have bubble radius for iMessage style', () => {
			expect(borderRadius.message.bubble).toBe('rounded-[20px]');
		});

		it('should have tool radius', () => {
			expect(borderRadius.message.tool).toBe('rounded-lg');
		});
	});
});

describe('messageColors', () => {
	describe('user', () => {
		it('should have blue background like iMessage', () => {
			expect(messageColors.user.background).toBe('bg-blue-500');
		});

		it('should have white text', () => {
			expect(messageColors.user.text).toBe('text-white');
		});
	});

	describe('assistant', () => {
		it('should have dark background', () => {
			expect(messageColors.assistant.background).toBe('bg-dark-800');
		});

		it('should have white text', () => {
			expect(messageColors.assistant.text).toBe('text-white');
		});
	});
});

describe('customColors', () => {
	describe('lemonYellow', () => {
		it('should have light color', () => {
			expect(customColors.lemonYellow.light).toBe('#FFF44F');
		});

		it('should have dark variant', () => {
			expect(customColors.lemonYellow.dark).toBe('#B8A837');
		});
	});

	describe('canaryYellow', () => {
		it('should have light color', () => {
			expect(customColors.canaryYellow.light).toBe('#FFEF00');
		});

		it('should have dark variant', () => {
			expect(customColors.canaryYellow.dark).toBe('#B8AA00');
		});
	});
});

describe('borderColors', () => {
	describe('ui', () => {
		it('should have default border color', () => {
			expect(borderColors.ui.default).toBe('border-dark-700');
		});

		it('should have secondary border color', () => {
			expect(borderColors.ui.secondary).toBe('border-dark-600');
		});

		it('should have input border color', () => {
			expect(borderColors.ui.input).toBe('border-dark-600');
		});

		it('should have emphasis border color', () => {
			expect(borderColors.ui.emphasis).toBe('border-dark-800');
		});

		it('should have disabled border color', () => {
			expect(borderColors.ui.disabled).toBe('border-dark-700/30');
		});
	});

	describe('tool', () => {
		it('should have file border color', () => {
			expect(borderColors.tool.file).toContain('border-blue');
		});

		it('should have search border color', () => {
			expect(borderColors.tool.search).toContain('border-purple');
		});

		it('should have terminal border color', () => {
			expect(borderColors.tool.terminal).toContain('border-gray');
		});

		it('should have agent border color', () => {
			expect(borderColors.tool.agent).toContain('border-indigo');
		});

		it('should have web border color', () => {
			expect(borderColors.tool.web).toContain('border-green');
		});

		it('should have todo border color', () => {
			expect(borderColors.tool.todo).toContain('border-amber');
		});

		it('should have mcp border color', () => {
			expect(borderColors.tool.mcp).toContain('border-pink');
		});

		it('should have system border color', () => {
			expect(borderColors.tool.system).toContain('border-cyan');
		});

		// All tool colors should have dark mode variants
		const toolCategories = [
			'file',
			'search',
			'terminal',
			'agent',
			'web',
			'todo',
			'mcp',
			'system',
		] as const;

		toolCategories.forEach((category) => {
			it(`should have dark mode variant for ${category}`, () => {
				expect(borderColors.tool[category]).toContain('dark:border-');
			});
		});
	});

	describe('semantic', () => {
		it('should have success color', () => {
			expect(borderColors.semantic.success).toContain('border-green');
		});

		it('should have error color', () => {
			expect(borderColors.semantic.error).toContain('border-red');
		});

		it('should have warning color', () => {
			expect(borderColors.semantic.warning).toContain('border-amber');
		});

		it('should have warning yellow variant', () => {
			expect(borderColors.semantic.warningYellow).toContain('border-yellow');
		});

		it('should have info color', () => {
			expect(borderColors.semantic.info).toContain('border-blue');
		});

		it('should have neutral color', () => {
			expect(borderColors.semantic.neutral).toContain('border-gray');
		});
	});

	describe('interactive', () => {
		it('should have focus state', () => {
			expect(borderColors.interactive.focus).toContain('focus-within:');
		});

		it('should have hover state', () => {
			expect(borderColors.interactive.hover).toContain('hover:');
		});

		it('should have active state', () => {
			expect(borderColors.interactive.active).toContain('border-blue');
		});
	});

	describe('special', () => {
		describe('toast', () => {
			it('should have success toast color', () => {
				expect(borderColors.special.toast.success).toContain('border-green');
			});

			it('should have error toast color', () => {
				expect(borderColors.special.toast.error).toContain('border-red');
			});

			it('should have warning toast color', () => {
				expect(borderColors.special.toast.warning).toContain('border-amber');
			});

			it('should have info toast color', () => {
				expect(borderColors.special.toast.info).toContain('border-blue');
			});

			// Toast colors should use opacity
			const toastTypes = ['success', 'error', 'warning', 'info'] as const;
			toastTypes.forEach((type) => {
				it(`should use opacity for ${type} toast`, () => {
					expect(borderColors.special.toast[type]).toContain('/20');
				});
			});
		});

		describe('indicator', () => {
			it('should have purple indicator', () => {
				expect(borderColors.special.indicator.purple).toContain('border-purple');
			});

			it('should have indigo indicator', () => {
				expect(borderColors.special.indicator.indigo).toContain('border-indigo');
			});
		});
	});
});

describe('Token consistency', () => {
	it('should use consistent Tailwind class format', () => {
		// All border colors should start with 'border-'
		const checkBorderFormat = (obj: Record<string, unknown>, path = ''): void => {
			for (const [key, value] of Object.entries(obj)) {
				const currentPath = path ? `${path}.${key}` : key;
				if (typeof value === 'string') {
					// Check that it starts with border- or contains it after a space/prefix
					expect(value).toMatch(/border-/);
				} else if (typeof value === 'object' && value !== null) {
					checkBorderFormat(value as Record<string, unknown>, currentPath);
				}
			}
		};

		checkBorderFormat(borderColors);
	});

	it('should use consistent color naming', () => {
		// Colors should follow Tailwind naming convention
		const tailwindColors = [
			'dark',
			'blue',
			'purple',
			'gray',
			'indigo',
			'green',
			'amber',
			'pink',
			'cyan',
			'red',
			'yellow',
		];

		const extractColors = (str: string): string[] => {
			const matches = str.match(/border-([a-z]+)/g) || [];
			return matches.map((m) => m.replace('border-', ''));
		};

		const checkColors = (obj: Record<string, unknown>): void => {
			for (const value of Object.values(obj)) {
				if (typeof value === 'string') {
					const colors = extractColors(value);
					colors.forEach((color) => {
						expect(tailwindColors).toContain(color);
					});
				} else if (typeof value === 'object' && value !== null) {
					checkColors(value as Record<string, unknown>);
				}
			}
		};

		checkColors(borderColors);
	});
});

describe('Type safety', () => {
	it('should be readonly (const assertion)', () => {
		// These should be readonly objects - attempting to modify should fail in TypeScript
		// At runtime, we can verify the object structure exists
		expect(typeof messageSpacing).toBe('object');
		expect(typeof borderRadius).toBe('object');
		expect(typeof messageColors).toBe('object');
		expect(typeof customColors).toBe('object');
		expect(typeof borderColors).toBe('object');
	});

	it('should export all expected tokens', () => {
		// Verify all expected exports are present
		expect(messageSpacing).toBeDefined();
		expect(borderRadius).toBeDefined();
		expect(messageColors).toBeDefined();
		expect(customColors).toBeDefined();
		expect(borderColors).toBeDefined();
	});
});
