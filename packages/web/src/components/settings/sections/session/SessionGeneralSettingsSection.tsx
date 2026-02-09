/**
 * SessionGeneralSettingsSection - General session settings
 *
 * Session-specific overrides for model, thinking level, and UI preferences.
 */

import { useEffect, useState } from 'preact/hooks';
import type { ThinkingLevel } from '@neokai/shared';
import { SettingSelect } from '../../shared/SettingSelect.tsx';
import { SettingToggle } from '../../shared/SettingToggle.tsx';
import { SettingOverrideBadge } from '../../shared/SettingOverrideBadge.tsx';
import { globalSettings } from '../../../../lib/state.ts';
import { connectionManager } from '../../../../lib/connection-manager';
import { toast } from '../../../../lib/toast';

const MODEL_OPTIONS = [
	{ value: '', label: 'Use Global Default' },
	{ value: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5' },
	{ value: 'claude-opus-4-5-20251101', label: 'Opus 4.5' },
	{ value: 'claude-haiku-3-5-20241022', label: 'Haiku 3.5' },
] as const;

const THINKING_LEVEL_OPTIONS: Array<{
	value: ThinkingLevel | '';
	label: string;
	description: string;
}> = [
	{
		value: '',
		label: 'Use Global Default',
		description: 'Use the global thinking level setting',
	},
	{
		value: 'auto',
		label: 'Auto',
		description: 'No thinking budget - SDK default behavior',
	},
	{
		value: 'think8k',
		label: 'Think 8k',
		description: '8,000 token thinking budget',
	},
	{
		value: 'think16k',
		label: 'Think 16k',
		description: '16,000 token thinking budget',
	},
	{
		value: 'think32k',
		label: 'Think 32k',
		description: '32,000 token thinking budget',
	},
];

export function SessionGeneralSettingsSection({ sessionId }: { sessionId: string }) {
	const global = globalSettings.value;
	const [overrides, setOverrides] = useState<{
		model?: string;
		thinkingLevel?: ThinkingLevel;
		autoScroll?: boolean;
		coordinatorMode?: boolean;
	}>({});
	const [loading, setLoading] = useState(true);

	// Fetch session overrides on mount
	useEffect(() => {
		const fetchOverrides = async () => {
			try {
				setLoading(true);
				const hub = await connectionManager.getHub();
				const result = (await hub.call('settings.session.get', { sessionId })) as {
					overrides: typeof overrides;
				};
				setOverrides(result.overrides);
			} catch (error) {
				console.error('Failed to fetch session settings:', error);
			} finally {
				setLoading(false);
			}
		};
		fetchOverrides();
	}, [sessionId]);

	const handleModelChange = async (value: string) => {
		try {
			const hub = await connectionManager.getHub();
			// Empty string means "use global default" (no override)
			const updates = value ? { model: value } : { model: undefined };
			await hub.call('settings.session.update', { sessionId, updates });
			setOverrides((prev) => ({ ...prev, model: value || undefined }));
		} catch (error) {
			console.error('Failed to update model:', error);
			toast.error('Failed to update model');
		}
	};

	const handleThinkingLevelChange = async (value: string) => {
		try {
			const hub = await connectionManager.getHub();
			// Empty string means "use global default" (no override)
			const updates = value
				? { thinkingLevel: value as ThinkingLevel }
				: { thinkingLevel: undefined };
			await hub.call('settings.session.update', { sessionId, updates });
			setOverrides((prev) => ({ ...prev, thinkingLevel: value as ThinkingLevel | undefined }));
		} catch (error) {
			console.error('Failed to update thinking level:', error);
			toast.error('Failed to update thinking level');
		}
	};

	const handleAutoScrollChange = async (checked: boolean) => {
		try {
			const hub = await connectionManager.getHub();
			// If value matches global, remove override; otherwise set it
			const shouldOverride = checked !== (global?.autoScroll ?? true);
			const updates = shouldOverride ? { autoScroll: checked } : { autoScroll: undefined };
			await hub.call('settings.session.update', { sessionId, updates });
			setOverrides((prev) => ({ ...prev, autoScroll: shouldOverride ? checked : undefined }));
		} catch (error) {
			console.error('Failed to update auto-scroll:', error);
			toast.error('Failed to update auto-scroll');
		}
	};

	const handleCoordinatorModeChange = async (checked: boolean) => {
		try {
			const hub = await connectionManager.getHub();
			// If value matches global, remove override; otherwise set it
			const shouldOverride = checked !== (global?.coordinatorMode ?? false);
			const updates = shouldOverride
				? { coordinatorMode: checked }
				: { coordinatorMode: undefined };
			await hub.call('settings.session.update', { sessionId, updates });
			setOverrides((prev) => ({ ...prev, coordinatorMode: shouldOverride ? checked : undefined }));
		} catch (error) {
			console.error('Failed to update coordinator mode:', error);
			toast.error('Failed to update coordinator mode');
		}
	};

	// Get effective values (global or override)
	const effectiveAutoScroll = overrides.autoScroll ?? global?.autoScroll ?? true;
	const effectiveCoordinatorMode = overrides.coordinatorMode ?? global?.coordinatorMode ?? false;

	if (loading) {
		return <div class="text-gray-400">Loading settings...</div>;
	}

	return (
		<div class="space-y-6">
			{/* Model */}
			<div class="rounded-lg border border-dark-700 bg-dark-800 p-4">
				<div class="mb-4 flex items-center justify-between">
					<h3 class="text-sm font-medium text-gray-200">Model</h3>
					{overrides.model !== undefined ? (
						<SettingOverrideBadge type="overridden" />
					) : (
						<SettingOverrideBadge type="inherited" />
					)}
				</div>
				<div class="space-y-4">
					<SettingSelect
						label="Model Override"
						description="Select a model for this session, or use global default"
						value={overrides.model ?? ''}
						options={MODEL_OPTIONS}
						onChange={handleModelChange}
					/>
					<p class="text-xs text-gray-500">
						Global default: {global?.model ? global.model : 'Sonnet (default)'}
					</p>
				</div>
			</div>

			{/* Thinking Level */}
			<div class="rounded-lg border border-dark-700 bg-dark-800 p-4">
				<div class="mb-4 flex items-center justify-between">
					<h3 class="text-sm font-medium text-gray-200">Extended Thinking</h3>
					{overrides.thinkingLevel !== undefined ? (
						<SettingOverrideBadge type="overridden" />
					) : (
						<SettingOverrideBadge type="inherited" />
					)}
				</div>
				<div class="space-y-4">
					<SettingSelect
						label="Thinking Level Override"
						description="Select thinking level for this session, or use global default"
						value={overrides.thinkingLevel ?? ''}
						options={THINKING_LEVEL_OPTIONS}
						onChange={handleThinkingLevelChange}
					/>
					<p class="text-xs text-gray-500">Global default: {global?.thinkingLevel ?? 'auto'}</p>
				</div>
			</div>

			{/* UI Preferences */}
			<div class="rounded-lg border border-dark-700 bg-dark-800 p-4">
				<div class="mb-4 flex items-center justify-between">
					<h3 class="text-sm font-medium text-gray-200">UI Preferences</h3>
				</div>
				<div class="space-y-3">
					<SettingToggle
						label="Auto-scroll"
						description={
							overrides.autoScroll !== undefined
								? `Custom: ${effectiveAutoScroll ? 'Enabled' : 'Disabled'} (Global: ${(global?.autoScroll ?? true) ? 'Enabled' : 'Disabled'})`
								: `Using global default (${(global?.autoScroll ?? true) ? 'Enabled' : 'Disabled'})`
						}
						checked={effectiveAutoScroll}
						onChange={handleAutoScrollChange}
						inherited={overrides.autoScroll === undefined}
					/>
					<SettingToggle
						label="Coordinator Mode"
						description={
							overrides.coordinatorMode !== undefined
								? `Custom: ${effectiveCoordinatorMode ? 'Enabled' : 'Disabled'} (Global: ${(global?.coordinatorMode ?? false) ? 'Enabled' : 'Disabled'})`
								: `Using global default (${(global?.coordinatorMode ?? false) ? 'Enabled' : 'Disabled'})`
						}
						checked={effectiveCoordinatorMode}
						onChange={handleCoordinatorModeChange}
						inherited={overrides.coordinatorMode === undefined}
					/>
				</div>
			</div>

			{/* Reset to Defaults */}
			{(overrides.model !== undefined ||
				overrides.thinkingLevel !== undefined ||
				overrides.autoScroll !== undefined ||
				overrides.coordinatorMode !== undefined) && (
				<div class="rounded-lg border border-dark-700 bg-dark-800 p-4">
					<h3 class="mb-4 text-sm font-medium text-gray-200">Reset to Defaults</h3>
					<p class="mb-4 text-sm text-gray-400">
						This session has custom settings. You can reset to use global defaults.
					</p>
					<button
						type="button"
						onClick={async () => {
							try {
								const hub = await connectionManager.getHub();
								await hub.call('settings.session.reset', { sessionId });
								setOverrides({});
								toast.success('Session settings reset to defaults');
							} catch (error) {
								console.error('Failed to reset session settings:', error);
								toast.error('Failed to reset session settings');
							}
						}}
						class="rounded-lg bg-dark-700 px-4 py-2 text-sm font-medium text-gray-200 transition-colors hover:bg-dark-600"
					>
						Reset All to Global Defaults
					</button>
				</div>
			)}
		</div>
	);
}
