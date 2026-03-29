import type { WorkflowChannel } from '@neokai/shared';
import { ChannelEdgeConfigPanel } from './ChannelEdgeConfigPanel';

export interface ChannelRelationConfigPanelProps {
	title: string;
	description: string;
	channels: Array<{
		index: number;
		channel: WorkflowChannel;
	}>;
	onChange: (index: number, channel: WorkflowChannel) => void;
	onDelete: (index: number) => void;
	onClose: () => void;
}

export function ChannelRelationConfigPanel({
	title,
	description,
	channels,
	onChange,
	onDelete,
	onClose,
}: ChannelRelationConfigPanelProps) {
	return (
		<div
			data-testid="channel-relation-config-panel"
			style={{
				position: 'absolute',
				top: 0,
				right: 0,
				bottom: 0,
				width: 360,
				display: 'flex',
				flexDirection: 'column',
				zIndex: 20,
			}}
			class="bg-dark-900 border-l border-dark-700 shadow-xl animate-slideInRight"
		>
			<div class="flex items-start justify-between gap-3 px-4 py-3 border-b border-dark-700 flex-shrink-0">
				<div class="min-w-0">
					<h3 class="text-sm font-semibold text-gray-100 truncate">{title}</h3>
					<p class="mt-1 text-xs text-gray-500">{description}</p>
				</div>
				<button
					data-testid="channel-relation-close-button"
					onClick={onClose}
					class="p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-dark-700 transition-colors flex-shrink-0"
					title="Close panel"
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

			<div class="flex-1 overflow-y-auto px-4 py-4 space-y-3">
				{channels.length > 0 ? (
					channels.map(({ index, channel }) => (
						<ChannelEdgeConfigPanel
							key={`${index}-${channel.from}-${Array.isArray(channel.to) ? channel.to.join(',') : channel.to}`}
							index={index}
							channel={channel}
							onChange={onChange}
							onDelete={onDelete}
							showHeader={false}
						/>
					))
				) : (
					<p class="text-xs text-gray-600">No editable channel links found for this relation.</p>
				)}
			</div>
		</div>
	);
}
