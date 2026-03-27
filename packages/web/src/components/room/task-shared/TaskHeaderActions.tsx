export interface TaskHeaderActionsProps {
	canInterrupt: boolean;
	interrupting: boolean;
	onInterrupt: () => void;
	canReactivate: boolean;
	reactivating: boolean;
	onReactivate: () => void;
	isInfoPanelOpen: boolean;
	onToggleInfoPanel: () => void;
}

export function TaskHeaderActions({
	canInterrupt,
	interrupting,
	onInterrupt,
	canReactivate,
	reactivating,
	onReactivate,
	isInfoPanelOpen,
	onToggleInfoPanel,
}: TaskHeaderActionsProps) {
	return (
		<>
			{/* Stop (interrupt) button - quick action outside dropdown */}
			{canInterrupt && (
				<button
					class="p-1.5 rounded text-amber-400 hover:text-amber-300 hover:bg-dark-700 transition-colors disabled:opacity-50"
					onClick={onInterrupt}
					title="Interrupt generation (task stays active, type your suggestions)"
					disabled={interrupting}
					data-testid="task-stop-button"
				>
					<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
						<rect x="6" y="6" width="12" height="12" rx="1" />
					</svg>
				</button>
			)}
			{/* Reactivate button - standalone, shown for completed/cancelled tasks */}
			{canReactivate && (
				<button
					class="py-1 px-2.5 rounded-lg text-xs bg-blue-700 hover:bg-blue-600 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
					onClick={() => void onReactivate()}
					disabled={reactivating}
					data-testid="task-reactivate-button"
					title="Reactivate task"
				>
					{reactivating ? (
						'Reactivating…'
					) : (
						<>
							<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
								/>
							</svg>
							Reactivate
						</>
					)}
				</button>
			)}
			{/* Gear button - toggles info panel below header */}
			<button
				class={`p-1.5 rounded transition-colors ${
					isInfoPanelOpen
						? 'bg-blue-600 text-white'
						: 'text-gray-400 hover:text-gray-200 hover:bg-dark-700'
				}`}
				onClick={onToggleInfoPanel}
				title="Task info and actions"
				data-testid="task-info-panel-trigger"
			>
				<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
					/>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
					/>
				</svg>
			</button>
		</>
	);
}
