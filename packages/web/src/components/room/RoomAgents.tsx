/**
 * RoomAgents — Team Builder
 *
 * Apple-inspired agent roster for configuring room agents.
 * Each agent is a card with role color, model selector, and sub-agent management.
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
import { Spinner } from '../ui/Spinner';
import { toast } from '../../lib/toast';
import { cn } from '../../lib/utils';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ModelInfo {
	id: string;
	name: string;
	family: string;
	provider: string;
}

interface CliAgentInfo {
	id: string;
	name: string;
	command: string;
	provider: string;
	installed: boolean;
	authenticated: boolean;
	version?: string;
	models?: string[];
}

interface SubagentConfig {
	model: string;
	provider?: string;
	type?: 'cli';
	cliModel?: string;
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

// ─── Constants ───────────────────────────────────────────────────────────────

const MODEL_FAMILY_ICONS: Record<string, string> = {
	opus: '🧠',
	sonnet: '💎',
	haiku: '⚡',
	glm: '🌐',
	minimax: '🔥',
	__default__: '💎',
};

const ANTHROPIC_COMPAT_SUBAGENT_PROVIDERS = new Set(['anthropic', 'glm', 'minimax']);

function detectFamily(id: string, provider?: string): string {
	if (id.includes('opus')) return 'opus';
	if (id.includes('haiku')) return 'haiku';
	if (provider === 'glm' || id.toLowerCase().startsWith('glm-')) return 'glm';
	if (provider === 'minimax' || id.toLowerCase().startsWith('minimax-')) return 'minimax';
	return 'sonnet';
}

function getModelIcon(id: string, family?: string): string {
	return MODEL_FAMILY_ICONS[family ?? detectFamily(id)] ?? MODEL_FAMILY_ICONS.__default__;
}

interface AgentRole {
	key: string;
	label: string;
	description: string;
	icon: string;
	color: {
		accent: string; // text color for accents
		bg: string; // background tint
		border: string; // left border stripe
		badge: string; // model badge bg
	};
}

const BUILTIN_AGENTS: AgentRole[] = [
	{
		key: 'planner',
		label: 'Planner',
		description: 'Breaks missions into tasks',
		icon: '🎯',
		color: {
			accent: 'text-indigo-400',
			bg: 'bg-indigo-950/20',
			border: 'border-l-indigo-500',
			badge: 'bg-indigo-900/30 text-indigo-300',
		},
	},
	{
		key: 'coder',
		label: 'Coder',
		description: 'Implements code changes',
		icon: '💻',
		color: {
			accent: 'text-emerald-400',
			bg: 'bg-emerald-950/20',
			border: 'border-l-emerald-500',
			badge: 'bg-emerald-900/30 text-emerald-300',
		},
	},
	{
		key: 'general',
		label: 'General',
		description: 'Non-coding tasks',
		icon: '🔧',
		color: {
			accent: 'text-sky-400',
			bg: 'bg-sky-950/20',
			border: 'border-l-sky-500',
			badge: 'bg-sky-900/30 text-sky-300',
		},
	},
	{
		key: 'leader',
		label: 'Leader',
		description: 'Reviews and routes',
		icon: '👑',
		color: {
			accent: 'text-amber-400',
			bg: 'bg-amber-950/20',
			border: 'border-l-amber-500',
			badge: 'bg-amber-900/30 text-amber-300',
		},
	},
];

export interface RoomAgentsProps {
	room: Room;
}

// ─── Dropdown (shared) ───────────────────────────────────────────────────────

function useClickOutside(ref: { current: HTMLElement | null }, onClose: () => void, active: boolean) {
	useEffect(() => {
		if (!active) return;
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) onClose();
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, [active]);
}

// ─── Model Selector (full-width, large) ──────────────────────────────────────

function AgentModelSelector({
	value,
	models,
	loading,
	disabled,
	onChange,
	placeholder = 'Default',
	roleColor,
}: {
	value: string;
	models: ModelInfo[];
	loading: boolean;
	disabled: boolean;
	onChange: (modelId: string) => void;
	placeholder?: string;
	roleColor?: string;
}) {
	const isOpen = useSignal(false);
	const ref = useRef<HTMLDivElement>(null);
	useClickOutside(ref, () => (isOpen.value = false), isOpen.value);

	const selectedModel = models.find((m) => m.id === value);
	const icon = selectedModel ? getModelIcon(selectedModel.id, selectedModel.family) : null;

	return (
		<div class="relative" ref={ref}>
			<button
				type="button"
				onClick={() => !disabled && !loading && (isOpen.value = !isOpen.value)}
				disabled={disabled || loading}
				class={cn(
					'w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-all text-left',
					'bg-dark-800/60 hover:bg-dark-800 border-dark-600 hover:border-dark-500',
					isOpen.value && 'border-blue-600/60 ring-1 ring-blue-600/20'
				)}
			>
				{loading ? (
					<Spinner size="sm" />
				) : (
					<>
						<span class="text-lg">{icon ?? '🤖'}</span>
						<div class="flex-1 min-w-0">
							<span class="text-sm font-medium text-gray-100 block truncate">
								{selectedModel?.name ?? placeholder}
							</span>
							{!value && (
								<span class="text-xs text-gray-500">Uses team default</span>
							)}
						</div>
						<svg
							class={cn(
								'w-4 h-4 text-gray-500 transition-transform flex-shrink-0',
								isOpen.value && 'rotate-180'
							)}
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M19 9l-7 7-7-7" />
						</svg>
					</>
				)}
			</button>

			{isOpen.value && (
				<div class="absolute top-full mt-1.5 left-0 right-0 bg-dark-800 border border-dark-600 rounded-xl shadow-2xl py-1 z-50 max-h-64 overflow-y-auto">
					<button
						class={cn(
							'w-full text-left px-4 py-2.5 hover:bg-dark-700 text-sm flex items-center gap-3 transition-colors',
							!value ? 'text-blue-400' : 'text-gray-300'
						)}
						onClick={() => { onChange(''); isOpen.value = false; }}
					>
						<span class="text-lg">🤖</span>
						<span>{placeholder}</span>
						{!value && <span class="ml-auto text-xs text-blue-400/60">current</span>}
					</button>
					{models.map((model) => (
						<button
							key={model.id}
							class={cn(
								'w-full text-left px-4 py-2.5 hover:bg-dark-700 text-sm flex items-center gap-3 transition-colors',
								model.id === value ? (roleColor ?? 'text-blue-400') : 'text-gray-300'
							)}
							onClick={() => { onChange(model.id); isOpen.value = false; }}
						>
							<span class="text-lg">{getModelIcon(model.id, model.family)}</span>
							<span class="truncate">{model.name}</span>
							{model.id === value && <span class="ml-auto text-xs opacity-60">current</span>}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

// ─── Assistant Pill ──────────────────────────────────────────────────────────

function AssistantPill({
	label,
	icon,
	meta,
	onRemove,
	disabled,
	children,
}: {
	label: string;
	icon?: string;
	meta?: string;
	onRemove?: () => void;
	disabled?: boolean;
	children?: preact.ComponentChildren;
}) {
	return (
		<span class="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 bg-dark-700/80 hover:bg-dark-700 border border-dark-600 rounded-lg text-xs text-gray-200 transition-colors group">
			{icon && <span class="text-sm leading-none">{icon}</span>}
			<span class="truncate max-w-[120px]">{label}</span>
			{meta && <span class="text-gray-500 text-[10px]">{meta}</span>}
			{children}
			{onRemove && !disabled && (
				<button
					onClick={(e) => { e.stopPropagation(); onRemove(); }}
					class="ml-0.5 w-4 h-4 flex items-center justify-center rounded-full text-gray-500 hover:text-red-400 hover:bg-red-900/20 transition-colors opacity-0 group-hover:opacity-100"
				>
					<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			)}
		</span>
	);
}

// ─── Add Pill Button ─────────────────────────────────────────────────────────

function AddPillButton({
	items,
	onSelect,
	renderItem,
	disabled,
	emptyLabel = 'None available',
}: {
	items: Array<{ id: string }>;
	onSelect: (id: string) => void;
	renderItem: (item: { id: string }) => preact.ComponentChildren;
	disabled?: boolean;
	emptyLabel?: string;
}) {
	const isOpen = useSignal(false);
	const ref = useRef<HTMLDivElement>(null);
	useClickOutside(ref, () => (isOpen.value = false), isOpen.value);

	if (items.length === 0 && !isOpen.value) {
		return <span class="text-xs text-gray-600 italic">{emptyLabel}</span>;
	}

	return (
		<div class="relative inline-block" ref={ref}>
			<button
				type="button"
				disabled={disabled || items.length === 0}
				onClick={() => (isOpen.value = !isOpen.value)}
				class="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-dark-700/60 hover:bg-dark-700 border border-dark-600 text-gray-400 hover:text-gray-200 transition-all disabled:opacity-30"
			>
				<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M12 4v16m8-8H4" />
				</svg>
			</button>

			{isOpen.value && items.length > 0 && (
				<div class="absolute top-full mt-1.5 left-0 bg-dark-800 border border-dark-600 rounded-xl shadow-2xl w-56 py-1 z-50 max-h-48 overflow-y-auto">
					{items.map((item) => (
						<button
							key={item.id}
							class="w-full text-left px-3.5 py-2 hover:bg-dark-700 text-sm text-gray-300 transition-colors"
							onClick={() => {
								onSelect(item.id);
								if (items.length <= 1) isOpen.value = false;
							}}
						>
							{renderItem(item)}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

// ─── Stepper ─────────────────────────────────────────────────────────────────

function Stepper({
	value,
	min,
	max,
	onChange,
	disabled,
}: {
	value: number;
	min: number;
	max: number;
	onChange: (v: number) => void;
	disabled?: boolean;
}) {
	return (
		<div class="inline-flex items-center rounded-xl border border-dark-600 bg-dark-800/60 overflow-hidden">
			<button
				type="button"
				disabled={disabled || value <= min}
				onClick={() => onChange(Math.max(min, value - 1))}
				class="px-3 py-2 text-gray-400 hover:text-gray-200 hover:bg-dark-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
			>
				<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width={2.5} d="M20 12H4" />
				</svg>
			</button>
			<span class="px-4 py-2 text-sm font-semibold text-gray-100 tabular-nums min-w-[3rem] text-center border-x border-dark-600">
				{value}
			</span>
			<button
				type="button"
				disabled={disabled || value >= max}
				onClick={() => onChange(Math.min(max, value + 1))}
				class="px-3 py-2 text-gray-400 hover:text-gray-200 hover:bg-dark-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
			>
				<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width={2.5} d="M12 4v16m8-8H4" />
				</svg>
			</button>
		</div>
	);
}

// ─── Agent Card ──────────────────────────────────────────────────────────────

function AgentCard({
	agent,
	modelValue,
	models,
	modelsLoading,
	subagentCount,
	isExpanded,
	onToggle,
	onModelChange,
	disabled,
	children,
}: {
	agent: AgentRole;
	modelValue: string;
	models: ModelInfo[];
	modelsLoading: boolean;
	subagentCount: number;
	isExpanded: boolean;
	onToggle: () => void;
	onModelChange: (model: string) => void;
	disabled: boolean;
	children: preact.ComponentChildren;
}) {
	const selectedModel = models.find((m) => m.id === modelValue);
	const modelLabel = selectedModel?.name ?? 'Default';

	return (
		<div
			class={cn(
				'rounded-xl border-l-2 border border-dark-700 overflow-hidden transition-all',
				agent.color.border,
				isExpanded ? 'bg-dark-850/80 shadow-lg shadow-black/10' : 'bg-dark-850/40 hover:bg-dark-850/60'
			)}
		>
			{/* Card header */}
			<button
				type="button"
				onClick={onToggle}
				class="w-full flex items-center gap-4 px-5 py-4 text-left transition-colors"
			>
				{/* Avatar */}
				<div
					class={cn(
						'w-10 h-10 rounded-xl flex items-center justify-center text-xl flex-shrink-0',
						agent.color.bg
					)}
				>
					{agent.icon}
				</div>

				{/* Info */}
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2">
						<span class="text-sm font-semibold text-gray-100">{agent.label}</span>
						{subagentCount > 0 && (
							<span class={cn('text-[10px] px-1.5 py-0.5 rounded-full', agent.color.badge)}>
								{subagentCount} assistant{subagentCount !== 1 ? 's' : ''}
							</span>
						)}
					</div>
					<span class="text-xs text-gray-500">{agent.description}</span>
				</div>

				{/* Model badge */}
				<span
					class={cn(
						'flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium flex-shrink-0',
						modelValue ? agent.color.badge : 'bg-dark-700/60 text-gray-400'
					)}
					onClick={(e) => e.stopPropagation()}
				>
					{selectedModel && (
						<span class="text-sm leading-none">
							{getModelIcon(selectedModel.id, selectedModel.family)}
						</span>
					)}
					{modelLabel}
				</span>

				{/* Chevron */}
				<svg
					class={cn(
						'w-4 h-4 text-gray-600 transition-transform flex-shrink-0',
						isExpanded && 'rotate-180'
					)}
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M19 9l-7 7-7-7" />
				</svg>
			</button>

			{/* Expanded detail */}
			{isExpanded && (
				<div class="px-5 pb-5 pt-1 border-t border-dark-700/40 space-y-5">
					{/* Model selector */}
					<div>
						<label class="block text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">
							Model
						</label>
						<AgentModelSelector
							value={modelValue}
							models={models}
							loading={modelsLoading}
							disabled={disabled}
							onChange={onModelChange}
							roleColor={agent.color.accent}
						/>
					</div>

					{/* Sub-agents (injected via children) */}
					{children}
				</div>
			)}
		</div>
	);
}

