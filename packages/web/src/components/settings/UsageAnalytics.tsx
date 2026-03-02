import { useMemo } from 'preact/hooks';
import type { Session } from '@neokai/shared';
import { sessions } from '../../lib/state.ts';
import { formatTokens } from '../../lib/utils.ts';
import { SettingsSection } from './SettingsSection.tsx';

interface SessionCostEntry {
	id: string;
	title: string;
	cost: number;
	tokens: number;
	messages: number;
}

interface DailyCost {
	date: string;
	cost: number;
}

function aggregateUsageData(allSessions: Session[]) {
	let totalCost = 0;
	let totalTokens = 0;
	let totalMessages = 0;

	const sessionCosts: SessionCostEntry[] = [];
	const dailyCostMap = new Map<string, number>();

	for (const session of allSessions) {
		const cost = session.metadata.totalCost || 0;
		const tokens = session.metadata.totalTokens || 0;
		const messages = session.metadata.messageCount || 0;

		totalCost += cost;
		totalTokens += tokens;
		totalMessages += messages;

		if (cost > 0) {
			sessionCosts.push({
				id: session.id,
				title: session.title || 'Untitled',
				cost,
				tokens,
				messages,
			});
		}

		// Aggregate by date (guard against invalid dates)
		const created = new Date(session.createdAt);
		if (!Number.isNaN(created.getTime())) {
			const date = created.toISOString().split('T')[0];
			dailyCostMap.set(date, (dailyCostMap.get(date) || 0) + cost);
		}
	}

	// Sort sessions by cost descending, take top 10
	sessionCosts.sort((a, b) => b.cost - a.cost);
	const topSessions = sessionCosts.slice(0, 10);

	// Sort daily costs by date
	const dailyCosts: DailyCost[] = Array.from(dailyCostMap.entries())
		.map(([date, cost]) => ({ date, cost }))
		.sort((a, b) => a.date.localeCompare(b.date))
		.slice(-14); // Last 14 days

	return { totalCost, totalTokens, totalMessages, topSessions, dailyCosts };
}

function StatCard({ label, value, subtext }: { label: string; value: string; subtext?: string }) {
	return (
		<div class="bg-dark-800 border border-dark-700 rounded-lg p-4">
			<div class="text-xs text-gray-400 mb-1">{label}</div>
			<div class="text-xl font-semibold text-gray-100">{value}</div>
			{subtext && <div class="text-xs text-gray-500 mt-1">{subtext}</div>}
		</div>
	);
}

function CostBar({ maxCost, entry }: { maxCost: number; entry: SessionCostEntry }) {
	const width = maxCost > 0 ? (entry.cost / maxCost) * 100 : 0;
	return (
		<div class="flex items-center gap-3 py-1.5">
			<div class="flex-1 min-w-0">
				<div class="text-xs text-gray-300 truncate">{entry.title}</div>
				<div class="mt-1 h-2 bg-dark-700 rounded-full overflow-hidden">
					<div
						class="h-full bg-green-500/60 rounded-full transition-all"
						style={{ width: `${width}%` }}
					/>
				</div>
			</div>
			<div class="text-xs font-mono text-green-400 flex-shrink-0 w-20 text-right">
				${entry.cost.toFixed(4)}
			</div>
		</div>
	);
}

function DailyChart({ dailyCosts }: { dailyCosts: DailyCost[] }) {
	if (dailyCosts.length === 0) {
		return <div class="text-xs text-gray-500 text-center py-4">No cost data available</div>;
	}

	const maxDailyCost = Math.max(...dailyCosts.map((d) => d.cost));

	return (
		<div class="flex items-end gap-1 h-24">
			{dailyCosts.map((day) => {
				const height = maxDailyCost > 0 ? (day.cost / maxDailyCost) * 100 : 0;
				const dateLabel = day.date.slice(5); // MM-DD
				return (
					<div key={day.date} class="flex-1 flex flex-col items-center gap-1">
						<div class="w-full flex items-end justify-center" style={{ height: '80px' }}>
							<div
								class="w-full max-w-[20px] bg-blue-500/50 rounded-t transition-all hover:bg-blue-500/80"
								style={{ height: `${Math.max(height, 2)}%` }}
								title={`${dateLabel}: $${day.cost.toFixed(4)}`}
							/>
						</div>
						<div class="text-[9px] text-gray-500 whitespace-nowrap">{dateLabel}</div>
					</div>
				);
			})}
		</div>
	);
}

export function UsageAnalytics() {
	const allSessions = sessions.value;

	const data = useMemo(() => aggregateUsageData(allSessions), [allSessions]);

	return (
		<div class="space-y-6">
			<SettingsSection title="Overview">
				<div class="grid grid-cols-3 gap-3">
					<StatCard
						label="Total Cost"
						value={`$${data.totalCost.toFixed(2)}`}
						subtext={`${allSessions.length} sessions`}
					/>
					<StatCard
						label="Total Tokens"
						value={formatTokens(data.totalTokens)}
						subtext={`${data.totalMessages} messages`}
					/>
					<StatCard
						label="Avg Cost / Session"
						value={`$${allSessions.length > 0 ? (data.totalCost / allSessions.length).toFixed(4) : '0.00'}`}
					/>
				</div>
			</SettingsSection>

			<SettingsSection title="Daily Cost (Last 14 Days)">
				<DailyChart dailyCosts={data.dailyCosts} />
			</SettingsSection>

			<SettingsSection title="Top Sessions by Cost">
				{data.topSessions.length === 0 ? (
					<div class="text-xs text-gray-500 text-center py-4">No session cost data yet</div>
				) : (
					<div class="space-y-1">
						{data.topSessions.map((entry) => (
							<CostBar key={entry.id} entry={entry} maxCost={data.topSessions[0].cost} />
						))}
					</div>
				)}
			</SettingsSection>
		</div>
	);
}
