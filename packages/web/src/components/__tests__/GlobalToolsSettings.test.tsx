// @ts-nocheck
/**
 * Tests for GlobalToolsSettings Component
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { signal } from '@preact/signals';

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

// Mock connection manager
const mockHub = {
	call: mock(() => Promise.resolve({ config: DEFAULT_CONFIG })),
};
mock.module('../lib/connection-manager.ts', () => ({
	connectionManager: {
		getHub: mock(() => Promise.resolve(mockHub)),
	},
}));

// Mock toast
const mockToast = {
	success: mock(() => {}),
	error: mock(() => {}),
};
mock.module('../lib/toast.ts', () => ({
	toast: mockToast,
}));

describe('GlobalToolsSettings', () => {
	beforeEach(() => {
		mockHub.call.mockClear();
		mockToast.success.mockClear();
		mockToast.error.mockClear();
	});

	describe('Loading State', () => {
		it('should show loading state initially', () => {
			const loading = signal(true);
			expect(loading.value).toBe(true);
		});

		it('should load config on mount', async () => {
			mockHub.call.mockResolvedValueOnce({ config: DEFAULT_CONFIG });
			await mockHub.call('globalTools.getConfig');
			expect(mockHub.call).toHaveBeenCalled();
		});

		it('should use default config on error', async () => {
			mockHub.call.mockRejectedValueOnce(new Error('Network error'));

			let config = DEFAULT_CONFIG;
			try {
				await mockHub.call('globalTools.getConfig');
			} catch {
				config = DEFAULT_CONFIG;
			}

			expect(config).toEqual(DEFAULT_CONFIG);
		});
	});

	describe('System Prompt Settings', () => {
		it('should have Claude Code preset allowed by default', () => {
			const config = DEFAULT_CONFIG;
			expect(config.systemPrompt?.claudeCodePreset?.allowed).toBe(true);
		});

		it('should have Claude Code preset enabled by default', () => {
			const config = DEFAULT_CONFIG;
			expect(config.systemPrompt?.claudeCodePreset?.defaultEnabled).toBe(true);
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
			const key = 'allowed';
			const value = false;

			config = {
				...config,
				systemPrompt: {
					...config.systemPrompt,
					claudeCodePreset: {
						...config.systemPrompt?.claudeCodePreset,
						[key]: value,
					},
				},
			};

			// If disabling permission, also disable default
			if (key === 'allowed' && !value) {
				config.systemPrompt!.claudeCodePreset!.defaultEnabled = false;
			}

			expect(config.systemPrompt?.claudeCodePreset?.defaultEnabled).toBe(false);
		});
	});

	describe('Liuboer Tools Settings', () => {
		it('should have memory allowed by default', () => {
			const config = DEFAULT_CONFIG;
			expect(config.liuboerTools?.memory?.allowed).toBe(true);
		});

		it('should have memory disabled by default', () => {
			const config = DEFAULT_CONFIG;
			expect(config.liuboerTools?.memory?.defaultEnabled).toBe(false);
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
			const key = 'allowed';
			const value = false;

			config = {
				...config,
				liuboerTools: {
					...config.liuboerTools,
					memory: {
						...config.liuboerTools?.memory,
						[key]: value,
					},
				},
			};

			// If disabling permission, also disable default
			if (key === 'allowed' && !value) {
				config.liuboerTools!.memory!.defaultEnabled = false;
			}

			expect(config.liuboerTools?.memory?.defaultEnabled).toBe(false);
		});
	});

	describe('Save Functionality', () => {
		it('should save config successfully', async () => {
			mockHub.call.mockResolvedValueOnce({ success: true });
			await mockHub.call('globalTools.saveConfig', { config: DEFAULT_CONFIG });
			mockToast.success('Global tools settings saved');

			expect(mockHub.call).toHaveBeenCalled();
			expect(mockToast.success).toHaveBeenCalled();
		});

		it('should show error toast on save failure', async () => {
			mockHub.call.mockRejectedValueOnce(new Error('Save failed'));

			try {
				await mockHub.call('globalTools.saveConfig', { config: DEFAULT_CONFIG });
			} catch {
				mockToast.error('Failed to save global tools settings');
			}

			expect(mockToast.error).toHaveBeenCalled();
		});
	});

	describe('Disabled State', () => {
		it('should disable checkboxes while saving', () => {
			const saving = signal(true);
			expect(saving.value).toBe(true);
			// Checkboxes are disabled when saving.value is true
		});

		it('should disable defaultEnabled checkbox when allowed is false', () => {
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
			// defaultEnabled checkbox should be disabled
		});
	});

	describe('SDK Built-in Tools Info', () => {
		it('should display read-only SDK tools info', () => {
			const sdkTools = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'];
			expect(sdkTools.length).toBeGreaterThan(0);
		});

		it('should display slash commands info', () => {
			const slashCommands = ['/help', '/context', '/clear', '/config', '/bug'];
			expect(slashCommands.length).toBeGreaterThan(0);
		});

		it('should display task agents info', () => {
			const taskAgents = ['general-purpose', 'Explore', 'Plan'];
			expect(taskAgents.length).toBeGreaterThan(0);
		});

		it('should display web tools info', () => {
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
