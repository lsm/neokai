/**
 * RoomAgents - Configure built-in agents and per-agent sub-agents for the room
 *
 * Shows a default model selector, 4 built-in agent roles with per-agent model
 * selection, expandable sub-agent pools per agent, and max review rounds.
 *
 * Config shape in room.config:
 *   agentModels: { planner?: string, coder?: string, general?: string, leader?: string }
 *   agentSubagents: { planner?: SubagentConfig[], coder?: SubagentConfig[], ... }
 *   maxReviewRounds: number
 *   maxConcurrentGroups: number
 */

import { useSignal, useComputed } from '@preact/signals';
import { useCallback, useEffect, useRef } from 'preact/hooks';
import { type Room, MAX_CONCURRENT_GROUPS_LIMIT, MAX_REVIEW_ROUNDS_LIMIT } from '@neokai/shared';
import { connectionManager } from '../../lib/connection-manager';
import { roomStore } from '../../lib/room-store';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { toast } from '../../lib/toast';

interface ModelInfo {
	id: string;
	name: string;
	family: string;
}

interface CliAgentInfo {
	id: string;
	name: string;
	command: string;
	provider: string;
	installed: boolean;
	authenticated: boolean;
	version?: string;
}

const MODEL_FAMILY_ICONS: Record<string, string> = {
	opus: '🧠',
	sonnet: '💎',
	haiku: '⚡',
	glm: '🌐',
	__default__: '💎',
};

function detectFamily(id: string): string {
	if (id.includes('opus')) return 'opus';
	if (id.includes('haiku')) return 'haiku';
	if (id.toLowerCase().startsWith('glm-')) return 'glm';
	return 'sonnet';
}

interface AgentRole {
	key: string;
	label: string;
	description: string;
}

const BUILTIN_AGENTS: AgentRole[] = [
	{ key: 'planner', label: 'Planner', description: 'Breaks goals into tasks' },
	{ key: 'coder', label: 'Coder', description: 'Implements code changes' },
	{ key: 'general', label: 'General', description: 'Non-coding tasks' },
	{ key: 'leader', label: 'Leader', description: 'Reviews and routes' },
];

interface SubagentConfig {
	model: string;
	provider?: string;
	type?: 'cli';
	driver_model?: string;
}

interface AgentModels {
	planner?: string;
	coder?: string;
	general?: string;
	leader?: string;
}

interface AgentSubagents {
	planner?: SubagentConfig[];
	coder?: SubagentConfig[];
	general?: SubagentConfig[];
	leader?: SubagentConfig[];
}

export interface RoomAgentsProps {
	room: Room;
}

