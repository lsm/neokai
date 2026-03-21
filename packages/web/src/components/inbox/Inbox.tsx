import { useEffect, useState } from 'preact/hooks';
import { inboxStore, type InboxTask } from '../../lib/inbox-store.ts';
import { Spinner } from '../ui/Spinner.tsx';
import { toast } from '../../lib/toast.ts';
import {
	currentRoomIdSignal,
	currentRoomTaskIdSignal,
	navSectionSignal,
} from '../../lib/signals.ts';

function InboxTaskCard({
	item,
	approvingId,
	onStartApprove,
	onFinishApprove,
}: {
	item: InboxTask;
	approvingId: string | null;
	onStartApprove: (id: string) => void;
	onFinishApprove: () => void;
}) {
	const [isRejecting, setIsRejecting] = useState(false);
	const [feedback, setFeedback] = useState('');
	const isApproving = approvingId === item.task.id;
	const anyApproving = approvingId !== null;

	const handleView = () => {
		navSectionSignal.value = 'rooms';
		currentRoomIdSignal.value = item.roomId;
		currentRoomTaskIdSignal.value = item.task.id;
	};

	const handleApprove = async () => {
		onStartApprove(item.task.id);
		const ok = await inboxStore.approveTask(item.task.id, item.roomId);
		if (ok) toast.approved();
		onFinishApprove();
	};

	const handleRejectSubmit = async () => {
		if (!feedback.trim()) return;
		const ok = await inboxStore.rejectTask(item.task.id, item.roomId, feedback.trim());
		if (ok) {
			toast.rejected();
			setFeedback('');
			setIsRejecting(false);
		}
	};

	return (
		<div class="flex flex-col px-4 py-3 border-b border-dark-700 hover:bg-dark-800 transition-colors border-l-[3px] border-l-amber-500">
			<div class="flex items-start gap-3">
				<div class="flex-1 min-w-0">
					<p class="text-gray-100 font-medium text-sm truncate">{item.task.title}</p>
					<p class="text-gray-500 text-xs mt-0.5">{item.roomTitle}</p>
				</div>
				<div class="flex items-center gap-2 shrink-0">
					<button
						type="button"
						onClick={handleApprove}
						disabled={anyApproving}
						class="bg-green-600 hover:bg-green-700 text-white text-xs px-3 py-1 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 transition-colors"
					>
						{isApproving ? (
							<>
								<Spinner size="sm" />
								<span>Approving…</span>
							</>
						) : (
							'Approve'
						)}
					</button>
					<button
						type="button"
						onClick={() => setIsRejecting((v) => !v)}
						disabled={anyApproving}
						class="border border-red-600 text-red-400 hover:bg-red-900/20 text-xs px-3 py-1 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
					>
						Reject
					</button>
					<button
						type="button"
						onClick={handleView}
						class="text-gray-400 hover:text-gray-200 hover:bg-dark-700 text-xs px-3 py-1 rounded-lg transition-colors"
					>
						View
					</button>
				</div>
			</div>
			{isRejecting && (
				<div class="mt-3 pt-3 border-t border-dark-700">
					<textarea
						rows={2}
						placeholder="Provide feedback..."
						value={feedback}
						onInput={(e) => setFeedback((e.target as HTMLTextAreaElement).value)}
						class="w-full text-sm bg-dark-900 border border-dark-600 rounded px-3 py-2 text-gray-200 placeholder-gray-500 resize-none focus:outline-none focus:border-red-500/60"
					/>
					<div class="flex justify-end gap-2 mt-2">
						<button
							type="button"
							onClick={() => {
								setFeedback('');
								setIsRejecting(false);
							}}
							class="px-3 py-1.5 text-xs font-medium text-gray-400 bg-dark-800 hover:bg-dark-700 border border-dark-600 rounded transition-colors"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={handleRejectSubmit}
							disabled={!feedback.trim()}
							class="px-3 py-1.5 text-xs font-medium text-red-400 bg-red-900/20 hover:bg-red-900/30 border border-red-700/50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
						>
							Send Feedback
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

function EmptyState() {
	return (
		<div class="flex flex-col items-center justify-center h-full gap-2 text-gray-500">
			<p class="text-sm">No tasks awaiting review</p>
		</div>
	);
}

export function Inbox() {
	const items = inboxStore.items.value;
	const isLoading = inboxStore.isLoading.value;
	const count = inboxStore.reviewCount.value;
	const [approvingId, setApprovingId] = useState<string | null>(null);

	useEffect(() => {
		inboxStore.refresh();
	}, []);

	return (
		<div class="flex flex-col h-full">
			<div class="px-6 py-4 border-b border-dark-700 flex items-center justify-between">
				<h1 class="text-lg font-semibold text-gray-100">Inbox</h1>
				<span class="text-xs text-gray-500">
					{count} awaiting review · approve or reject below
				</span>
			</div>
			<div class="flex-1 overflow-y-auto">
				{isLoading && (
					<div class="flex items-center justify-center p-8">
						<Spinner size="md" />
					</div>
				)}
				{!isLoading && items.length === 0 && <EmptyState />}
				{!isLoading &&
					items.map((item) => (
						<InboxTaskCard
							key={item.task.id}
							item={item}
							approvingId={approvingId}
							onStartApprove={setApprovingId}
							onFinishApprove={() => setApprovingId(null)}
						/>
					))}
			</div>
		</div>
	);
}
