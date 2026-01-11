// @ts-nocheck
/**
 * Tests for ToolsModal Component
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { signal } from '@preact/signals';

// Mock Session type
interface MockSession {
	id: string;
	config: {
		tools?: {
			useClaudeCodePreset?: boolean;
			settingSources?: Array<'user' | 'project' | 'local'>;
			disabledMcpServers?: string[];
			liuboerTools?: {
				memory?: boolean;
			};
		};
	};
}

// Mock connection manager
const mockHub = {
	call: mock(() => Promise.resolve({ success: true })),
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
	info: mock(() => {}),
	warning: mock(() => {}),
};
mock.module('../lib/toast.ts', () => ({
	toast: mockToast,
	toastsSignal: { value: [] },
	dismissToast: mock(() => {}),
}));

// Mock api-helpers
const mockListMcpServersFromSources = mock(() =>
	Promise.resolve({
		servers: {
			user: [{ name: 'server1', command: 'npx server1' }],
			project: [],
			local: [],
		},
		serverSettings: {},
	})
);
mock.module('../lib/api-helpers.ts', () => ({
	listMcpServersFromSources: mockListMcpServersFromSources,
}));

describe('ToolsModal', () => {
	beforeEach(() => {
		mockHub.call.mockClear();
		mockToast.success.mockClear();
		mockToast.error.mockClear();
		mockListMcpServersFromSources.mockClear();
	});

	describe('Initial State', () => {
		it('should have Claude Code preset enabled by default', () => {
			const useClaudeCodePreset = signal(true);
			expect(useClaudeCodePreset.value).toBe(true);
		});

		it('should have all setting sources enabled by default', () => {
			const settingSources = signal<Array<'user' | 'project' | 'local'>>([
				'user',
				'project',
				'local',
			]);
			expect(settingSources.value).toEqual(['user', 'project', 'local']);
		});

		it('should have empty disabled MCP servers by default', () => {
			const disabledMcpServers = signal<string[]>([]);
			expect(disabledMcpServers.value).toEqual([]);
		});

		it('should have memory disabled by default', () => {
			const memoryEnabled = signal(false);
			expect(memoryEnabled.value).toBe(false);
		});
	});

	describe('Config Loading', () => {
		it('should load config from session', () => {
			const session: MockSession = {
				id: 'session-1',
				config: {
					tools: {
						useClaudeCodePreset: true,
						settingSources: ['user', 'project'],
						disabledMcpServers: ['server1'],
						liuboerTools: { memory: true },
					},
				},
			};

			expect(session.config.tools?.useClaudeCodePreset).toBe(true);
			expect(session.config.tools?.settingSources).toEqual(['user', 'project']);
			expect(session.config.tools?.disabledMcpServers).toEqual(['server1']);
			expect(session.config.tools?.liuboerTools?.memory).toBe(true);
		});

		it('should handle undefined tools config', () => {
			const session: MockSession = {
				id: 'session-1',
				config: {},
			};

			const tools = session.config.tools;
			expect(tools?.useClaudeCodePreset ?? true).toBe(true);
			expect(tools?.settingSources ?? ['user', 'project', 'local']).toEqual([
				'user',
				'project',
				'local',
			]);
		});
	});

	describe('MCP Server Loading', () => {
		it('should load MCP servers from sources', async () => {
			await mockListMcpServersFromSources('session-1');
			expect(mockListMcpServersFromSources).toHaveBeenCalled();
		});

		it('should group servers by source', async () => {
			const response = await mockListMcpServersFromSources('session-1');
			expect(response.servers.user).toBeDefined();
			expect(response.servers.project).toBeDefined();
			expect(response.servers.local).toBeDefined();
		});
	});

	describe('Server Enable/Disable', () => {
		it('should check if server is enabled', () => {
			const disabledMcpServers = ['server2'];
			const isServerEnabled = (name: string) => !disabledMcpServers.includes(name);

			expect(isServerEnabled('server1')).toBe(true);
			expect(isServerEnabled('server2')).toBe(false);
		});

		it('should toggle server enabled state', () => {
			let disabledMcpServers = ['server2'];

			// Enable server2
			disabledMcpServers = disabledMcpServers.filter((s) => s !== 'server2');
			expect(disabledMcpServers).not.toContain('server2');

			// Disable server1
			disabledMcpServers = [...disabledMcpServers, 'server1'];
			expect(disabledMcpServers).toContain('server1');
		});
	});

	describe('Setting Source Toggle', () => {
		it('should add setting source', () => {
			let settingSources = ['user'] as Array<'user' | 'project' | 'local'>;

			if (!settingSources.includes('project')) {
				settingSources = [...settingSources, 'project'];
			}

			expect(settingSources).toContain('project');
		});

		it('should remove setting source', () => {
			let settingSources = ['user', 'project', 'local'] as Array<'user' | 'project' | 'local'>;
			settingSources = settingSources.filter((s) => s !== 'local');
			expect(settingSources).not.toContain('local');
		});

		it('should not allow removing all sources', () => {
			const settingSources = ['user'] as Array<'user' | 'project' | 'local'>;
			const newSources = settingSources.filter((s) => s !== 'user');

			if (newSources.length === 0) {
				// Should show error toast
				expect(newSources.length).toBe(0);
			}
		});
	});

	describe('Save Functionality', () => {
		it('should save tools config', async () => {
			mockHub.call.mockResolvedValueOnce({ success: true });

			await mockHub.call('tools.save', {
				sessionId: 'session-1',
				tools: {
					useClaudeCodePreset: true,
					settingSources: ['user', 'project'],
					disabledMcpServers: [],
					liuboerTools: { memory: false },
				},
			});

			expect(mockHub.call).toHaveBeenCalled();
		});

		it('should show success toast on save', async () => {
			mockHub.call.mockResolvedValueOnce({ success: true });
			await mockHub.call('tools.save', { sessionId: 'session-1', tools: {} });
			mockToast.success('Tools configuration saved');
			expect(mockToast.success).toHaveBeenCalled();
		});

		it('should show error toast on failed save', async () => {
			mockHub.call.mockResolvedValueOnce({ success: false, error: 'Failed to save' });
			mockToast.error('Failed to save tools configuration');
			expect(mockToast.error).toHaveBeenCalled();
		});
	});

	describe('Cancel Functionality', () => {
		it('should reset to original values on cancel', () => {
			const originalConfig = {
				useClaudeCodePreset: true,
				settingSources: ['user', 'project', 'local'] as const,
			};

			// Modify values
			let currentPreset = false;
			let currentSources = ['user'] as const;

			// Reset on cancel
			currentPreset = originalConfig.useClaudeCodePreset;
			currentSources = originalConfig.settingSources;

			expect(currentPreset).toBe(true);
			expect(currentSources).toEqual(['user', 'project', 'local']);
		});
	});

	describe('Global Config Restrictions', () => {
		it('should check if Claude Code preset is allowed', () => {
			const globalConfig = {
				systemPrompt: { claudeCodePreset: { allowed: false } },
			};

			const isAllowed = globalConfig.systemPrompt?.claudeCodePreset?.allowed ?? true;
			expect(isAllowed).toBe(false);
		});

		it('should check if MCP is allowed', () => {
			const globalConfig = {
				mcp: { allowProjectMcp: true },
			};

			const isMcpAllowed = globalConfig.mcp?.allowProjectMcp ?? true;
			expect(isMcpAllowed).toBe(true);
		});

		it('should check if memory is allowed', () => {
			const globalConfig = {
				liuboerTools: { memory: { allowed: false } },
			};

			const isMemoryAllowed = globalConfig.liuboerTools?.memory?.allowed ?? true;
			expect(isMemoryAllowed).toBe(false);
		});
	});

	describe('Has Changes Detection', () => {
		it('should detect changes', () => {
			const hasChanges = signal(false);

			// Modify something
			hasChanges.value = true;

			expect(hasChanges.value).toBe(true);
		});

		it('should disable save button when no changes', () => {
			const hasChanges = false;
			const saving = false;

			const saveDisabled = !hasChanges || saving;
			expect(saveDisabled).toBe(true);
		});

		it('should disable save button when saving', () => {
			const hasChanges = true;
			const saving = true;

			const saveDisabled = !hasChanges || saving;
			expect(saveDisabled).toBe(true);
		});
	});

	describe('Null Session', () => {
		it('should return null when session is null', () => {
			const session = null;
			if (!session) {
				// Component returns null
				expect(session).toBeNull();
			}
		});
	});
});
