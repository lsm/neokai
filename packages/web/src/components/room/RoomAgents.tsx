/**
 * RoomAgents - Configure built-in agents and reviewer sub-agents for the room
 *
 * Shows the 4 built-in agent roles with per-agent model selection,
 * detected CLI agents with install/auth status, and reviewer configuration.
 *
 * Config shape in room.config:
 *   agentModels: { planner?: string, coder?: string, general?: string, leader?: string }
 *   reviewers: ReviewerConfig[]
 *   maxReviewRounds: number
 */

import { useSignal, useComputed } from '@preact/signals';
import { useCallback, useEffect, useRef } from 'preact/hooks';
import type { Room } from '@neokai/shared';
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

interface ReviewerConfig {
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
}: {
	value: string;
	models: ModelInfo[];
	loading: boolean;
	disabled: boolean;
	onChange: (modelId: string) => void;
	placeholder?: string;
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
						<span class="truncate max-w-[140px]">
							{selectedModel?.name ?? placeholder}
						</span>
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
				<div class="absolute top-full mt-1 left-0 bg-dark-800 border border-dark-600 rounded-lg shadow-xl w-48 py-1 z-50 animate-slideIn">
					<button
						class={`w-full text-left px-3 py-2 hover:bg-dark-700 text-xs flex items-center gap-2 ${
							!value ? 'text-blue-400' : 'text-gray-200'
						}`}
						onClick={() => handleSelect('')}
					>
						Default
						{!value && ' (current)'}
					</button>
					{models.map((model) => (
						<button
							key={model.id}
							class={`w-full text-left px-3 py-2 hover:bg-dark-700 text-xs flex items-center gap-2 ${
								model.id === value ? 'text-blue-400' : 'text-gray-200'
							}`}
							onClick={() => handleSelect(model.id)}
						>
							<span class="text-sm">
								{MODEL_FAMILY_ICONS[model.family] ||
									MODEL_FAMILY_ICONS.__default__}
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

export function RoomAgents({ room }: RoomAgentsProps) {
	const agentModels = useSignal<AgentModels>({});
	const reviewers = useSignal<ReviewerConfig[]>([]);
	const maxReviewRounds = useSignal<number>(3);
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
					hub.request<{ agents: CliAgentInfo[] }>('agents.cli.list').catch(
						() => ({ agents: [] }) as { agents: CliAgentInfo[] }
					),
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

	// Load from room config
	useEffect(() => {
		const config = room.config ?? {};
		agentModels.value = (config.agentModels as AgentModels) ?? {};
		const saved = config.reviewers as ReviewerConfig[] | undefined;
		reviewers.value = saved ? [...saved] : [];
		maxReviewRounds.value = (config.maxReviewRounds as number) ?? 3;
	}, [room]);

	const originalJson = useComputed(() => {
		const config = room.config ?? {};
		return JSON.stringify({
			agentModels: config.agentModels ?? {},
			reviewers: config.reviewers ?? [],
			maxReviewRounds: config.maxReviewRounds ?? 3,
		});
	});

	const currentJson = useComputed(() => {
		return JSON.stringify({
			agentModels: agentModels.value,
			reviewers: reviewers.value,
			maxReviewRounds: maxReviewRounds.value,
		});
	});

	const hasChanges = useComputed(() => originalJson.value !== currentJson.value);

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

	// Check if a CLI agent is already in reviewers list
	const isCliAgentEnabled = (agentId: string) => {
		return reviewers.value.some((r) => r.type === 'cli' && r.model === agentId);
	};

	const toggleCliAgent = (agent: CliAgentInfo) => {
		if (isCliAgentEnabled(agent.id)) {
			// Remove
			reviewers.value = reviewers.value.filter(
				(r) => !(r.type === 'cli' && r.model === agent.id)
			);
		} else {
			// Add as CLI reviewer
			reviewers.value = [
				...reviewers.value,
				{ model: agent.id, type: 'cli', driver_model: 'sonnet' },
			];
		}
	};

	// SDK model reviewers (non-CLI)
	const sdkReviewers = reviewers.value.filter((r) => r.type !== 'cli');

	const addSdkReviewer = () => {
		reviewers.value = [...reviewers.value, { model: '' }];
	};

	const removeSdkReviewer = (model: string) => {
		// Remove first non-CLI reviewer matching this model
		let removed = false;
		reviewers.value = reviewers.value.filter((r) => {
			if (!removed && r.type !== 'cli' && r.model === model) {
				removed = true;
				return false;
			}
			return true;
		});
	};

	const updateSdkReviewer = (oldModel: string, newModel: string) => {
		let updated = false;
		reviewers.value = reviewers.value.map((r) => {
			if (!updated && r.type !== 'cli' && r.model === oldModel) {
				updated = true;
				return { ...r, model: newModel };
			}
			return r;
		});
	};

	const handleSave = async () => {
		if (!hasChanges.value) return;

		const validReviewers = reviewers.value.filter((r) => r.model.trim());

		isSaving.value = true;
		try {
			await roomStore.updateConfig({
				...room.config,
				agentModels: agentModels.value,
				reviewers: validReviewers,
				maxReviewRounds: maxReviewRounds.value,
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
					Configure models for built-in agents and enable reviewers.
				</p>
			</div>

			<div class="flex-1 overflow-y-auto py-4 space-y-6">
				{/* Built-in agent rows */}
				<div class="space-y-2">
					{BUILTIN_AGENTS.map((agent) => (
						<div
							key={agent.key}
							class="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-dark-800 border border-dark-700"
						>
							<div class="min-w-0">
								<span class="text-sm font-medium text-gray-100">
									{agent.label}
								</span>
								<span class="text-xs text-gray-500 ml-2">
									{agent.description}
								</span>
							</div>
							<ModelPicker
								value={
									agentModels.value[agent.key as keyof AgentModels] ?? ''
								}
								models={availableModels.value}
								loading={isLoadingModels.value}
								disabled={disabled}
								onChange={(model) => updateAgentModel(agent.key, model)}
							/>
						</div>
					))}
				</div>

				{/* Divider */}
				<div class="border-t border-dark-700" />

				{/* Reviewers section */}
				<div>
					<h3 class="text-sm font-semibold text-gray-300 mb-1">Reviewers</h3>
					<p class="text-xs text-gray-500 mb-3">
						Models and CLI agents that review code during the review phase.
					</p>

					{/* CLI Agents */}
					{cliAgents.value.length > 0 && (
						<div class="mb-4">
							<div class="text-xs font-medium text-gray-400 mb-2">CLI Agents</div>
							<div class="space-y-1.5">
								{cliAgents.value.map((agent) => (
									<div
										key={agent.id}
										class="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-dark-800 border border-dark-700"
									>
										<div class="flex items-center gap-2.5 min-w-0">
											<button
												type="button"
												class={`w-4 h-4 rounded flex-shrink-0 border transition-colors ${
													isCliAgentEnabled(agent.id)
														? 'bg-blue-500 border-blue-500'
														: 'border-dark-500 hover:border-dark-400'
												}`}
												onClick={() =>
													agent.installed && toggleCliAgent(agent)
												}
												disabled={disabled || !agent.installed}
											>
												{isCliAgentEnabled(agent.id) && (
													<svg
														class="w-4 h-4 text-white"
														fill="none"
														viewBox="0 0 24 24"
														stroke="currentColor"
													>
														<path
															stroke-linecap="round"
															stroke-linejoin="round"
															stroke-width={3}
															d="M5 13l4 4L19 7"
														/>
													</svg>
												)}
											</button>
											<div class="min-w-0">
												<span
													class={`text-sm font-medium ${agent.installed ? 'text-gray-100' : 'text-gray-500'}`}
												>
													{agent.name}
												</span>
												<span class="text-xs text-gray-500 ml-1.5">
													{agent.provider}
												</span>
											</div>
										</div>
										<div class="flex items-center gap-2 flex-shrink-0">
											{agent.installed ? (
												agent.authenticated ? (
													<span class="text-xs text-green-400 flex items-center gap-1">
														<span class="w-1.5 h-1.5 rounded-full bg-green-400" />
														Ready
													</span>
												) : (
													<span class="text-xs text-yellow-400 flex items-center gap-1">
														<span class="w-1.5 h-1.5 rounded-full bg-yellow-400" />
														No auth
													</span>
												)
											) : (
												<span class="text-xs text-gray-500">
													Not installed
												</span>
											)}
										</div>
									</div>
								))}
							</div>
						</div>
					)}

					{/* SDK Model Reviewers */}
					<div>
						<div class="text-xs font-medium text-gray-400 mb-2">Model Reviewers</div>
						<div class="space-y-1.5">
							{sdkReviewers.map((reviewer, idx) => (
								<div
									key={idx}
									class="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-dark-800 border border-dark-700"
								>
									<ModelPicker
										value={reviewer.model}
										models={availableModels.value}
										loading={isLoadingModels.value}
										disabled={disabled}
										onChange={(model) =>
											updateSdkReviewer(reviewer.model, model)
										}
										placeholder="Select model..."
									/>
									<button
										class="text-xs text-red-400 hover:text-red-300 flex-shrink-0"
										onClick={() => removeSdkReviewer(reviewer.model)}
										disabled={disabled}
									>
										Remove
									</button>
								</div>
							))}

							<button
								class="w-full border border-dashed border-dark-600 rounded-lg py-2 text-xs text-gray-400 hover:text-gray-200 hover:border-dark-500 transition-colors"
								onClick={addSdkReviewer}
								disabled={disabled}
							>
								+ Add Model Reviewer
							</button>
						</div>
					</div>
				</div>

				{/* Max review rounds */}
				<div>
					<label class="block text-sm font-medium text-gray-300 mb-1">
						Max Review Rounds
					</label>
					<p class="text-xs text-gray-500 mb-2">
						Maximum number of review iterations before failing the task.
					</p>
					<input
						type="number"
						min={1}
						max={20}
						value={maxReviewRounds.value}
						onInput={(e) => {
							const val = parseInt((e.target as HTMLInputElement).value, 10);
							if (!isNaN(val) && val >= 1) {
								maxReviewRounds.value = val;
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