/** Compact model picker button + dropdown */
function ModelPicker({
	value,
	models,
	loading,
	disabled,
	onChange,
	placeholder = 'Default',
	excludeModels,
}: {
	value: string;
	models: ModelInfo[];
	loading: boolean;
	disabled: boolean;
	onChange: (modelId: string) => void;
	placeholder?: string;
	excludeModels?: string[];
}) {
	const isOpen = useSignal(false);
	const ref = useRef<HTMLDivElement>(null);

	const selectedModel = models.find((m) => m.id === value);
	const icon = selectedModel
		? MODEL_FAMILY_ICONS[selectedModel.family] || MODEL_FAMILY_ICONS.__default__
		: null;

	const handleToggle = useCallback(() => {
		if (!disabled && !loading) isOpen.value = !isOpen.value;
	}, [disabled, loading]);

	const handleSelect = useCallback(
		(modelId: string) => {
			onChange(modelId);
			isOpen.value = false;
		},
		[onChange]
	);

	useEffect(() => {
		if (!isOpen.value) return;
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) isOpen.value = false;
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, [isOpen.value]);

	return (
		<div class="relative" ref={ref}>
			<button
				type="button"
				class={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-colors ${
					value
						? 'bg-dark-700 text-gray-200 hover:bg-dark-600'
						: 'bg-dark-700/50 text-gray-500 hover:bg-dark-600 hover:text-gray-300'
				} border border-dark-600`}
				onClick={handleToggle}
				disabled={disabled || loading}
			>
				{loading ? (
					<Spinner size="sm" />
				) : (
					<>
						{icon && <span class="text-sm">{icon}</span>}
						<span class="truncate max-w-[140px]">{selectedModel?.name ?? placeholder}</span>
						<svg
							class="w-3 h-3 text-gray-500 flex-shrink-0"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M19 9l-7 7-7-7"
							/>
						</svg>
					</>
				)}
			</button>

			{isOpen.value && (
				<div class="absolute top-full mt-1 right-0 bg-dark-800 border border-dark-600 rounded-lg shadow-xl w-48 py-1 z-50 animate-slideIn">
					<button
						class={`w-full text-left px-3 py-2 hover:bg-dark-700 text-xs flex items-center gap-2 ${
							!value ? 'text-blue-400' : 'text-gray-200'
						}`}
						onClick={() => handleSelect('')}
					>
						{placeholder}
						{!value && ' (current)'}
					</button>
					{models
						.filter((model) => model.id === value || !excludeModels?.includes(model.id))
						.map((model) => (
							<button
								key={model.id}
								class={`w-full text-left px-3 py-2 hover:bg-dark-700 text-xs flex items-center gap-2 ${
									model.id === value ? 'text-blue-400' : 'text-gray-200'
								}`}
								onClick={() => handleSelect(model.id)}
							>
								<span class="text-sm">
									{MODEL_FAMILY_ICONS[model.family] || MODEL_FAMILY_ICONS.__default__}
								</span>
								{model.name}
								{model.id === value && ' (current)'}
							</button>
						))}
				</div>
			)}
		</div>
	);
}

/** Tags-style input for selecting sub-agent models */
function ModelTagsInput({
	models,
	selected,
	loading,
	disabled,
	onAdd,
	onRemove,
}: {
	models: ModelInfo[];
	selected: string[];
	loading: boolean;
	disabled: boolean;
	onAdd: (modelId: string) => void;
	onRemove: (modelId: string) => void;
}) {
	const isOpen = useSignal(false);
	const ref = useRef<HTMLDivElement>(null);

	const availableToAdd = models.filter((m) => !selected.includes(m.id));

	useEffect(() => {
		if (!isOpen.value) return;
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) isOpen.value = false;
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, [isOpen.value]);

	return (
		<div class="relative" ref={ref}>
			<div
				class="flex flex-wrap items-center gap-1.5 min-h-[32px] px-2 py-1.5 bg-dark-800 border border-dark-600 rounded-md cursor-text"
				onClick={() => {
					if (!disabled && !loading && availableToAdd.length > 0) isOpen.value = !isOpen.value;
				}}
			>
				{selected.map((modelId) => {
					const info = models.find((m) => m.id === modelId);
					const icon = info
						? MODEL_FAMILY_ICONS[info.family] || MODEL_FAMILY_ICONS.__default__
						: MODEL_FAMILY_ICONS.__default__;
					return (
						<span
							key={modelId}
							class="inline-flex items-center gap-1 px-2 py-0.5 bg-dark-600 rounded text-xs text-gray-200"
						>
							<span class="text-sm leading-none">{icon}</span>
							{info?.name ?? modelId}
							{!disabled && (
								<button
									class="ml-0.5 text-red-400 hover:text-red-300 leading-none"
									onClick={(e) => {
										e.stopPropagation();
										onRemove(modelId);
									}}
								>
									&times;
								</button>
							)}
						</span>
					);
				})}
				{availableToAdd.length > 0 && (
					<span class="inline-flex items-center justify-center w-6 h-6 rounded bg-dark-600 hover:bg-dark-500 text-gray-400 hover:text-gray-200 text-sm font-medium transition-colors cursor-pointer">
						+
					</span>
				)}
			</div>

			{isOpen.value && (
				<div class="absolute top-full mt-1 left-0 bg-dark-800 border border-dark-600 rounded-lg shadow-xl w-48 py-1 z-50 animate-slideIn">
					{availableToAdd.map((model) => (
						<button
							key={model.id}
							class="w-full text-left px-3 py-2 hover:bg-dark-700 text-xs flex items-center gap-2 text-gray-200"
							onClick={() => {
								onAdd(model.id);
								if (availableToAdd.length <= 1) isOpen.value = false;
							}}
						>
							<span class="text-sm">
								{MODEL_FAMILY_ICONS[model.family] || MODEL_FAMILY_ICONS.__default__}
							</span>
							{model.name}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

/** Tags-style input for selecting CLI sub-agents */
function CliTagsInput({
	agents,
	selectedIds,
	disabled,
	onToggle,
}: {
	agents: CliAgentInfo[];
	selectedIds: string[];
	disabled: boolean;
	onToggle: (agent: CliAgentInfo) => void;
}) {
	const isOpen = useSignal(false);
	const ref = useRef<HTMLDivElement>(null);

	const installableAgents = agents.filter((a) => a.installed);
	const availableToAdd = installableAgents.filter((a) => !selectedIds.includes(a.id));

	useEffect(() => {
		if (!isOpen.value) return;
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) isOpen.value = false;
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, [isOpen.value]);

	return (
		<div class="relative" ref={ref}>
			<div
				class="flex flex-wrap items-center gap-1.5 min-h-[32px] px-2 py-1.5 bg-dark-800 border border-dark-600 rounded-md cursor-text"
				onClick={() => {
					if (!disabled && availableToAdd.length > 0) isOpen.value = !isOpen.value;
				}}
			>
				{selectedIds.map((id) => {
					const info = agents.find((a) => a.id === id);
					if (!info) return null;
					return (
						<span
							key={id}
							class="inline-flex items-center gap-1 px-2 py-0.5 bg-dark-600 rounded text-xs text-gray-200"
						>
							{info.name}
							<span class="text-[10px] text-gray-500">{info.provider}</span>
							{!disabled && (
								<button
									class="ml-0.5 text-red-400 hover:text-red-300 leading-none"
									onClick={(e) => {
										e.stopPropagation();
										onToggle(info);
									}}
								>
									&times;
								</button>
							)}
						</span>
					);
				})}
				{availableToAdd.length > 0 && (
					<span class="inline-flex items-center justify-center w-6 h-6 rounded bg-dark-600 hover:bg-dark-500 text-gray-400 hover:text-gray-200 text-sm font-medium transition-colors cursor-pointer">
						+
					</span>
				)}
				{selectedIds.length === 0 && availableToAdd.length === 0 && (
					<span class="text-xs text-gray-600">No CLI agents installed</span>
				)}
			</div>

			{isOpen.value && (
				<div class="absolute top-full mt-1 left-0 bg-dark-800 border border-dark-600 rounded-lg shadow-xl w-56 py-1 z-50 animate-slideIn">
					{availableToAdd.map((agent) => (
						<button
							key={agent.id}
							class="w-full text-left px-3 py-2 hover:bg-dark-700 text-xs flex items-center justify-between gap-2 text-gray-200"
							onClick={() => {
								onToggle(agent);
								if (availableToAdd.length <= 1) isOpen.value = false;
							}}
						>
							<span class="flex items-center gap-2">
								{agent.name}
								<span class="text-[10px] text-gray-500">{agent.provider}</span>
							</span>
							{agent.authenticated ? (
								<span class="text-[10px] text-green-400 flex items-center gap-1">
									<span class="w-1 h-1 rounded-full bg-green-400" />
									Ready
								</span>
							) : (
								<span class="text-[10px] text-yellow-400 flex items-center gap-1">
									<span class="w-1 h-1 rounded-full bg-yellow-400" />
									No auth
								</span>
							)}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

export function RoomAgents({ room }: RoomAgentsProps) {
	const agentModels = useSignal<AgentModels>({});
	const agentSubagents = useSignal<AgentSubagents>({});
	const maxReviewRounds = useSignal<number>(3);
	const maxConcurrentGroups = useSignal<number>(1);
	const selectedDefaultModel = useSignal(room.defaultModel || '');
	const expandedAgents = useSignal<Set<string>>(new Set());
	const isSaving = useSignal(false);
	const availableModels = useSignal<ModelInfo[]>([]);
	const cliAgents = useSignal<CliAgentInfo[]>([]);
	const isLoadingModels = useSignal(false);

	// Fetch available models + CLI agents
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

	// Load from room config (with backward-compat migration from flat reviewers)
	useEffect(() => {
		const config = room.config ?? {};
		agentModels.value = (config.agentModels as AgentModels) ?? {};
		selectedDefaultModel.value = room.defaultModel || '';

		const savedSubagents = config.agentSubagents as AgentSubagents | undefined;
		if (savedSubagents) {
			agentSubagents.value = { ...savedSubagents };
		} else {
			// Migrate: old flat reviewers -> leader sub-agents
			const legacyReviewers = config.reviewers as SubagentConfig[] | undefined;
			agentSubagents.value = legacyReviewers?.length ? { leader: [...legacyReviewers] } : {};
		}

		maxReviewRounds.value = (config.maxReviewRounds as number) ?? 3;
		maxConcurrentGroups.value = (config.maxConcurrentGroups as number) ?? 1;
	}, [room]);

	// Change detection
	const originalJson = useComputed(() => {
		const config = room.config ?? {};
		const savedSubagents = config.agentSubagents as AgentSubagents | undefined;
		const origSubagents = savedSubagents
			? savedSubagents
			: (config.reviewers as SubagentConfig[] | undefined)?.length
				? { leader: config.reviewers }
				: {};
		return JSON.stringify({
			defaultModel: room.defaultModel ?? '',
			agentModels: config.agentModels ?? {},
			agentSubagents: origSubagents,
			maxReviewRounds: config.maxReviewRounds ?? 3,
			maxConcurrentGroups: config.maxConcurrentGroups ?? 1,
		});
	});

	const currentJson = useComputed(() => {
		return JSON.stringify({
			defaultModel: selectedDefaultModel.value,
			agentModels: agentModels.value,
			agentSubagents: agentSubagents.value,
			maxReviewRounds: maxReviewRounds.value,
			maxConcurrentGroups: maxConcurrentGroups.value,
		});
	});

	const hasChanges = useComputed(() => originalJson.value !== currentJson.value);

	// Resolve default model name for display
	const defaultModelLabel = useComputed(() => {
		if (!selectedDefaultModel.value) return 'Default';
		const m = availableModels.value.find((m) => m.id === selectedDefaultModel.value);
		return m ? `Default (${m.name})` : `Default (${selectedDefaultModel.value})`;
	});

	const updateAgentModel = useCallback(
		(key: string, model: string) => {
			const updated = { ...agentModels.value };
			if (model) {
				updated[key as keyof AgentModels] = model;
			} else {
				delete updated[key as keyof AgentModels];
			}
			agentModels.value = updated;
		},
		[agentModels]
	);

	// Per-agent sub-agent helpers
	const getSubagentsForRole = (role: string): SubagentConfig[] => {
		return agentSubagents.value[role as keyof AgentSubagents] ?? [];
	};

	const isCliAgentEnabledFor = (role: string, agentId: string): boolean => {
		return getSubagentsForRole(role).some((r) => r.type === 'cli' && r.model === agentId);
	};

	const toggleCliAgentFor = (role: string, agent: CliAgentInfo) => {
		const current = getSubagentsForRole(role);
		const updated = isCliAgentEnabledFor(role, agent.id)
			? current.filter((r) => !(r.type === 'cli' && r.model === agent.id))
			: [...current, { model: agent.id, type: 'cli' as const, driver_model: 'sonnet' }];
		agentSubagents.value = { ...agentSubagents.value, [role]: updated };
	};

	const getSdkSubagentsFor = (role: string): SubagentConfig[] => {
		return getSubagentsForRole(role).filter((r) => r.type !== 'cli');
	};

	const addSdkSubagentFor = (role: string, model: string) => {
		if (!model) return;
		const current = getSubagentsForRole(role);
		// Avoid duplicates
		if (current.some((r) => r.type !== 'cli' && r.model === model)) return;
		agentSubagents.value = { ...agentSubagents.value, [role]: [...current, { model }] };
	};

	const removeSdkSubagentFor = (role: string, model: string) => {
		let removed = false;
		const current = getSubagentsForRole(role);
		agentSubagents.value = {
			...agentSubagents.value,
			[role]: current.filter((r) => {
				if (!removed && r.type !== 'cli' && r.model === model) {
					removed = true;
					return false;
				}
				return true;
			}),
		};
	};

	const toggleExpanded = (key: string) => {
		const next = new Set(expandedAgents.value);
		if (next.has(key)) {
			next.delete(key);
		} else {
			next.add(key);
		}
		expandedAgents.value = next;
	};

	const handleSave = async () => {
		if (!hasChanges.value) return;

		// Clean up: remove entries with blank model and empty role arrays
		const cleanedSubagents: AgentSubagents = {};
		for (const [key, subs] of Object.entries(agentSubagents.value)) {
			const valid = (subs as SubagentConfig[]).filter((s) => s.model.trim());
			if (valid.length > 0) {
				cleanedSubagents[key as keyof AgentSubagents] = valid;
			}
		}

		isSaving.value = true;
		try {
			// Save defaultModel if changed
			if (selectedDefaultModel.value !== (room.defaultModel || '')) {
				await roomStore.updateSettings({
					defaultModel: selectedDefaultModel.value || undefined,
				});
			}
			// Save config (clears legacy reviewers key)
			await roomStore.updateConfig({
				...room.config,
				agentModels: agentModels.value,
				agentSubagents: cleanedSubagents,
				reviewers: undefined,
				maxReviewRounds: maxReviewRounds.value,
				maxConcurrentGroups: maxConcurrentGroups.value,
			});
			toast.success('Agent configuration saved');
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to save');
		} finally {
			isSaving.value = false;
		}
	};

	const disabled = isSaving.value;

	return (
		<div class="flex flex-col h-full">
			{/* Header */}
			<div class="pb-4 border-b border-dark-700">
				<h2 class="text-lg font-semibold text-gray-100">Agents</h2>
				<p class="text-xs text-gray-500 mt-0.5">
					Configure models for built-in agents and their sub-agents.
				</p>
			</div>

			<div class="flex-1 overflow-y-auto py-4 space-y-6">
				{/* Default Model selector */}
				<div>
					<div class="flex items-center justify-between gap-3 mb-1">
						<div>
							<h3 class="text-sm font-semibold text-gray-300">Default Model</h3>
							<p class="text-xs text-gray-500">
								What "Default" resolves to for agent model selectors below.
							</p>
						</div>
						<ModelPicker
							value={selectedDefaultModel.value}
							models={availableModels.value}
							loading={isLoadingModels.value}
							disabled={disabled}
							onChange={(model) => {
								selectedDefaultModel.value = model;
							}}
							placeholder="System default"
						/>
					</div>
				</div>

				{/* Divider */}
				<div class="border-t border-dark-700" />

				{/* Built-in agents with expandable sub-agents */}
				<div class="space-y-2">
					{BUILTIN_AGENTS.map((agent) => {
						const isExpanded = expandedAgents.value.has(agent.key);
						const subagentCount = getSubagentsForRole(agent.key).length;

						return (
							<div key={agent.key} class="rounded-lg bg-dark-800 border border-dark-700">
								{/* Agent header row */}
								<div class="flex items-center justify-between gap-3 px-3 py-2">
									<button
										type="button"
										class="flex items-center gap-2 min-w-0 cursor-pointer group"
										onClick={() => toggleExpanded(agent.key)}
									>
										<svg
											class={`w-3.5 h-3.5 text-gray-500 group-hover:text-gray-300 transition-transform flex-shrink-0 ${isExpanded ? 'rotate-90' : ''}`}
											fill="none"
											viewBox="0 0 24 24"
											stroke="currentColor"
										>
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width={2}
												d="M9 5l7 7-7 7"
											/>
										</svg>
										<span class="text-sm font-medium text-gray-100">{agent.label}</span>
										<span class="text-xs text-gray-500">{agent.description}</span>
										{subagentCount > 0 && (
											<span class="text-[10px] text-blue-400/70 bg-blue-900/20 px-1.5 py-0.5 rounded">
												{subagentCount} sub-agent
												{subagentCount !== 1 ? 's' : ''}
											</span>
										)}
									</button>
									<ModelPicker
										value={agentModels.value[agent.key as keyof AgentModels] ?? ''}
										models={availableModels.value}
										loading={isLoadingModels.value}
										disabled={disabled}
										onChange={(model) => updateAgentModel(agent.key, model)}
										placeholder={defaultModelLabel.value}
									/>
								</div>

								{/* Expandable sub-agents section */}
								{isExpanded && (
									<div class="px-3 pb-3 pt-1 border-t border-dark-700/50 ml-6">
										{/* Sub Agent CLIs */}
										<div class="mb-3">
											<div class="text-xs text-gray-500 mb-2">Sub Agent CLIs</div>
											<CliTagsInput
												agents={cliAgents.value}
												selectedIds={getSubagentsForRole(agent.key)
													.filter((s) => s.type === 'cli')
													.map((s) => s.model)}
												disabled={disabled}
												onToggle={(cliAgent) => toggleCliAgentFor(agent.key, cliAgent)}
											/>
										</div>

										{/* Sub Agent Models */}
										<div class="text-xs text-gray-500 mb-2">Sub Agent Models</div>
										<ModelTagsInput
											models={availableModels.value}
											selected={getSdkSubagentsFor(agent.key)
												.map((s) => s.model)
												.filter(Boolean)}
											loading={isLoadingModels.value}
											disabled={disabled}
											onAdd={(model) => addSdkSubagentFor(agent.key, model)}
											onRemove={(model) => removeSdkSubagentFor(agent.key, model)}
										/>
									</div>
								)}
							</div>
						);
					})}
				</div>

				{/* Max review rounds */}
				<div>
					<label class="block text-sm font-medium text-gray-300 mb-1">Max Review Rounds</label>
					<p class="text-xs text-gray-500 mb-2">
						Maximum number of review iterations before failing the task.
					</p>
					<input
						type="number"
						min={1}
						max={MAX_REVIEW_ROUNDS_LIMIT}
						value={maxReviewRounds.value}
						onInput={(e) => {
							const val = parseInt((e.target as HTMLInputElement).value, 10);
							if (!isNaN(val) && val >= 1 && val <= MAX_REVIEW_ROUNDS_LIMIT) {
								maxReviewRounds.value = val;
							}
						}}
						class="w-24 bg-dark-800 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
						disabled={disabled}
					/>
				</div>

				{/* Max concurrent tasks */}
				<div>
					<label class="block text-sm font-medium text-gray-300 mb-1">Max Concurrent Tasks</label>
					<p class="text-xs text-gray-500 mb-2">
						Maximum number of tasks running in parallel. Increasing this takes effect on the next
						tick without restarting.
					</p>
					<input
						type="number"
						min={1}
						max={MAX_CONCURRENT_GROUPS_LIMIT}
						value={maxConcurrentGroups.value}
						onInput={(e) => {
							const val = parseInt((e.target as HTMLInputElement).value, 10);
							if (!isNaN(val) && val >= 1 && val <= MAX_CONCURRENT_GROUPS_LIMIT) {
								maxConcurrentGroups.value = val;
							}
						}}
						class="w-24 bg-dark-800 border border-dark-600 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
						disabled={disabled}
					/>
				</div>
			</div>

			{/* Footer */}
			<div class="flex items-center justify-end gap-3 pt-4 border-t border-dark-700">
				{isSaving.value && (
					<span class="text-sm text-gray-400 flex items-center gap-2">
						<Spinner size="sm" />
						Saving...
					</span>
				)}
				<Button
					onClick={handleSave}
					disabled={!hasChanges.value || disabled}
					loading={isSaving.value}
				>
					Save Changes
				</Button>
			</div>
		</div>
	);
}
