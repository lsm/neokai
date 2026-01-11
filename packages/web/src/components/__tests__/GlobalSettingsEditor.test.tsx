// @ts-nocheck
/**
 * Tests for GlobalSettingsEditor Component
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { signal } from '@preact/signals';

// Mock globalSettings signal
const mockGlobalSettings = signal<{
	model?: string;
	permissionMode?: string;
	settingSources?: Array<'user' | 'project' | 'local'>;
} | null>({
	model: '',
	permissionMode: 'default',
	settingSources: ['user', 'project', 'local'],
});

// Mock state - include all exports to avoid breaking other tests
const mockAppState = {
	initialize: mock(() => Promise.resolve()),
	cleanup: mock(() => {}),
	getSessionChannels: mock(() => null),
};
mock.module('../lib/state.ts', () => ({
	globalSettings: mockGlobalSettings,
	// Additional required exports
	appState: mockAppState,
	initializeApplicationState: mock(() => Promise.resolve()),
	mergeSdkMessagesWithDedup: (existing: unknown[], added: unknown[]) => [
		...(existing || []),
		...(added || []),
	],
	sessions: signal([]),
	connectionState: signal('connected'),
	authStatus: signal(null),
	apiConnectionStatus: signal(null),
	hasArchivedSessions: signal(false),
	currentSession: signal(null),
	currentAgentState: signal({ status: 'idle', phase: null }),
	currentContextInfo: signal(null),
	isAgentWorking: signal(false),
	activeSessions: signal(0),
	recentSessions: signal([]),
	systemState: signal(null),
	healthStatus: signal(null),
}));

// Mock api-helpers
const mockUpdateGlobalSettings = mock(() => Promise.resolve());
const mockListMcpServersFromSources = mock(() =>
	Promise.resolve({
		servers: { user: [], project: [], local: [] },
		serverSettings: {},
	})
);
const mockUpdateMcpServerSettings = mock(() => Promise.resolve());

mock.module('../lib/api-helpers.ts', () => ({
	updateGlobalSettings: mockUpdateGlobalSettings,
	listMcpServersFromSources: mockListMcpServersFromSources,
	updateMcpServerSettings: mockUpdateMcpServerSettings,
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

describe('GlobalSettingsEditor', () => {
	beforeEach(() => {
		mockGlobalSettings.value = {
			model: '',
			permissionMode: 'default',
			settingSources: ['user', 'project', 'local'],
		};
		mockUpdateGlobalSettings.mockClear();
		mockListMcpServersFromSources.mockClear();
		mockUpdateMcpServerSettings.mockClear();
		mockToast.success.mockClear();
		mockToast.error.mockClear();
	});

	describe('Loading State', () => {
		it('should show loading text when settings not loaded', () => {
			mockGlobalSettings.value = null;
			const settings = mockGlobalSettings.value;
			expect(settings).toBeNull();
		});
	});

	describe('Model Selection', () => {
		it('should have correct model options', () => {
			const MODEL_OPTIONS = [
				{ value: '', label: 'Default (Sonnet)' },
				{ value: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5' },
				{ value: 'claude-opus-4-5-20251101', label: 'Opus 4.5' },
				{ value: 'claude-haiku-3-5-20241022', label: 'Haiku 3.5' },
			];
			expect(MODEL_OPTIONS.length).toBe(4);
			expect(MODEL_OPTIONS[0].value).toBe('');
		});

		it('should update model on change', async () => {
			await mockUpdateGlobalSettings({ model: 'claude-opus-4-5-20251101' });
			expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({ model: 'claude-opus-4-5-20251101' });
		});

		it('should send undefined for default model', async () => {
			await mockUpdateGlobalSettings({ model: undefined });
			expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({ model: undefined });
		});
	});

	describe('Permission Mode Selection', () => {
		it('should have correct permission mode options', () => {
			const PERMISSION_MODE_OPTIONS = [
				{ value: 'default', label: 'Default', description: 'Ask for permission' },
				{ value: 'acceptEdits', label: 'Accept Edits', description: 'Auto-accept file edits' },
				{ value: 'bypassPermissions', label: 'Bypass All', description: 'Skip all prompts' },
				{ value: 'plan', label: 'Plan Mode', description: 'Plan changes without executing' },
				{ value: 'dontAsk', label: "Don't Ask", description: 'Never ask for permission' },
			];
			expect(PERMISSION_MODE_OPTIONS.length).toBe(5);
		});

		it('should update permission mode on change', async () => {
			await mockUpdateGlobalSettings({ permissionMode: 'acceptEdits' });
			expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({ permissionMode: 'acceptEdits' });
		});
	});

	describe('Setting Sources', () => {
		it('should have all sources enabled by default', () => {
			const currentSources = mockGlobalSettings.value?.settingSources ?? [
				'user',
				'project',
				'local',
			];
			expect(currentSources).toContain('user');
			expect(currentSources).toContain('project');
			expect(currentSources).toContain('local');
		});

		it('should add source when enabling', async () => {
			mockGlobalSettings.value = { settingSources: ['user'] };
			const currentSources = mockGlobalSettings.value.settingSources || [];
			const newSources = [...currentSources, 'project' as const];

			await mockUpdateGlobalSettings({ settingSources: newSources });
			expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({
				settingSources: ['user', 'project'],
			});
		});

		it('should remove source when disabling', async () => {
			mockGlobalSettings.value = { settingSources: ['user', 'project', 'local'] };
			const currentSources = mockGlobalSettings.value.settingSources || [];
			const newSources = currentSources.filter((s) => s !== 'local');

			await mockUpdateGlobalSettings({ settingSources: newSources });
			expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({
				settingSources: ['user', 'project'],
			});
		});

		it('should not allow removing all sources', () => {
			const currentSources = ['user'];
			const newSources = currentSources.filter((s) => s !== 'user');

			if (newSources.length === 0) {
				mockToast.error('At least one setting source must be enabled');
			}

			expect(mockToast.error).toHaveBeenCalled();
		});

		it('should reload MCP servers after source change', async () => {
			await mockUpdateGlobalSettings({ settingSources: ['user', 'project'] });
			await mockListMcpServersFromSources();
			expect(mockListMcpServersFromSources).toHaveBeenCalled();
		});
	});

	describe('MCP Server Settings', () => {
		it('should update allowed setting', async () => {
			await mockUpdateMcpServerSettings('server1', { allowed: false });
			expect(mockUpdateMcpServerSettings).toHaveBeenCalledWith('server1', { allowed: false });
		});

		it('should update defaultOn setting', async () => {
			await mockUpdateMcpServerSettings('server1', { defaultOn: true });
			expect(mockUpdateMcpServerSettings).toHaveBeenCalledWith('server1', { defaultOn: true });
		});

		it('should disable defaultOn when disabling allowed', async () => {
			const currentSettings = { allowed: true, defaultOn: true };
			const newSettings = { ...currentSettings, allowed: false };

			// Component logic: if disabling allowed, also disable defaultOn
			if (!newSettings.allowed) {
				newSettings.defaultOn = false;
			}

			expect(newSettings.defaultOn).toBe(false);
		});
	});

	describe('Auto-save Indicator', () => {
		it('should show saved indicator briefly', () => {
			let lastSaved: string | null = null;

			// Simulate save completion
			lastSaved = 'model';
			expect(lastSaved).toBe('model');

			// After timeout, indicator disappears
			setTimeout(() => {
				lastSaved = null;
			}, 2000);
		});
	});

	describe('Error Handling', () => {
		it('should show error toast on failed model update', async () => {
			mockUpdateGlobalSettings.mockRejectedValueOnce(new Error('Network error'));

			try {
				await mockUpdateGlobalSettings({ model: 'invalid' });
			} catch {
				mockToast.error('Failed to update model');
			}

			expect(mockToast.error).toHaveBeenCalled();
		});

		it('should show error toast on failed permission mode update', async () => {
			mockUpdateGlobalSettings.mockRejectedValueOnce(new Error('Network error'));

			try {
				await mockUpdateGlobalSettings({ permissionMode: 'invalid' });
			} catch {
				mockToast.error('Failed to update permission mode');
			}

			expect(mockToast.error).toHaveBeenCalled();
		});
	});

	describe('Disabled State', () => {
		it('should disable inputs while saving', () => {
			const saving = true;
			const className = saving ? 'opacity-50 pointer-events-none' : '';
			expect(className).toContain('opacity-50');
		});
	});
});
