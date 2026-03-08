import { useState } from 'preact/hooks';
import { Button } from './ui/Button';
import { LightningIcon } from './icons/index.tsx';

interface WorktreeChoiceInlineProps {
	sessionId: string;
	workspacePath: string;
	onModeChange: (mode: 'worktree' | 'direct') => void;
}

export function WorktreeChoiceInline({
	sessionId: _sessionId,
	workspacePath: _workspacePath,
	onModeChange,
}: WorktreeChoiceInlineProps) {
	const [selectedMode, setSelectedMode] = useState<'worktree' | 'direct'>('worktree'); // Default to worktree

	const handleModeChange = (mode: 'worktree' | 'direct') => {
		setSelectedMode(mode);
		onModeChange(mode);
	};

	return (
		<div class="max-w-4xl mx-auto px-4 py-3">
			<div class="rounded-2xl border border-dark-700 bg-dark-800/80 backdrop-blur-sm p-4">
				<div class="flex items-center justify-between gap-4">
					<div class="flex items-center gap-3">
						<svg
							class="w-5 h-5 text-green-400"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M7 21V3m0 18c3-3 7-3 10 0M7 3c0 4 3 7 7 7"
							/>
						</svg>
						<div>
							<div class="text-sm font-medium text-gray-100">Workspace Mode</div>
							<div class="text-xs text-gray-400">
								{selectedMode === 'worktree'
									? 'Isolated worktree mode (safe)'
									: 'Direct workspace mode (fast)'}
							</div>
						</div>
					</div>

					<div class="flex items-center gap-2">
						<Button
							variant={selectedMode === 'worktree' ? 'primary' : 'secondary'}
							size="sm"
							onClick={() => handleModeChange('worktree')}
						>
							Worktree
						</Button>
						<Button
							variant={selectedMode === 'direct' ? 'primary' : 'secondary'}
							size="sm"
							onClick={() => handleModeChange('direct')}
							icon={<LightningIcon className="w-3.5 h-3.5" />}
						>
							Direct
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
