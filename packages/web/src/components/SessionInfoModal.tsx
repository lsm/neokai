import type { Session } from '@liuboer/shared';
import { Modal } from './ui/Modal.tsx';
import { CopyButton } from './ui/CopyButton.tsx';
import { borderColors } from '../lib/design-tokens.ts';

interface SessionInfoModalProps {
	isOpen: boolean;
	onClose: () => void;
	session: Session | null;
}

interface InfoRowProps {
	label: string;
	value: string | undefined;
	copyLabel?: string;
}

function InfoRow({ label, value, copyLabel }: InfoRowProps) {
	if (!value) return null;

	return (
		<div class={`flex items-center gap-3 py-2 border-b ${borderColors.ui.default} last:border-b-0`}>
			<span class="text-gray-400 text-sm w-32 flex-shrink-0">{label}</span>
			<span class="flex-1 font-mono text-sm text-gray-200 truncate" title={value}>
				{value}
			</span>
			<CopyButton text={value} label={copyLabel || `Copy ${label.toLowerCase()}`} />
		</div>
	);
}

/**
 * Compute SDK project directory path from workspace path
 * SDK replaces both / and . with - (e.g., /.liuboer/ -> --liuboer-)
 */
function getSDKProjectDir(workspacePath: string): string {
	const projectKey = workspacePath.replace(/[/.]/g, '-');
	return `~/.claude/projects/${projectKey}`;
}

export function SessionInfoModal({ isOpen, onClose, session }: SessionInfoModalProps) {
	if (!session) return null;

	const sdkProjectDir = getSDKProjectDir(session.workspacePath);

	return (
		<Modal isOpen={isOpen} onClose={onClose} title="Session Info" size="md">
			<div class="space-y-1">
				<InfoRow label="SDK Folder" value={sdkProjectDir} />
				<InfoRow label="SDK Session ID" value={session.sdkSessionId} />
			</div>
		</Modal>
	);
}
