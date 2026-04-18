import { useState } from 'preact/hooks';
import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';

/**
 * Compact "Session Started" card for Space task threads.
 *
 * Matches the visual language of `SDKResultMessage` and `SDKSystemMessage` —
 * indigo-tinted rounded card with an expandable details section — but uses
 * smaller text (text-[11px]/text-xs) so it fits the compact thread density.
 *
 * The normal chat pipeline dispatches init messages to `SystemInitPill` (an
 * inline pill) in task context, but the Space compact feed wants a visible
 * card per turn so multi-agent session starts remain legible. This component
 * is used only by `SpaceTaskCardFeed` and bypasses `SDKMessageRenderer` for
 * the init row.
 */

type SystemInitShape = {
	type: 'system';
	subtype: 'init';
	model?: string;
	permissionMode?: string;
	cwd?: string;
	tools?: string[];
	mcp_servers?: { name: string; status: string }[];
	slash_commands?: string[];
	agents?: string[];
	apiKeySource?: string;
	output_style?: string;
};

interface Props {
	message: SDKMessage;
}

function shortModel(model?: string): string {
	if (!model) return 'unknown model';
	return model.replace(/^claude-/, '');
}

export function SpaceSystemInitCard({ message }: Props) {
	const [expanded, setExpanded] = useState(false);
	const m = message as unknown as SystemInitShape;

	const toolCount = m.tools?.length ?? 0;
	const mcpCount = m.mcp_servers?.length ?? 0;
	const slashCount = m.slash_commands?.length ?? 0;

	return (
		<div
			class="rounded border bg-indigo-50 dark:bg-indigo-900/20 border-indigo-200 dark:border-indigo-800"
			data-testid="compact-system-init-card"
		>
			<button
				type="button"
				onClick={() => setExpanded((v) => !v)}
				class="w-full px-2.5 py-1.5 flex items-center justify-between gap-2 hover:bg-indigo-100 dark:hover:bg-indigo-900/30 transition-colors text-left rounded"
				aria-expanded={expanded}
				data-testid="compact-system-init-toggle"
			>
				<div class="flex items-center gap-2 min-w-0">
					{/* Chevron rotates when expanded */}
					<svg
						class={
							'w-3 h-3 flex-shrink-0 text-indigo-600 dark:text-indigo-400 transition-transform ' +
							(expanded ? 'rotate-90' : '')
						}
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<polyline points="9 18 15 12 9 6" />
					</svg>
					<span class="text-[11px] font-medium text-indigo-900 dark:text-indigo-100 flex-shrink-0">
						Session Started
					</span>
					<span class="text-[11px] text-indigo-700 dark:text-indigo-300 font-mono truncate">
						{shortModel(m.model)}
						{m.permissionMode ? ` · ${m.permissionMode}` : ''}
					</span>
				</div>
				<div class="flex items-center gap-2 flex-shrink-0 text-[10px] text-indigo-600 dark:text-indigo-400">
					{toolCount > 0 && <span>{toolCount} tools</span>}
					{mcpCount > 0 && <span>{mcpCount} MCP</span>}
				</div>
			</button>

			{expanded && (
				<div
					class="px-3 py-2 border-t border-indigo-200 dark:border-indigo-800 bg-white/60 dark:bg-gray-900/40 text-[11px] text-indigo-900 dark:text-indigo-100 space-y-1.5"
					data-testid="compact-system-init-details"
				>
					{m.cwd && (
						<div class="flex gap-2">
							<span class="text-indigo-500 dark:text-indigo-400 flex-shrink-0">cwd:</span>
							<span class="font-mono truncate">{m.cwd}</span>
						</div>
					)}
					{toolCount > 0 && (
						<div class="flex gap-2">
							<span class="text-indigo-500 dark:text-indigo-400 flex-shrink-0">tools:</span>
							<span class="font-mono">{toolCount}</span>
						</div>
					)}
					{mcpCount > 0 && (
						<div class="flex gap-2 items-start">
							<span class="text-indigo-500 dark:text-indigo-400 flex-shrink-0">mcp:</span>
							<span class="flex flex-wrap gap-x-2 gap-y-0.5">
								{m.mcp_servers!.map((s) => (
									<span key={s.name} class="font-mono">
										<span
											class={
												s.status === 'connected'
													? 'text-emerald-600 dark:text-emerald-400'
													: 'text-amber-600 dark:text-amber-400'
											}
										>
											{s.name}
										</span>
									</span>
								))}
							</span>
						</div>
					)}
					{slashCount > 0 && (
						<div class="flex gap-2">
							<span class="text-indigo-500 dark:text-indigo-400 flex-shrink-0">slash:</span>
							<span class="font-mono">{slashCount}</span>
						</div>
					)}
					{m.agents && m.agents.length > 0 && (
						<div class="flex gap-2 items-start">
							<span class="text-indigo-500 dark:text-indigo-400 flex-shrink-0">agents:</span>
							<span class="flex flex-wrap gap-x-2 gap-y-0.5 font-mono">
								{m.agents.map((a) => (
									<span key={a}>{a}</span>
								))}
							</span>
						</div>
					)}
					{(m.apiKeySource || m.output_style) && (
						<div class="text-indigo-500 dark:text-indigo-400">
							{m.apiKeySource && <>key: {m.apiKeySource}</>}
							{m.apiKeySource && m.output_style && ' · '}
							{m.output_style && <>output: {m.output_style}</>}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
