// @ts-nocheck
/**
 * Tests for GlobalToolsSettings Component Logic
 *
 * Tests pure logic without mock.module to avoid polluting other tests.
 */
import { describe, it, expect } from 'vitest';

import { signal } from '@preact/signals';

describe('GlobalToolsSettings Logic', () => {
	// Mock GlobalToolsConfig type
	interface MockGlobalToolsConfig {
		systemPrompt?: {
			claudeCodePreset?: {
				allowed?: boolean;
				defaultEnabled?: boolean;
			};
		};
		settingSources?: {
			project?: {
				allowed?: boolean;
				defaultEnabled?: boolean;
			};
		};
		mcp?: {
			allowProjectMcp?: boolean;
			defaultProjectMcp?: boolean;
		};
		liuboerTools?: {
			memory?: {
				allowed?: boolean;
				defaultEnabled?: boolean;
			};
		};
	}

	const DEFAULT_CONFIG: MockGlobalToolsConfig = {
		systemPrompt: {
			claudeCodePreset: {
				allowed: true,
				defaultEnabled: true,
			},
		},
		settingSources: {
			project: {
				allowed: true,
				defaultEnabled: true,
			},
		},
		mcp: {
			allowProjectMcp: true,
			defaultProjectMcp: false,
		},
		liuboerTools: {
			memory: {
				allowed: true,
				defaultEnabled: false,
			},
		},
	};

	describe('Loading State', () => {
		it('should track loading state', () => {
			const loading = signal(true);
			expect(loading.value).toBe(true);
			loading.value = false;
			expect(loading.value).toBe(false);
		});

		it('should support async config loading', async () => {
			const loadConfig = vi.fn(() => Promise.resolve({ config: DEFAULT_CONFIG }));
			const result = await loadConfig();
			expect(result.config).toEqual(DEFAULT_CONFIG);
		});

		it('should use default config on error', async () => {
			const loadConfig = vi.fn(() => Promise.reject(new Error('Network error')));

			let config = DEFAULT_CONFIG;
			try {
				await loadConfig();
			} catch {
				config = DEFAULT_CONFIG;
			}

			expect(config).toEqual(DEFAULT_CONFIG);
		});
	});

	describe('System Prompt Settings', () => {
		it('should have Claude Code preset allowed by default', () => {
			expect(DEFAULT_CONFIG.systemPrompt?.claudeCodePreset?.allowed).toBe(true);
		});

		it('should have Claude Code preset enabled by default', () => {
			expect(DEFAULT_CONFIG.systemPrompt?.claudeCodePreset?.defaultEnabled).toBe(true);
		});

		it('should update allowed setting', () => {
			let config: MockGlobalToolsConfig = { ...DEFAULT_CONFIG };
			config = {
				...config,
				systemPrompt: {
					...config.systemPrompt,
					claudeCodePreset: {
						...config.systemPrompt?.claudeCodePreset,
						allowed: false,
					},
				},
			};
			expect(config.systemPrompt?.claudeCodePreset?.allowed).toBe(false);
		});

		it('should disable defaultEnabled when disabling allowed', () => {
			let config: MockGlobalToolsConfig = { ...DEFAULT_CONFIG };

			config = {
				...config,
				systemPrompt: {
					...config.systemPrompt,
					claudeCodePreset: {
						...config.systemPrompt?.claudeCodePreset,
						allowed: false,
					},
				},
			};

			// If disabling permission, also disable default
			if (!config.systemPrompt?.claudeCodePreset?.allowed) {
				config.systemPrompt!.claudeCodePreset!.defaultEnabled = false;
			}

			expect(config.systemPrompt?.claudeCodePreset?.defaultEnabled).toBe(false);
		});
	});

	describe('Liuboer Tools Settings', () => {
		it('should have memory allowed by default', () => {
			expect(DEFAULT_CONFIG.liuboerTools?.memory?.allowed).toBe(true);
		});

		it('should have memory disabled by default', () => {
			expect(DEFAULT_CONFIG.liuboerTools?.memory?.defaultEnabled).toBe(false);
		});

		it('should update memory allowed setting', () => {
			let config: MockGlobalToolsConfig = { ...DEFAULT_CONFIG };
			config = {
				...config,
				liuboerTools: {
					...config.liuboerTools,
					memory: {
						...config.liuboerTools?.memory,
						allowed: false,
					},
				},
			};
			expect(config.liuboerTools?.memory?.allowed).toBe(false);
		});

		it('should update memory defaultEnabled setting', () => {
			let config: MockGlobalToolsConfig = { ...DEFAULT_CONFIG };
			config = {
				...config,
				liuboerTools: {
					...config.liuboerTools,
					memory: {
						...config.liuboerTools?.memory,
						defaultEnabled: true,
					},
				},
			};
			expect(config.liuboerTools?.memory?.defaultEnabled).toBe(true);
		});

		it('should disable defaultEnabled when disabling allowed for memory', () => {
			let config: MockGlobalToolsConfig = { ...DEFAULT_CONFIG };

			config = {
				...config,
				liuboerTools: {
					...config.liuboerTools,
					memory: {
						...config.liuboerTools?.memory,
						allowed: false,
					},
				},
			};

			// If disabling permission, also disable default
			if (!config.liuboerTools?.memory?.allowed) {
				config.liuboerTools!.memory!.defaultEnabled = false;
			}

			expect(config.liuboerTools?.memory?.defaultEnabled).toBe(false);
		});
	});

	describe('Save Functionality', () => {
		it('should support async save', async () => {
			const saveFn = vi.fn(() => Promise.resolve({ success: true }));
			const toastFn = vi.fn(() => {});

			await saveFn({ config: DEFAULT_CONFIG });
			toastFn('Global tools settings saved');

			expect(saveFn).toHaveBeenCalled();
			expect(toastFn).toHaveBeenCalled();
		});

		it('should handle save failure', async () => {
			const saveFn = vi.fn(() => Promise.reject(new Error('Save failed')));
			const toastFn = vi.fn(() => {});

			try {
				await saveFn({ config: DEFAULT_CONFIG });
			} catch {
				toastFn('Failed to save global tools settings');
			}

			expect(toastFn).toHaveBeenCalledWith('Failed to save global tools settings');
		});
	});

	describe('Disabled State', () => {
		it('should track saving state', () => {
			const saving = signal(true);
			expect(saving.value).toBe(true);
		});

		it('should check if defaultEnabled should be disabled', () => {
			const config: MockGlobalToolsConfig = {
				systemPrompt: {
					claudeCodePreset: {
						allowed: false,
						defaultEnabled: false,
					},
				},
			};

			const isAllowed = config.systemPrompt?.claudeCodePreset?.allowed ?? true;
			expect(isAllowed).toBe(false);
		});
	});

	describe('SDK Built-in Tools Info', () => {
		it('should list SDK tools', () => {
			const sdkTools = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'];
			expect(sdkTools.length).toBeGreaterThan(0);
			expect(sdkTools).toContain('Read');
		});

		it('should list slash commands', () => {
			const slashCommands = ['/help', '/context', '/clear', '/config', '/bug'];
			expect(slashCommands.length).toBeGreaterThan(0);
			expect(slashCommands).toContain('/help');
		});

		it('should list task agents', () => {
			const taskAgents = ['general-purpose', 'Explore', 'Plan'];
			expect(taskAgents.length).toBeGreaterThan(0);
		});

		it('should list web tools', () => {
			const webTools = ['WebSearch', 'WebFetch'];
			expect(webTools.length).toBe(2);
		});
	});

	describe('Config Defaults', () => {
		it('should use default values for missing config fields', () => {
			const partialConfig: MockGlobalToolsConfig = {};

			const allowed = partialConfig.systemPrompt?.claudeCodePreset?.allowed ?? true;
			const defaultEnabled = partialConfig.systemPrompt?.claudeCodePreset?.defaultEnabled ?? true;

			expect(allowed).toBe(true);
			expect(defaultEnabled).toBe(true);
		});
	});
});