// ─── CLI Agent Pill with model picker ────────────────────────────────────────

function CliAgentPill({
	config,
	agent,
	disabled,
	onRemove,
	onChangeModel,
}: {
	config: SubagentConfig;
	agent: CliAgentInfo | undefined;
	disabled: boolean;
	onRemove: () => void;
	onChangeModel: (model: string) => void;
}) {
	const modelOpen = useSignal(false);
	const ref = useRef<HTMLDivElement>(null);
	useClickOutside(ref, () => (modelOpen.value = false), modelOpen.value);

	if (!agent) return null;
	const hasModels = agent.models && agent.models.length > 0;

	return (
		<div class="relative inline-block" ref={ref}>
			<AssistantPill
				label={agent.name}
				meta={hasModels ? undefined : agent.provider}
				onRemove={onRemove}
				disabled={disabled}
			>
				{hasModels && (
					<button
						class="text-[10px] text-blue-400 hover:text-blue-300 px-1 rounded hover:bg-dark-600 transition-colors"
						onClick={(e) => {
							e.stopPropagation();
							modelOpen.value = !modelOpen.value;
						}}
					>
						{config.cliModel ?? 'default'}
					</button>
				)}
			</AssistantPill>

			{modelOpen.value && hasModels && (
				<div class="absolute top-full mt-1 left-0 bg-dark-800 border border-dark-600 rounded-xl shadow-2xl w-44 py-1 z-50">
					<button
						class={cn(
							'w-full text-left px-3 py-1.5 hover:bg-dark-700 text-xs transition-colors',
							!config.cliModel ? 'text-blue-400' : 'text-gray-300'
						)}
						onClick={(e) => {
							e.stopPropagation();
							onChangeModel('');
							modelOpen.value = false;
						}}
					>
						default
					</button>
					{agent.models!.map((m) => (
						<button
							key={m}
							class={cn(
								'w-full text-left px-3 py-1.5 hover:bg-dark-700 text-xs transition-colors',
								config.cliModel === m ? 'text-blue-400' : 'text-gray-300'
							)}
							onClick={(e) => {
								e.stopPropagation();
								onChangeModel(m);
								modelOpen.value = false;
							}}
						>
							{m}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

// ─── Main Component ──────────────────────────────────────────────────────────

// @public - Library export
export function RoomAgents({ room }: RoomAgentsProps) {
	const agentModels = useSignal<AgentModels>({});
	const agentSubagents = useSignal<AgentSubagents>({});
	const maxReviewRounds = useSignal<number>(3);
	const maxConcurrentGroups = useSignal<number>(1);
	const selectedDefaultModel = useSignal(room.defaultModel || '');
	const expandedAgent = useSignal<string | null>(null);
	const isSaving = useSignal(false);
	const availableModels = useSignal<ModelInfo[]>([]);
	const cliAgents = useSignal<CliAgentInfo[]>([]);
	const isLoadingModels = useSignal(false);

	// ── Data fetching ──

	useEffect(() => {
		const fetchData = async () => {
			isLoadingModels.value = true;
			try {
				const hub = await connectionManager.getHub();
				const [modelsRes, cliRes] = await Promise.all([
					hub.request<{
						models: Array<{
							id: string;
							display_name?: string;
							name?: string;
							provider?: string;
						}>;
					}>('models.list'),
					hub
						.request<{ agents: CliAgentInfo[] }>('agents.cli.list')
						.catch(() => ({ agents: [] }) as { agents: CliAgentInfo[] }),
				]);
				availableModels.value = (modelsRes.models ?? []).map((m) => ({
					id: m.id,
					name: m.display_name ?? m.name ?? m.id,
					provider: m.provider ?? 'unknown',
					family: detectFamily(m.id, m.provider),
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

	// ── Load from room config (with backward-compat migration) ──

	useEffect(() => {
		const config = room.config ?? {};
		agentModels.value = (config.agentModels as AgentModels) ?? {};
		selectedDefaultModel.value = room.defaultModel || '';

		const savedSubagents = config.agentSubagents as AgentSubagents | undefined;
		if (savedSubagents) {
			agentSubagents.value = { ...savedSubagents };
		} else {
			const legacyReviewers = config.reviewers as SubagentConfig[] | undefined;
			agentSubagents.value = legacyReviewers?.length ? { leader: [...legacyReviewers] } : {};
		}

		maxReviewRounds.value = (config.maxReviewRounds as number) ?? 3;
		maxConcurrentGroups.value = (config.maxConcurrentGroups as number) ?? 1;
	}, [room]);

	// ── Change detection ──

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

	const currentJson = useComputed(() =>
		JSON.stringify({
			defaultModel: selectedDefaultModel.value,
			agentModels: agentModels.value,
			agentSubagents: agentSubagents.value,
			maxReviewRounds: maxReviewRounds.value,
			maxConcurrentGroups: maxConcurrentGroups.value,
		})
	);

	const hasChanges = useComputed(() => originalJson.value !== currentJson.value);

	const sdkSubagentModels = useComputed(() =>
		availableModels.value.filter((m) => ANTHROPIC_COMPAT_SUBAGENT_PROVIDERS.has(m.provider))
	);

	// ── Agent model helpers ──

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

	// ── Sub-agent helpers ──

	const getSubagentsForRole = (role: string): SubagentConfig[] =>
		agentSubagents.value[role as keyof AgentSubagents] ?? [];

	const toggleCliAgentFor = (role: string, agent: CliAgentInfo) => {
		const current = getSubagentsForRole(role);
		const exists = current.some((r) => r.type === 'cli' && r.model === agent.id);
		const updated = exists
			? current.filter((r) => !(r.type === 'cli' && r.model === agent.id))
			: [...current, { model: agent.id, type: 'cli' as const }];
		agentSubagents.value = { ...agentSubagents.value, [role]: updated };
	};

	const changeCliModelFor = (role: string, agentId: string, cliModel: string) => {
		const current = getSubagentsForRole(role);
		agentSubagents.value = {
			...agentSubagents.value,
			[role]: current.map((r) => {
				if (r.type === 'cli' && r.model === agentId) {
					const next = { ...r };
					if (cliModel) { next.cliModel = cliModel; } else { delete next.cliModel; }
					return next;
				}
				return r;
			}),
		};
	};

	const getSdkSubagentsFor = (role: string): SubagentConfig[] =>
		getSubagentsForRole(role).filter((r) => r.type !== 'cli');

	const addSdkSubagentFor = (role: string, model: string) => {
		if (!model) return;
		const current = getSubagentsForRole(role);
		if (current.some((r) => r.type !== 'cli' && r.model === model)) return;
		const modelInfo = availableModels.value.find((m) => m.id === model);
		agentSubagents.value = {
			...agentSubagents.value,
			[role]: [...current, { model, provider: modelInfo?.provider }],
		};
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

	// ── Save ──

	const handleSave = async () => {
		if (!hasChanges.value) return;

		const cleanedSubagents: AgentSubagents = {};
		for (const [key, subs] of Object.entries(agentSubagents.value)) {
			const valid = (subs as SubagentConfig[]).filter((s) => s.model.trim());
			if (valid.length > 0) {
				cleanedSubagents[key as keyof AgentSubagents] = valid;
			}
		}

		isSaving.value = true;
		try {
			if (selectedDefaultModel.value !== (room.defaultModel || '')) {
				await roomStore.updateSettings({
					defaultModel: selectedDefaultModel.value || undefined,
				});
			}
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

	// ── Render ──

	return (
		<div class="flex flex-col h-full">
			{/* Sticky save bar — appears when changes exist */}
			{hasChanges.value && (
				<div class="flex items-center justify-between px-5 py-2.5 bg-blue-950/40 border-b border-blue-800/30 flex-shrink-0">
					<span class="text-xs text-blue-300">Unsaved changes</span>
					<button
						type="button"
						onClick={handleSave}
						disabled={disabled}
						class="px-4 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5"
					>
						{isSaving.value && <Spinner size="sm" />}
						{isSaving.value ? 'Saving...' : 'Save'}
					</button>
				</div>
			)}

			{/* Scrollable content */}
			<div class="flex-1 overflow-y-auto">
				<div class="max-w-3xl mx-auto px-5 py-6 space-y-6">
					{/* ── Agent Cards ── */}
					<section>
						<div class="flex items-center justify-between mb-4">
							<h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider">
								Your Team
							</h3>
							<span class="text-xs text-gray-600">
								{BUILTIN_AGENTS.length} agent{BUILTIN_AGENTS.length !== 1 ? 's' : ''}
							</span>
						</div>

						<div class="space-y-3">
							{BUILTIN_AGENTS.map((agent) => {
								const isExpanded = expandedAgent.value === agent.key;
								const allSubs = getSubagentsForRole(agent.key);
								const cliSubs = allSubs.filter((s) => s.type === 'cli');
								const sdkSubs = getSdkSubagentsFor(agent.key);
								const installedCli = cliAgents.value.filter((a) => a.installed);
								const availableCli = installedCli.filter(
									(a) => !cliSubs.some((s) => s.model === a.id)
								);
								const availableSdk = sdkSubagentModels.value.filter(
									(m) => !sdkSubs.some((s) => s.model === m.id)
								);

								return (
									<AgentCard
										key={agent.key}
										agent={agent}
										modelValue={agentModels.value[agent.key as keyof AgentModels] ?? ''}
										models={availableModels.value}
										modelsLoading={isLoadingModels.value}
										subagentCount={allSubs.length}
										isExpanded={isExpanded}
										onToggle={() => {
											expandedAgent.value = isExpanded ? null : agent.key;
										}}
										onModelChange={(model) => updateAgentModel(agent.key, model)}
										disabled={disabled}
									>
										{/* Assistants section */}
										<div>
											<label class="block text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">
												Assistants
											</label>

											{/* SDK Model pills */}
											<div class="mb-3">
												<div class="text-[11px] text-gray-500 mb-1.5">SDK Models</div>
												<div class="flex flex-wrap items-center gap-1.5">
													{sdkSubs.map((sub) => {
														const info = availableModels.value.find((m) => m.id === sub.model);
														return (
															<AssistantPill
																key={sub.model}
																label={info?.name ?? sub.model}
																icon={getModelIcon(sub.model, info?.family)}
																onRemove={() => removeSdkSubagentFor(agent.key, sub.model)}
																disabled={disabled}
															/>
														);
													})}
													<AddPillButton
														items={availableSdk}
														onSelect={(id) => addSdkSubagentFor(agent.key, id)}
														disabled={disabled}
														emptyLabel={sdkSubs.length === 0 ? 'No models added' : ''}
														renderItem={(item) => {
															const m = availableSdk.find((x) => x.id === item.id);
															return (
																<span class="flex items-center gap-2">
																	<span class="text-lg">{getModelIcon(item.id, m?.family)}</span>
																	{m?.name ?? item.id}
																</span>
															);
														}}
													/>
												</div>
											</div>

											{/* CLI Agent pills */}
											<div>
												<div class="text-[11px] text-gray-500 mb-1.5">CLI Agents</div>
												<div class="flex flex-wrap items-center gap-1.5">
													{cliSubs.map((config) => {
														const info = cliAgents.value.find((a) => a.id === config.model);
														return (
															<CliAgentPill
																key={config.model}
																config={config}
																agent={info}
																disabled={disabled}
																onRemove={() => {
																	if (info) toggleCliAgentFor(agent.key, info);
																}}
																onChangeModel={(m) =>
																	changeCliModelFor(agent.key, config.model, m)
																}
															/>
														);
													})}
													<AddPillButton
														items={availableCli}
														onSelect={(id) => {
															const a = cliAgents.value.find((x) => x.id === id);
															if (a) toggleCliAgentFor(agent.key, a);
														}}
														disabled={disabled}
														emptyLabel={cliSubs.length === 0 ? 'No CLI agents' : ''}
														renderItem={(item) => {
															const a = cliAgents.value.find((x) => x.id === item.id);
															return (
																<span class="flex items-center justify-between w-full">
																	<span>
																		{a?.name ?? item.id}
																		<span class="text-xs text-gray-500 ml-1.5">
																			{a?.provider}
																		</span>
																	</span>
																	{a?.authenticated ? (
																		<span class="flex items-center gap-1 text-[10px] text-green-400">
																			<span class="w-1 h-1 rounded-full bg-green-400" />
																			Ready
																		</span>
																	) : (
																		<span class="flex items-center gap-1 text-[10px] text-yellow-400">
																			<span class="w-1 h-1 rounded-full bg-yellow-400" />
																			No auth
																		</span>
																	)}
																</span>
															);
														}}
													/>
												</div>
											</div>
										</div>
									</AgentCard>
								);
							})}
						</div>
					</section>

					{/* ── Team Settings ── */}
					<section class="rounded-xl border border-dark-700 bg-dark-850/40 px-5 py-5 space-y-5">
						<h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider">
							Team Settings
						</h3>

						{/* Default Model */}
						<div>
							<label class="block text-sm font-medium text-gray-300 mb-1">Default Model</label>
							<p class="text-xs text-gray-500 mb-2">
								Fallback model for agents without an explicit override.
							</p>
							<AgentModelSelector
								value={selectedDefaultModel.value}
								models={availableModels.value}
								loading={isLoadingModels.value}
								disabled={disabled}
								onChange={(model) => (selectedDefaultModel.value = model)}
								placeholder="System default"
							/>
						</div>

						{/* Concurrent Tasks */}
						<div class="flex items-center justify-between">
							<div>
								<label class="block text-sm font-medium text-gray-300">Concurrent Tasks</label>
								<p class="text-xs text-gray-500 mt-0.5">Max tasks running in parallel</p>
							</div>
							<Stepper
								value={maxConcurrentGroups.value}
								min={1}
								max={MAX_CONCURRENT_GROUPS_LIMIT}
								onChange={(v) => (maxConcurrentGroups.value = v)}
								disabled={disabled}
							/>
						</div>

						{/* Review Rounds */}
						<div class="flex items-center justify-between">
							<div>
								<label class="block text-sm font-medium text-gray-300">Review Rounds</label>
								<p class="text-xs text-gray-500 mt-0.5">
									Auto-review iterations before human escalation
								</p>
							</div>
							<Stepper
								value={maxReviewRounds.value}
								min={1}
								max={MAX_REVIEW_ROUNDS_LIMIT}
								onChange={(v) => (maxReviewRounds.value = v)}
								disabled={disabled}
							/>
						</div>
					</section>
				</div>
			</div>
		</div>
	);
}
