// @ts-nocheck
/**
 * Tests for tool-registry
 *
 * Tests for getToolConfig, getCategoryColors, and tool configurations
 */

import { getToolConfig, getCategoryColors } from '../tool-registry';
import type { ToolCategory } from '../tool-types';

describe('tool-registry', () => {
	describe('getToolConfig', () => {
		describe('File Tools', () => {
			it('should return config for Read tool', () => {
				const config = getToolConfig('Read');
				expect(config.displayName).toBe('Read');
				expect(config.category).toBe('file');
				expect(config.hasLongOutput).toBe(true);
				expect(config.defaultExpanded).toBe(false);
			});

			it('should return config for Write tool', () => {
				const config = getToolConfig('Write');
				expect(config.displayName).toBe('Write');
				expect(config.category).toBe('file');
				expect(config.hasLongOutput).toBe(false);
			});

			it('should return config for Edit tool', () => {
				const config = getToolConfig('Edit');
				expect(config.displayName).toBe('Edit');
				expect(config.category).toBe('file');
			});

			it('should return config for NotebookEdit tool', () => {
				const config = getToolConfig('NotebookEdit');
				expect(config.displayName).toBe('Notebook Edit');
				expect(config.category).toBe('file');
			});

			it('should have summaryExtractor for file tools', () => {
				const config = getToolConfig('Read');
				expect(config.summaryExtractor).toBeDefined();
				const summary = config.summaryExtractor?.({ file_path: '/path/to/file.ts' });
				expect(summary).toBe('file.ts');
			});
		});

		describe('Search Tools', () => {
			it('should return config for Glob tool', () => {
				const config = getToolConfig('Glob');
				expect(config.displayName).toBe('Glob');
				expect(config.category).toBe('search');
				expect(config.hasLongOutput).toBe(true);
			});

			it('should return config for Grep tool', () => {
				const config = getToolConfig('Grep');
				expect(config.displayName).toBe('Grep');
				expect(config.category).toBe('search');
			});

			it('should have summaryExtractor for search tools', () => {
				const config = getToolConfig('Grep');
				const summary = config.summaryExtractor?.({ pattern: '**/*.ts' });
				expect(summary).toBe('**/*.ts');
			});
		});

		describe('Terminal Tools', () => {
			it('should return config for Bash tool', () => {
				const config = getToolConfig('Bash');
				expect(config.displayName).toBe('Bash');
				expect(config.category).toBe('terminal');
				expect(config.hasLongOutput).toBe(true);
			});

			it('should return config for BashOutput tool', () => {
				const config = getToolConfig('BashOutput');
				expect(config.displayName).toBe('Bash Output');
				expect(config.category).toBe('terminal');
			});

			it('should return config for KillShell tool', () => {
				const config = getToolConfig('KillShell');
				expect(config.displayName).toBe('Kill Shell');
				expect(config.category).toBe('terminal');
			});

			it('should prefer description for Bash summary', () => {
				const config = getToolConfig('Bash');
				const summary = config.summaryExtractor?.({
					command: 'npm install',
					description: 'Install deps',
				});
				expect(summary).toBe('Install deps');
			});

			it('should fallback to command for Bash summary', () => {
				const config = getToolConfig('Bash');
				const summary = config.summaryExtractor?.({ command: 'npm install' });
				expect(summary).toBe('npm install');
			});
		});

		describe('Agent Tools', () => {
			it('should return config for Task tool', () => {
				const config = getToolConfig('Task');
				expect(config.displayName).toBe('Task');
				expect(config.category).toBe('agent');
				expect(config.hasLongOutput).toBe(true);
			});

			it('should return config for Agent tool', () => {
				const config = getToolConfig('Agent');
				expect(config.displayName).toBe('Agent');
				expect(config.category).toBe('agent');
			});
		});

		describe('Web Tools', () => {
			it('should return config for WebFetch tool', () => {
				const config = getToolConfig('WebFetch');
				expect(config.displayName).toBe('Web Fetch');
				expect(config.category).toBe('web');
				expect(config.hasLongOutput).toBe(true);
			});

			it('should return config for WebSearch tool', () => {
				const config = getToolConfig('WebSearch');
				expect(config.displayName).toBe('Web Search');
				expect(config.category).toBe('web');
			});
		});

		describe('Todo Tools', () => {
			it('should return config for TodoWrite tool', () => {
				const config = getToolConfig('TodoWrite');
				expect(config.displayName).toBe('Todo');
				expect(config.category).toBe('todo');
				expect(config.defaultExpanded).toBe(true);
				expect(config.hasLongOutput).toBe(false);
			});

			it('should have customRenderer for TodoWrite', () => {
				const config = getToolConfig('TodoWrite');
				expect(config.customRenderer).toBeDefined();
			});

			it('should count todos in summary', () => {
				const config = getToolConfig('TodoWrite');
				const summary = config.summaryExtractor?.({
					todos: [
						{ content: '1', status: 'pending', activeForm: '' },
						{ content: '2', status: 'pending', activeForm: '' },
						{ content: '3', status: 'pending', activeForm: '' },
					],
				});
				expect(summary).toBe('3 todos');
			});

			it('should use singular for single todo', () => {
				const config = getToolConfig('TodoWrite');
				const summary = config.summaryExtractor?.({
					todos: [{ content: '1', status: 'pending', activeForm: '' }],
				});
				expect(summary).toBe('1 todo');
			});

			it('should return default for empty todos', () => {
				const config = getToolConfig('TodoWrite');
				const summary = config.summaryExtractor?.({ todos: [] });
				expect(summary).toBe('Update todos');
			});
		});

		describe('MCP Tools', () => {
			it('should return config for ListMcpResourcesTool', () => {
				const config = getToolConfig('ListMcpResourcesTool');
				expect(config.displayName).toBe('List MCP Resources');
				expect(config.category).toBe('mcp');
			});

			it('should return config for ReadMcpResourceTool', () => {
				const config = getToolConfig('ReadMcpResourceTool');
				expect(config.displayName).toBe('Read MCP Resource');
				expect(config.category).toBe('mcp');
			});

			it('should handle dynamic MCP tools', () => {
				const config = getToolConfig('mcp__filesystem__read_file');
				expect(config.displayName).toBe('read_file');
				expect(config.category).toBe('mcp');
				expect(config.hasLongOutput).toBe(true);
			});

			it('should extract server name in summary for MCP tools', () => {
				const config = getToolConfig('mcp__my_server__some_tool');
				const summary = config.summaryExtractor?.({});
				expect(summary).toBe('my_server');
			});

			it('should handle MCP tools with complex names', () => {
				const config = getToolConfig('mcp__server__complex__tool__name');
				expect(config.displayName).toBe('complex__tool__name');
			});
		});

		describe('System Tools', () => {
			it('should return config for ExitPlanMode tool', () => {
				const config = getToolConfig('ExitPlanMode');
				expect(config.displayName).toBe('Exit Plan Mode');
				expect(config.category).toBe('system');
			});

			it('should return config for TimeMachine tool', () => {
				const config = getToolConfig('TimeMachine');
				expect(config.displayName).toBe('Time Machine');
				expect(config.category).toBe('system');
			});

			it('should return config for Thinking tool', () => {
				const config = getToolConfig('Thinking');
				expect(config.displayName).toBe('Thinking');
				expect(config.category).toBe('system');
				expect(config.hasLongOutput).toBe(true);
			});

			it('should have custom colors for Thinking tool', () => {
				const config = getToolConfig('Thinking');
				expect(config.colors).toBeDefined();
				expect(config.colors?.bg).toContain('amber');
			});

			it('should count characters for Thinking summary', () => {
				const config = getToolConfig('Thinking');
				const thinkingText = 'A'.repeat(100);
				const summary = config.summaryExtractor?.(thinkingText);
				expect(summary).toBe('100 characters');
			});

			it('should use singular for single character', () => {
				const config = getToolConfig('Thinking');
				const summary = config.summaryExtractor?.('A');
				expect(summary).toBe('1 character');
			});
		});

		describe('Unknown Tools', () => {
			it('should return fallback config for unknown tools', () => {
				const config = getToolConfig('CompletelyUnknownTool');
				expect(config.displayName).toBe('CompletelyUnknownTool');
				expect(config.category).toBe('unknown');
				expect(config.defaultExpanded).toBe(false);
			});

			it('should try to extract string value from unknown tool input', () => {
				const config = getToolConfig('CustomTool');
				const summary = config.summaryExtractor?.({ customField: 'custom value' });
				expect(summary).toBe('custom value');
			});

			it('should truncate long values from unknown tools', () => {
				const config = getToolConfig('CustomTool');
				const longValue = 'A'.repeat(100);
				const summary = config.summaryExtractor?.({ field: longValue });
				expect(summary?.length).toBeLessThan(longValue.length);
				expect(summary?.endsWith('...')).toBe(true);
			});

			it('should return null for unknown tools with no string properties', () => {
				const config = getToolConfig('CustomTool');
				const summary = config.summaryExtractor?.({ count: 42 });
				expect(summary).toBeNull();
			});

			it('should return null for unknown tools with empty input', () => {
				const config = getToolConfig('CustomTool');
				const summary = config.summaryExtractor?.({});
				expect(summary).toBeNull();
			});
		});
	});

	describe('getCategoryColors', () => {
		it('should return blue colors for file category', () => {
			const colors = getCategoryColors('file');
			expect(colors.bg).toBe('bg-blue-50 dark:bg-blue-900/20');
			expect(colors.text).toBe('text-blue-900 dark:text-blue-100');
			expect(colors.iconColor).toBe('text-blue-600 dark:text-blue-400');
			expect(colors.lightText).toBe('text-blue-700 dark:text-blue-300');
		});

		it('should return purple colors for search category', () => {
			const colors = getCategoryColors('search');
			expect(colors.bg).toBe('bg-purple-50 dark:bg-purple-900/20');
			expect(colors.iconColor).toBe('text-purple-600 dark:text-purple-400');
		});

		it('should return gray colors for terminal category', () => {
			const colors = getCategoryColors('terminal');
			expect(colors.bg).toBe('bg-gray-50 dark:bg-gray-900/20');
			expect(colors.iconColor).toBe('text-gray-600 dark:text-gray-400');
		});

		it('should return indigo colors for agent category', () => {
			const colors = getCategoryColors('agent');
			expect(colors.bg).toBe('bg-indigo-50 dark:bg-indigo-900/20');
			expect(colors.iconColor).toBe('text-indigo-600 dark:text-indigo-400');
		});

		it('should return green colors for web category', () => {
			const colors = getCategoryColors('web');
			expect(colors.bg).toBe('bg-green-50 dark:bg-green-900/20');
			expect(colors.iconColor).toBe('text-green-600 dark:text-green-400');
		});

		it('should return amber colors for todo category', () => {
			const colors = getCategoryColors('todo');
			expect(colors.bg).toBe('bg-amber-50 dark:bg-amber-900/20');
			expect(colors.iconColor).toBe('text-amber-600 dark:text-amber-400');
		});

		it('should return pink colors for mcp category', () => {
			const colors = getCategoryColors('mcp');
			expect(colors.bg).toBe('bg-pink-50 dark:bg-pink-900/20');
			expect(colors.iconColor).toBe('text-pink-600 dark:text-pink-400');
		});

		it('should return cyan colors for system category', () => {
			const colors = getCategoryColors('system');
			expect(colors.bg).toBe('bg-cyan-50 dark:bg-cyan-900/20');
			expect(colors.iconColor).toBe('text-cyan-600 dark:text-cyan-400');
		});

		it('should return gray colors for unknown category', () => {
			const colors = getCategoryColors('unknown');
			expect(colors.bg).toBe('bg-gray-50 dark:bg-gray-900/20');
			expect(colors.iconColor).toBe('text-gray-600 dark:text-gray-400');
		});

		it('should return gray colors for any unrecognized category', () => {
			const colors = getCategoryColors('nonexistent' as ToolCategory);
			expect(colors.bg).toBe('bg-gray-50 dark:bg-gray-900/20');
		});
	});

	describe('Tool Config Structure', () => {
		const allKnownTools = [
			'Write',
			'Edit',
			'Read',
			'NotebookEdit',
			'Glob',
			'Grep',
			'Bash',
			'BashOutput',
			'KillShell',
			'Task',
			'Agent',
			'WebFetch',
			'WebSearch',
			'TodoWrite',
			'ListMcpResourcesTool',
			'ReadMcpResourceTool',
			'ExitPlanMode',
			'TimeMachine',
			'Thinking',
		];

		allKnownTools.forEach((toolName) => {
			it(`should have valid config structure for ${toolName}`, () => {
				const config = getToolConfig(toolName);

				// All configs should have these properties
				expect(config.category).toBeDefined();
				expect(typeof config.hasLongOutput).toBe('boolean');
				expect(typeof config.defaultExpanded).toBe('boolean');

				// displayName should be a string
				expect(typeof config.displayName).toBe('string');

				// summaryExtractor should be a function if defined
				if (config.summaryExtractor) {
					expect(typeof config.summaryExtractor).toBe('function');
				}

				// customRenderer should be a function if defined
				if (config.customRenderer) {
					expect(typeof config.customRenderer).toBe('function');
				}

				// colors should have all required properties if defined
				if (config.colors) {
					expect(typeof config.colors.bg).toBe('string');
					expect(typeof config.colors.text).toBe('string');
					expect(typeof config.colors.border).toBe('string');
					expect(typeof config.colors.iconColor).toBe('string');
				}
			});
		});
	});

	describe('Category Color Structure', () => {
		const allCategories: ToolCategory[] = [
			'file',
			'search',
			'terminal',
			'agent',
			'web',
			'todo',
			'mcp',
			'system',
			'unknown',
		];

		allCategories.forEach((category) => {
			it(`should have valid color structure for ${category} category`, () => {
				const colors = getCategoryColors(category);

				expect(typeof colors.bg).toBe('string');
				expect(typeof colors.text).toBe('string');
				expect(typeof colors.border).toBe('string');
				expect(typeof colors.iconColor).toBe('string');
				expect(typeof colors.lightText).toBe('string');

				// Should have dark mode variants
				expect(colors.bg).toContain('dark:');
				expect(colors.text).toContain('dark:');
				expect(colors.iconColor).toContain('dark:');
			});
		});
	});
});
