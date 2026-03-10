import { useEffect, useState } from 'preact/hooks';
import { globalSettings } from '../../lib/state.ts';
import { updateGlobalSettings } from '../../lib/api-helpers.ts';
import { toast } from '../../lib/toast.ts';
import type { PermissionMode, ThinkingLevel } from '@neokai/shared';
import {
	SettingsSection,
	SettingsRow,
	SettingsSelect,
	SettingsToggle,
} from './SettingsSection.tsx';

const MODEL_OPTIONS = [
	{ value: 'sonnet', label: 'Claude Sonnet 4' },
	{ value: 'opus', label: 'Claude Opus 4' },
	{ value: 'haiku', label: 'Claude Haiku 3.5' },
];

const PERMISSION_MODE_OPTIONS = [
	{ value: 'default', label: 'Default' },
	{ value: 'acceptEdits', label: 'Accept Edits' },
	{ value: 'plan', label: 'Plan Mode' },
	{ value: 'delegate', label: 'Delegate' },
];

const THINKING_LEVEL_OPTIONS = [
	{ value: 'auto', label: 'Auto' },
	{ value: 'think8k', label: 'Think 8k' },
	{ value: 'think16k', label: 'Think 16k' },
	{ value: 'think32k', label: 'Think 32k' },
];

export function GeneralSettings() {
	const settings = globalSettings.value;
	const [localModel, setLocalModel] = useState(settings?.model ?? 'sonnet');
	const [localPermissionMode, setLocalPermissionMode] = useState<PermissionMode>(
		settings?.permissionMode ?? 'default'
	);
	const [localAutoScroll, setLocalAutoScroll] = useState(settings?.autoScroll ?? true);
	const [localThinkingLevel, setLocalThinkingLevel] = useState<ThinkingLevel>(
		settings?.thinkingLevel ?? 'auto'
	);
	const [localShowArchived, setLocalShowArchived] = useState(settings?.showArchived ?? false);
	const [isUpdating, setIsUpdating] = useState(false);

	// Sync local state when global settings change
	useEffect(() => {
		if (settings) {
			setLocalModel(settings.model ?? 'sonnet');
			setLocalPermissionMode(settings.permissionMode ?? 'default');
			setLocalAutoScroll(settings.autoScroll ?? true);
			setLocalThinkingLevel(settings.thinkingLevel ?? 'auto');
			setLocalShowArchived(settings.showArchived ?? false);
		}
	}, [settings]);

	const handleModelChange = async (value: string) => {
		setLocalModel(value);
		setIsUpdating(true);
		try {
			await updateGlobalSettings({ model: value });
		} catch {
			toast.error('Failed to update model setting');
			// Revert on error
			setLocalModel(settings?.model ?? 'sonnet');
		} finally {
			setIsUpdating(false);
		}
	};

	const handlePermissionModeChange = async (value: string) => {
		const mode = value as PermissionMode;
		setLocalPermissionMode(mode);
		setIsUpdating(true);
		try {
			await updateGlobalSettings({ permissionMode: mode });
		} catch {
			toast.error('Failed to update permission mode');
			// Revert on error
			setLocalPermissionMode(settings?.permissionMode ?? 'default');
		} finally {
			setIsUpdating(false);
		}
	};

	const handleAutoScrollChange = async (value: boolean) => {
		setLocalAutoScroll(value);
		setIsUpdating(true);
		try {
			await updateGlobalSettings({ autoScroll: value });
		} catch {
			toast.error('Failed to update auto-scroll setting');
			// Revert on error
			setLocalAutoScroll(settings?.autoScroll ?? true);
		} finally {
			setIsUpdating(false);
		}
	};

	const handleThinkingLevelChange = async (value: string) => {
		const level = value as ThinkingLevel;
		setLocalThinkingLevel(level);
		setIsUpdating(true);
		try {
			await updateGlobalSettings({ thinkingLevel: level });
		} catch {
			toast.error('Failed to update thinking level');
			setLocalThinkingLevel(settings?.thinkingLevel ?? 'auto');
		} finally {
			setIsUpdating(false);
		}
	};

	const handleShowArchivedChange = async (value: boolean) => {
		setLocalShowArchived(value);
		setIsUpdating(true);
		try {
			await updateGlobalSettings({ showArchived: value });
		} catch {
			toast.error('Failed to update archived sessions setting');
			setLocalShowArchived(settings?.showArchived ?? false);
		} finally {
			setIsUpdating(false);
		}
	};

	return (
		<SettingsSection title="General">
			<SettingsRow label="Default Model" description="Model for new sessions">
				<SettingsSelect
					value={localModel}
					onChange={handleModelChange}
					options={MODEL_OPTIONS}
					disabled={isUpdating}
				/>
			</SettingsRow>

			<SettingsRow label="Permission Mode" description="How Claude asks for permissions">
				<SettingsSelect
					value={localPermissionMode}
					onChange={handlePermissionModeChange}
					options={PERMISSION_MODE_OPTIONS}
					disabled={isUpdating}
				/>
			</SettingsRow>

			<SettingsRow label="Default Thinking Level" description="Thinking budget for new sessions">
				<SettingsSelect
					value={localThinkingLevel}
					onChange={handleThinkingLevelChange}
					options={THINKING_LEVEL_OPTIONS}
					disabled={isUpdating}
				/>
			</SettingsRow>

			<SettingsRow label="Auto-scroll" description="Auto-scroll to new messages">
				<SettingsToggle
					checked={localAutoScroll}
					onChange={handleAutoScrollChange}
					disabled={isUpdating}
				/>
			</SettingsRow>

			<SettingsRow label="Show Archived Sessions" description="Display archived sessions in lists">
				<SettingsToggle
					checked={localShowArchived}
					onChange={handleShowArchivedChange}
					disabled={isUpdating}
				/>
			</SettingsRow>
		</SettingsSection>
	);
}
