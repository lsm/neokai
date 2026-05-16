import { GitPanel } from '../components/GitPanel.tsx';
import { rightPanelTargetSignal } from '../lib/signals.ts';

export function RightPanel() {
	const target = rightPanelTargetSignal.value;

	if (!target) return null;

	if (target.type === 'git') {
		return (
			<GitPanel
				sessionId={target.sessionId}
				onClose={() => (rightPanelTargetSignal.value = null)}
			/>
		);
	}

	return null;
}
