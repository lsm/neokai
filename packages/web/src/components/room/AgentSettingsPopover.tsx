/**
 * AgentSettingsPopover - Floating panel for configuring a single agent
 *
 * Opened by clicking an agent avatar in the Room header bar.
 * Shows model picker, sub-agent CLIs, sub-agent models, and save button.
 */

import { useSignal } from '@preact/signals';
import { useEffect, useRef, useCallback } from 'preact/hooks';
import type { Room } from '@neokai/shared';
import { connectionManager } from '../../lib/connection-manager';
import { roomStore } from '../../lib/room-store';
import { toast } from '../../lib/toast';
import { t } from '../../lib/i18n';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { ModelPicker, ModelTagsInput, CliTagsInput } from './RoomAgents';
import {
	type ModelInfo,
	type CliAgentInfo,
	type SubagentConfig,
	type AgentModels,
	type AgentSubagents,
	type AgentRole,
	detectFamily,
} from './agent-shared';

export interface AgentSettingsPopoverProps {
	room: Room;
	agent: AgentRole;
	bgClass: string;
	textClass: string;
	initial: string;
	onClose: () => void;
}

export function AgentSettingsPopover({
	room,
	agent,
	bgClass,
	textClass,
	initial,
	onClose,
}: AgentSettingsPopoverProps) {
	const ref = useRef<HTMLDivElement>(null);
	const availableModels = useSignal<ModelInfo[]>([]);
	const cliAgents = useSignal<CliAgentInfo[]>([]);
	const isLoadingModels = useSignal(true);
	const isSaving = useSignal(false);

	// Local state for this agent's config
	const selectedModel = useSignal('');
	const subagents = useSignal<SubagentConfig[]>([]);

	// Load config from room
	useEffect(() => {
		const config = room.config ?? {};
		const models = (config.agentModels as AgentModels) ?? {};
		selectedModel.value = models[agent.key as keyof AgentModels] ?? '';

		const savedSubagents = config.agentSubagents as AgentSubagents | undefined;
		if (savedSubagents) {
			subagents.value = [...(savedSubagents[agent.key as keyof AgentSubagents] ?? [])];
		} else {
			// Migrate legacy reviewers for leader
			if (agent.key === 'leader') {
				const legacy = config.reviewers as SubagentConfig[] | undefined;
				subagents.value = legacy?.length ? [...legacy] : [];
			} else {
				subagents.value = [];
			}
		}
	}, [room, agent.key]);

	// Fetch models + CLI agents
	useEffect(() => {
		const fetchData = async () => {
			isLoadingModels.value = true;
			try {
				const hub = await connectionManager.getHub();
				const [modelsRes, cliRes] = await Promise.all([
					hub.request<{
						models: Array<{ id: string; display_name?: string; name?: string }>;
					}>('models.list'),
					hub
						.request<{ agents: CliAgentInfo[] }>('agents.cli.list')
						.catch(() => ({ agents: [] }) as { agents: CliAgentInfo[] }),
				]);
				availableModels.value = (modelsRes.models ?? []).map((m) => ({
					id: m.id,
					name: m.display_name ?? m.name ?? m.id,
					family: detectFamily(m.id),
				}));
				cliAgents.value = cliRes.agents ?? [];
			} catch {
				// Silent fail
			} finally {
				isLoadingModels.value = false;
			}
		};
		fetchData();
	}, []);

	// Close on outside click
	useEffect(() => {
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				onClose();
			}
		};
		// Delay to avoid the opening click from immediately closing
		const timer = setTimeout(() => {
			document.addEventListener('mousedown', handler);
		}, 0);
		return () => {
			clearTimeout(timer);
			document.removeEventListener('mousedown', handler);
		};
	}, [onClose]);

	// Close on Escape
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose();
		};
		document.addEventListener('keydown', handler);
		return () => document.removeEventListener('keydown', handler);
	}, [onClose]);

	// Default model label
	const defaultModelLabel = (() => {
		if (!room.defaultModel) return 'Default';
		const m = availableModels.value.find((m) => m.id === room.defaultModel);
		return m ? `Default (${m.name})` : `Default (${room.defaultModel})`;
	})();

	// Sub-agent helpers
	const cliSubagents = subagents.value.filter((s) => s.type === 'cli');
	const sdkSubagents = subagents.value.filter((s) => s.type !== 'cli');

	const toggleCliAgent = useCallback(
		(cliAgent: CliAgentInfo) => {
			const isEnabled = subagents.value.some((r) => r.type === 'cli' && r.model === cliAgent.id);
			if (isEnabled) {
				subagents.value = subagents.value.filter(
					(r) => !(r.type === 'cli' && r.model === cliAgent.id)
				);
			} else {
				subagents.value = [...subagents.value, { model: cliAgent.id, type: 'cli' as const }];
			}
		},
		[subagents]
	);

	const changeCliModel = useCallback(
		(agentId: string, cliModel: string) => {
			subagents.value = subagents.value.map((r) => {
				if (r.type === 'cli' && r.model === agentId) {
					const next = { ...r };
					if (cliModel) {
						next.cliModel = cliModel;
					} else {
						delete next.cliModel;
					}
					return next;
				}
				return r;
			});
		},
		[subagents]
	);

	const addSdkSubagent = useCallback(
		(model: string) => {
			if (!model) return;
			if (subagents.value.some((r) => r.type !== 'cli' && r.model === model)) return;
			subagents.value = [...subagents.value, { model }];
		},
		[subagents]
	);

	const removeSdkSubagent = useCallback(
		(model: string) => {
			let removed = false;
			subagents.value = subagents.value.filter((r) => {
				if (!removed && r.type !== 'cli' && r.model === model) {
					removed = true;
					return false;
				}
				return true;
			});
		},
		[subagents]
	);

	// Change detection
	const hasChanges = (() => {
		const config = room.config ?? {};
		const origModels = (config.agentModels as AgentModels) ?? {};
		const origModel = origModels[agent.key as keyof AgentModels] ?? '';

		const savedSubagents = config.agentSubagents as AgentSubagents | undefined;
		let origSubs: SubagentConfig[] = [];
		if (savedSubagents) {
			origSubs = savedSubagents[agent.key as keyof AgentSubagents] ?? [];
		} else if (agent.key === 'leader') {
			origSubs = (config.reviewers as SubagentConfig[]) ?? [];
		}

		return (
			selectedModel.value !== origModel ||
			JSON.stringify(subagents.value) !== JSON.stringify(origSubs)
		);
	})();

	const handleSave = async () => {
		if (!hasChanges) return;
		isSaving.value = true;
		try {
			const config = room.config ?? {};
			const existingModels = (config.agentModels as AgentModels) ?? {};
			const existingSubagents = (config.agentSubagents as AgentSubagents) ?? {};

			// Update this agent's model
			const updatedModels = { ...existingModels };
			if (selectedModel.value) {
				updatedModels[agent.key as keyof AgentModels] = selectedModel.value;
			} else {
				delete updatedModels[agent.key as keyof AgentModels];
			}

			// Update this agent's subagents
			const cleanedSubs = subagents.value.filter((s) => s.model.trim());
			const updatedSubagents = { ...existingSubagents };
			if (cleanedSubs.length > 0) {
				updatedSubagents[agent.key as keyof AgentSubagents] = cleanedSubs;
			} else {
				delete updatedSubagents[agent.key as keyof AgentSubagents];
			}

			await roomStore.updateConfig({
				...config,
				agentModels: updatedModels,
				agentSubagents: updatedSubagents,
				reviewers: undefined,
			});
			toast.success(t('toast.agentConfigSaved'));
			onClose();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : t('toast.saveFailed'));
		} finally {
			isSaving.value = false;
		}
	};

	const disabled = isSaving.value;

	return (
		<div
			ref={ref}
			class="absolute top-full mt-2 right-0 bg-dark-800 border border-dark-600 rounded-xl shadow-2xl z-50 animate-slideIn"
			style={{ width: '360px' }}
		>
			{/* Header */}
			<div class="flex items-center gap-3 px-4 py-3 border-b border-dark-700">
				<span
					class={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold ${bgClass} ${textClass}`}
				>
					{initial}
				</span>
				<div class="min-w-0 flex-1">
					<div class="text-sm font-semibold text-gray-100">{agent.label}</div>
					<div class="text-xs text-gray-500">{agent.description}</div>
				</div>
				<button
					type="button"
					class="text-gray-500 hover:text-gray-300 transition-colors"
					onClick={onClose}
				>
					<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M6 18L18 6M6 6l12 12"
						/>
					</svg>
				</button>
			</div>

			{/* Body */}
			<div class="px-4 py-3 space-y-4">
				{/* Model selector */}
				<div>
					<div class="flex items-center justify-between gap-2">
						<label class="text-xs font-medium text-gray-400">{t('roomAgentPopover.model')}</label>
						<ModelPicker
							value={selectedModel.value}
							models={availableModels.value}
							loading={isLoadingModels.value}
							disabled={disabled}
							onChange={(model) => {
								selectedModel.value = model;
							}}
							placeholder={defaultModelLabel}
						/>
					</div>
				</div>

				{/* Sub Agent CLIs */}
				<div>
					<label class="text-xs font-medium text-gray-400 mb-1.5 block">
						{t('roomAgentPopover.subAgentClis')}
					</label>
					{isLoadingModels.value ? (
						<div class="flex items-center gap-2 text-xs text-gray-500 py-2">
							<Spinner size="sm" />
							{t('common.loading')}
						</div>
					) : (
						<CliTagsInput
							agents={cliAgents.value}
							selectedConfigs={cliSubagents}
							disabled={disabled}
							onToggle={toggleCliAgent}
							onChangeModel={changeCliModel}
						/>
					)}
				</div>

				{/* Sub Agent Models */}
				<div>
					<label class="text-xs font-medium text-gray-400 mb-1.5 block">
						{t('roomAgentPopover.subAgentModels')}
					</label>
					{isLoadingModels.value ? (
						<div class="flex items-center gap-2 text-xs text-gray-500 py-2">
							<Spinner size="sm" />
							{t('common.loading')}
						</div>
					) : (
						<ModelTagsInput
							models={availableModels.value}
							selected={sdkSubagents.map((s) => s.model).filter(Boolean)}
							loading={isLoadingModels.value}
							disabled={disabled}
							onAdd={addSdkSubagent}
							onRemove={removeSdkSubagent}
						/>
					)}
				</div>
			</div>

			{/* Footer */}
			<div class="flex items-center justify-end gap-2 px-4 py-3 border-t border-dark-700">
				<button
					type="button"
					class="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors"
					onClick={onClose}
				>
					{t('common.cancel')}
				</button>
				<Button
					size="sm"
					onClick={handleSave}
					disabled={!hasChanges || disabled}
					loading={isSaving.value}
				>
					{t('common.save')}
				</Button>
			</div>
		</div>
	);
}
