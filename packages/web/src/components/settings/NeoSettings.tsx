import { useEffect, useState } from 'preact/hooks';
import { connectionManager } from '../../lib/connection-manager';
import { neoStore } from '../../lib/neo-store';
import { toast } from '../../lib/toast.ts';
import { SettingsSection, SettingsRow, SettingsSelect } from './SettingsSection.tsx';

type NeoSecurityMode = 'conservative' | 'balanced' | 'autonomous';

const SECURITY_MODE_OPTIONS: Array<{ value: NeoSecurityMode; label: string; description: string }> =
	[
		{
			value: 'conservative',
			label: 'Conservative',
			description: 'Confirm every write action before executing',
		},
		{
			value: 'balanced',
			label: 'Balanced (default)',
			description:
				'Auto-execute low-risk actions; confirm medium-risk; require explicit phrasing for irreversible changes',
		},
		{
			value: 'autonomous',
			label: 'Autonomous',
			description: 'Execute all actions immediately without confirmation',
		},
	];

const MODEL_OPTIONS = [
	{ value: '', label: 'App default' },
	{ value: 'sonnet', label: 'Claude Sonnet 4' },
	{ value: 'opus', label: 'Claude Opus 4' },
	{ value: 'haiku', label: 'Claude Haiku 3.5' },
];

interface NeoSettingsState {
	securityMode: NeoSecurityMode;
	model: string | null;
}

export function NeoSettings() {
	const [settings, setSettings] = useState<NeoSettingsState>({
		securityMode: 'balanced',
		model: null,
	});
	const [isUpdatingMode, setIsUpdatingMode] = useState(false);
	const [isUpdatingModel, setIsUpdatingModel] = useState(false);
	const [isLoading, setIsLoading] = useState(true);
	const [showClearConfirm, setShowClearConfirm] = useState(false);
	const [isClearing, setIsClearing] = useState(false);

	useEffect(() => {
		let cancelled = false;
		const load = async () => {
			try {
				const hub = await connectionManager.getHub();
				const response = await hub.request<{ securityMode: NeoSecurityMode; model: string | null }>(
					'neo.getSettings',
					{}
				);
				if (!cancelled) {
					setSettings({
						securityMode: response.securityMode ?? 'balanced',
						model: response.model ?? null,
					});
				}
			} catch {
				if (!cancelled) {
					toast.error('Failed to load Neo settings');
				}
			} finally {
				if (!cancelled) {
					setIsLoading(false);
				}
			}
		};
		load();
		return () => {
			cancelled = true;
		};
	}, []);

	const handleSecurityModeChange = async (value: string) => {
		const mode = value as NeoSecurityMode;
		const prev = settings.securityMode;
		setSettings((s) => ({ ...s, securityMode: mode }));
		setIsUpdatingMode(true);
		try {
			const hub = await connectionManager.getHub();
			await hub.request('neo.updateSettings', { securityMode: mode });
			toast.success('Security mode updated');
		} catch {
			toast.error('Failed to update security mode');
			setSettings((s) => ({ ...s, securityMode: prev }));
		} finally {
			setIsUpdatingMode(false);
		}
	};

	const handleModelChange = async (value: string) => {
		// Empty string means "app default" — send null to clear the override
		const model = value === '' ? null : value;
		const prev = settings.model;
		setSettings((s) => ({ ...s, model }));
		setIsUpdatingModel(true);
		try {
			const hub = await connectionManager.getHub();
			await hub.request('neo.updateSettings', { model });
			toast.success('Model updated');
		} catch {
			toast.error('Failed to update Neo model');
			setSettings((s) => ({ ...s, model: prev }));
		} finally {
			setIsUpdatingModel(false);
		}
	};

	const handleClearSession = async () => {
		setIsClearing(true);
		try {
			const result = await neoStore.clearSession();
			if (result.success) {
				toast.success('Neo session cleared');
			} else {
				toast.error(result.error ?? 'Failed to clear session');
			}
		} catch {
			toast.error('Failed to clear Neo session');
		} finally {
			setIsClearing(false);
			setShowClearConfirm(false);
		}
	};

	const selectedMode = SECURITY_MODE_OPTIONS.find((o) => o.value === settings.securityMode);

	if (isLoading) {
		return (
			<SettingsSection title="Neo Agent">
				<div class="text-sm text-gray-500">Loading…</div>
			</SettingsSection>
		);
	}

	return (
		<SettingsSection title="Neo Agent">
			<SettingsRow
				label="Security Mode"
				description={
					selectedMode?.description ?? 'Controls how Neo confirms actions before executing them'
				}
			>
				<SettingsSelect
					value={settings.securityMode}
					onChange={handleSecurityModeChange}
					options={SECURITY_MODE_OPTIONS}
					disabled={isUpdatingMode}
				/>
			</SettingsRow>

			<SettingsRow label="Model" description="Model used by Neo (overrides app default when set)">
				<SettingsSelect
					value={settings.model ?? ''}
					onChange={handleModelChange}
					options={MODEL_OPTIONS}
					disabled={isUpdatingModel}
				/>
			</SettingsRow>

			<SettingsRow
				label="Clear Session"
				description="Erase Neo's conversation history and start fresh"
			>
				{showClearConfirm ? (
					<div class="flex items-center gap-2">
						<span class="text-xs text-gray-400">Are you sure?</span>
						<button
							type="button"
							onClick={handleClearSession}
							disabled={isClearing}
							class="px-3 py-1.5 text-xs font-medium rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 transition-colors"
						>
							{isClearing ? 'Clearing…' : 'Confirm'}
						</button>
						<button
							type="button"
							data-testid="neo-settings-cancel-clear"
							onClick={() => setShowClearConfirm(false)}
							disabled={isClearing}
							class="px-3 py-1.5 text-xs font-medium rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-300 disabled:opacity-50 transition-colors"
						>
							Cancel
						</button>
					</div>
				) : (
					<button
						type="button"
						onClick={() => setShowClearConfirm(true)}
						class="px-3 py-1.5 text-xs font-medium rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-300 transition-colors"
					>
						Clear Session
					</button>
				)}
			</SettingsRow>
		</SettingsSection>
	);
}
