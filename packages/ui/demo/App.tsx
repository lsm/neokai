import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { ButtonDemo } from './sections/ButtonDemo.tsx';
import { CheckboxDemo } from './sections/CheckboxDemo.tsx';
import { ComboboxDemo } from './sections/ComboboxDemo.tsx';
import { DialogDemo } from './sections/DialogDemo.tsx';
import { DisclosureDemo } from './sections/DisclosureDemo.tsx';
import { FieldDemo } from './sections/FieldDemo.tsx';
import { IconButtonDemo } from './sections/IconButtonDemo.tsx';
import { InputDemo } from './sections/InputDemo.tsx';
import { ListboxDemo } from './sections/ListboxDemo.tsx';
import { MenuDemo } from './sections/MenuDemo.tsx';
import { PopoverDemo } from './sections/PopoverDemo.tsx';
import { RadioGroupDemo } from './sections/RadioGroupDemo.tsx';
import { SkeletonDemo } from './sections/SkeletonDemo.tsx';
import { SpinnerDemo } from './sections/SpinnerDemo.tsx';
import { SwitchDemo } from './sections/SwitchDemo.tsx';
import { TabsDemo } from './sections/TabsDemo.tsx';
import { ToastDemo } from './sections/ToastDemo.tsx';
import { TooltipDemo } from './sections/TooltipDemo.tsx';
import { TransitionDemo } from './sections/TransitionDemo.tsx';

interface DemoSectionProps {
	id: string;
	title: string;
	children: ComponentChildren;
}

function DemoSection({ id, title, children }: DemoSectionProps) {
	return (
		<section id={id} class="py-12 border-b border-surface-border">
			<h2 class="text-2xl font-bold mb-6">{title}</h2>
			{children}
		</section>
	);
}

function SunIcon() {
	return (
		<svg class="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
			<path
				fill-rule="evenodd"
				d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z"
				clip-rule="evenodd"
			/>
		</svg>
	);
}

function MoonIcon() {
	return (
		<svg class="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
			<path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
		</svg>
	);
}

const sections = [
	{ id: 'button', label: 'Button' },
	{ id: 'icon-button', label: 'IconButton' },
	{ id: 'checkbox', label: 'Checkbox' },
	{ id: 'switch', label: 'Switch' },
	{ id: 'radio-group', label: 'RadioGroup' },
	{ id: 'input', label: 'Input' },
	{ id: 'field', label: 'Field' },
	{ id: 'dialog', label: 'Dialog' },
	{ id: 'menu', label: 'Menu' },
	{ id: 'disclosure', label: 'Disclosure' },
	{ id: 'popover', label: 'Popover' },
	{ id: 'tooltip', label: 'Tooltip' },
	{ id: 'toast', label: 'Toast' },
	{ id: 'tabs', label: 'Tabs' },
	{ id: 'listbox', label: 'Listbox' },
	{ id: 'combobox', label: 'Combobox' },
	{ id: 'transition', label: 'Transition' },
	{ id: 'spinner', label: 'Spinner' },
	{ id: 'skeleton', label: 'Skeleton' },
];

export function App() {
	const [theme, setTheme] = useState<'dark' | 'light'>('dark');

	function toggleTheme() {
		const next = theme === 'dark' ? 'light' : 'dark';
		setTheme(next);
		if (next === 'dark') {
			document.documentElement.classList.add('dark');
		} else {
			document.documentElement.classList.remove('dark');
		}
	}

	return (
		<div class="min-h-screen bg-surface-0 text-text-primary">
			{/* Sidebar */}
			<nav class="fixed left-0 top-0 w-56 h-screen overflow-y-auto bg-surface-1 border-r border-surface-border z-10">
				<div class="p-4">
					<p class="text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-4">
						Components
					</p>
					<ul class="space-y-1">
						{sections.map((s) => (
							<li key={s.id}>
								<a
									href={`#${s.id}`}
									class="block px-3 py-1.5 rounded text-sm text-text-secondary hover:text-text-primary hover:bg-surface-2 transition-colors"
								>
									{s.label}
								</a>
							</li>
						))}
					</ul>
				</div>
			</nav>

			{/* Content */}
			<div class="ml-56">
				{/* Header */}
				<header class="px-8 pt-10 pb-4 border-b border-surface-border flex items-start justify-between">
					<div>
						<h1 class="text-3xl font-bold text-text-primary">@neokai/ui — Kitchen Sink</h1>
						<p class="mt-2 text-text-tertiary">Visual demo of all headless UI components</p>
					</div>
					<button
						type="button"
						onClick={toggleTheme}
						title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
						class="mt-2 p-2 rounded-lg border border-surface-border text-text-tertiary hover:text-text-primary hover:bg-surface-2 transition-colors cursor-pointer"
					>
						{theme === 'dark' ? <SunIcon /> : <MoonIcon />}
					</button>
				</header>

				{/* Main */}
				<main class="px-8 max-w-4xl">
					<DemoSection id="button" title="Button">
						<ButtonDemo />
					</DemoSection>
					<DemoSection id="icon-button" title="IconButton">
						<IconButtonDemo />
					</DemoSection>
					<DemoSection id="checkbox" title="Checkbox">
						<CheckboxDemo />
					</DemoSection>
					<DemoSection id="switch" title="Switch">
						<SwitchDemo />
					</DemoSection>
					<DemoSection id="radio-group" title="RadioGroup">
						<RadioGroupDemo />
					</DemoSection>
					<DemoSection id="input" title="Input">
						<InputDemo />
					</DemoSection>
					<DemoSection id="field" title="Field">
						<FieldDemo />
					</DemoSection>
					<DemoSection id="dialog" title="Dialog">
						<DialogDemo />
					</DemoSection>
					<DemoSection id="menu" title="Menu">
						<MenuDemo />
					</DemoSection>
					<DemoSection id="disclosure" title="Disclosure">
						<DisclosureDemo />
					</DemoSection>
					<DemoSection id="popover" title="Popover">
						<PopoverDemo />
					</DemoSection>
					<DemoSection id="tooltip" title="Tooltip">
						<TooltipDemo />
					</DemoSection>
					<DemoSection id="toast" title="Toast">
						<ToastDemo />
					</DemoSection>
					<DemoSection id="tabs" title="Tabs">
						<TabsDemo />
					</DemoSection>
					<DemoSection id="listbox" title="Listbox">
						<ListboxDemo />
					</DemoSection>
					<DemoSection id="combobox" title="Combobox">
						<ComboboxDemo />
					</DemoSection>
					<DemoSection id="transition" title="Transition">
						<TransitionDemo />
					</DemoSection>
					<DemoSection id="spinner" title="Spinner">
						<SpinnerDemo />
					</DemoSection>
					<DemoSection id="skeleton" title="Skeleton">
						<SkeletonDemo />
					</DemoSection>
				</main>
			</div>
		</div>
	);
}
