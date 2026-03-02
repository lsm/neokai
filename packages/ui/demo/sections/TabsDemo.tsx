import { Tab, TabGroup, TabList, TabPanel, TabPanels } from '../../src/mod.ts';

const horizontalTabs = [
	{
		label: 'Overview',
		content: (
			<div class="space-y-2">
				<p class="text-text-secondary text-sm">
					This is the <strong class="text-text-primary">Overview</strong> tab. It gives you a
					high-level summary of the project.
				</p>
				<ul class="text-sm text-text-tertiary list-disc list-inside space-y-1">
					<li>12 open issues</li>
					<li>3 active pull requests</li>
					<li>Last commit 2 hours ago</li>
				</ul>
			</div>
		),
	},
	{
		label: 'Files',
		content: (
			<div class="space-y-1">
				{['src/', 'tests/', 'docs/', 'package.json', 'tsconfig.json'].map((f) => (
					<div class="flex items-center gap-2 text-sm text-text-secondary py-1" key={f}>
						<span class="text-text-muted">{f.endsWith('/') ? '📁' : '📄'}</span>
						<span class="font-mono">{f}</span>
					</div>
				))}
			</div>
		),
	},
	{
		label: 'Activity',
		content: (
			<div class="space-y-2">
				{[
					{ user: 'alice', action: 'pushed 3 commits', time: '2h ago' },
					{ user: 'bob', action: 'opened PR #42', time: '4h ago' },
					{ user: 'carol', action: 'closed issue #17', time: '6h ago' },
				].map((a) => (
					<div class="flex items-start gap-2 text-sm" key={a.action}>
						<div class="w-6 h-6 rounded-full bg-accent-500/20 flex items-center justify-center text-accent-400 text-xs font-medium flex-shrink-0 mt-0.5">
							{a.user[0].toUpperCase()}
						</div>
						<div>
							<span class="text-text-primary font-medium">{a.user}</span>{' '}
							<span class="text-text-tertiary">{a.action}</span>
							<p class="text-text-muted text-xs mt-0.5">{a.time}</p>
						</div>
					</div>
				))}
			</div>
		),
	},
];

const verticalTabs = [
	{
		label: 'Account',
		content: (
			<div>
				<h4 class="text-sm font-medium text-text-primary mb-2">Account settings</h4>
				<p class="text-sm text-text-tertiary">Manage your account details, email, and password.</p>
			</div>
		),
	},
	{
		label: 'Security',
		content: (
			<div>
				<h4 class="text-sm font-medium text-text-primary mb-2">Security settings</h4>
				<p class="text-sm text-text-tertiary">
					Configure two-factor authentication and active sessions.
				</p>
			</div>
		),
	},
	{
		label: 'Billing',
		content: (
			<div>
				<h4 class="text-sm font-medium text-text-primary mb-2">Billing information</h4>
				<p class="text-sm text-text-tertiary">View invoices and manage your payment methods.</p>
			</div>
		),
	},
	{
		label: 'Notifications',
		content: (
			<div>
				<h4 class="text-sm font-medium text-text-primary mb-2">Notification preferences</h4>
				<p class="text-sm text-text-tertiary">Choose what emails and alerts you receive.</p>
			</div>
		),
	},
];

export function TabsDemo() {
	return (
		<div class="space-y-8">
			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-2">
					Horizontal tabs with underline active indicator
				</h3>
				<TabGroup>
					<TabList class="flex border-b border-surface-border gap-0">
						{horizontalTabs.map((tab) => (
							<Tab
								key={tab.label}
								class="px-4 py-2.5 text-sm font-medium text-text-tertiary border-b-2 border-transparent -mb-px transition-colors cursor-pointer data-[selected]:border-accent-500 data-[selected]:text-accent-400 hover:text-text-primary outline-none data-[focus]:ring-1 data-[focus]:ring-accent-500 data-[focus]:ring-inset"
							>
								{tab.label}
							</Tab>
						))}
					</TabList>
					<TabPanels class="pt-4">
						{horizontalTabs.map((tab) => (
							<TabPanel key={tab.label} class="outline-none">
								{tab.content}
							</TabPanel>
						))}
					</TabPanels>
				</TabGroup>
			</div>

			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-2">
					Vertical tabs (settings-style layout)
				</h3>
				<TabGroup vertical class="flex gap-0">
					<TabList class="flex flex-col border-r border-surface-border w-36 flex-shrink-0">
						{verticalTabs.map((tab) => (
							<Tab
								key={tab.label}
								class="px-3 py-2.5 text-sm font-medium text-text-tertiary border-r-2 border-transparent -mr-px text-left transition-colors cursor-pointer data-[selected]:border-accent-500 data-[selected]:text-accent-400 hover:text-text-primary outline-none data-[focus]:ring-1 data-[focus]:ring-accent-500 data-[focus]:ring-inset"
							>
								{tab.label}
							</Tab>
						))}
					</TabList>
					<TabPanels class="flex-1 pl-5 pt-1">
						{verticalTabs.map((tab) => (
							<TabPanel key={tab.label} class="outline-none">
								{tab.content}
							</TabPanel>
						))}
					</TabPanels>
				</TabGroup>
			</div>

			<div>
				<h3 class="text-sm font-medium text-text-tertiary mb-2">Pill/badge tab style</h3>
				<TabGroup>
					<TabList class="flex gap-1 p-1 bg-surface-2 rounded-lg w-fit">
						{['Day', 'Week', 'Month'].map((label) => (
							<Tab
								key={label}
								class="px-4 py-1.5 text-sm font-medium rounded-md text-text-tertiary transition-all cursor-pointer data-[selected]:bg-surface-0 data-[selected]:text-text-primary data-[selected]:shadow hover:text-text-primary outline-none data-[focus]:ring-1 data-[focus]:ring-accent-500"
							>
								{label}
							</Tab>
						))}
					</TabList>
					<TabPanels class="pt-4">
						{['Day', 'Week', 'Month'].map((label) => (
							<TabPanel key={label} class="outline-none text-sm text-text-tertiary">
								Showing <span class="text-text-primary font-medium">{label}</span> view
							</TabPanel>
						))}
					</TabPanels>
				</TabGroup>
			</div>
		</div>
	);
}
