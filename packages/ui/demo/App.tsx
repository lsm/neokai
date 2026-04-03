import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { ChevronDown, ChevronRight, Sun, Moon } from 'lucide-preact';
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
import { CommandPaletteDemo } from './sections/CommandPaletteDemo.tsx';
import { DrawerDemo } from './sections/DrawerDemo.tsx';
import { NotificationDemo } from './sections/NotificationDemo.tsx';
import { StatsDemo } from './sections/StatsDemo.tsx';
import { GridListsDemo } from './sections/GridListsDemo.tsx';
import { StackedListsDemo } from './sections/StackedListsDemo.tsx';
import { TablesDemo } from './sections/TablesDemo.tsx';
import { PaginationDemo } from './sections/PaginationDemo.tsx';
import { ProgressBarsDemo } from './sections/ProgressBarsDemo.tsx';
import { VerticalNavigationDemo } from './sections/VerticalNavigationDemo.tsx';
import { BreadcrumbsDemo } from './sections/BreadcrumbsDemo.tsx';
import { SidebarNavigationDemo } from './sections/SidebarNavigationDemo.tsx';
import { EmptyStatesDemo } from './sections/EmptyStatesDemo.tsx';
import { FeedsDemo } from './sections/FeedsDemo.tsx';
import { CalendarsDemo } from './sections/CalendarsDemo.tsx';
import { DescriptionListsDemo } from './sections/DescriptionListsDemo.tsx';
import { MultiColumnDemo } from './sections/MultiColumnDemo.tsx';
import { AlertsDemo } from './sections/feedback/alerts/AlertsDemo.tsx';
import { AvatarsDemo } from './sections/elements/avatars/AvatarsDemo.tsx';
import { BadgesDemo } from './sections/elements/badges/BadgesDemo.tsx';
import { ButtonsDemo } from './sections/elements/buttons/ButtonsDemo.tsx';
import { ButtonGroupsDemo } from './sections/elements/button-groups/ButtonGroupsDemo.tsx';
import { CardHeadingsDemo } from './sections/headings/card-headings/CardHeadingsDemo.tsx';
import { PageHeadingsDemo } from './sections/headings/page-headings/PageHeadingsDemo.tsx';
import { SectionHeadingsDemo } from './sections/headings/section-headings/SectionHeadingsDemo.tsx';
import { CardsDemo } from './sections/layout/cards/CardsDemo.tsx';
import { ContainersDemo } from './sections/layout/containers/ContainersDemo.tsx';
import { DividersDemo } from './sections/layout/dividers/DividersDemo.tsx';
import { ListContainersDemo } from './sections/layout/list-containers/ListContainersDemo.tsx';
import { MediaObjectsDemo } from './sections/layout/media-objects/MediaObjectsDemo.tsx';
import { ActionPanelsDemo } from './sections/ActionPanelsDemo.tsx';
import { CheckboxesDemo } from './sections/CheckboxesDemo.tsx';
import { InputGroupsDemo } from './sections/forms/input-groups/InputGroupsDemo.tsx';
import { RadioGroupsDemo } from './sections/forms/radio-groups/RadioGroupsDemo.tsx';
import { SignInFormsDemo } from './sections/SignInFormsDemo.tsx';
import { TextareasDemo } from './sections/TextareasDemo.tsx';
import { TogglesDemo } from './sections/TogglesDemo.tsx';
import { FormLayoutsDemo } from './sections/forms/form-layouts/FormLayoutsDemo.tsx';
import { SelectMenusDemo } from './sections/forms/select-menus/SelectMenusDemo.tsx';
import { ComboboxesDemo } from './sections/forms/comboboxes/ComboboxesDemo.tsx';
import { CustomSelectMenusDemo } from './sections/forms/select-menus/CustomSelectMenusDemo.tsx';
import { MultiColumnShellsDemo } from './sections/application-shells/multi-column/MultiColumnShellsDemo.tsx';
import { SidebarShellsDemo } from './sections/application-shells/sidebar/SidebarShellsDemo.tsx';
import { StackedShellsDemo } from './sections/application-shells/stacked/StackedShellsDemo.tsx';
import { DropdownsDemo } from './sections/elements/dropdowns/DropdownsDemo.tsx';
import { CalendarsHeadlessDemo } from './sections/data-display/calendars/CalendarsHeadlessDemo.tsx';

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

// Component category (existing demos)
const componentSections = [
	{ id: 'button', label: 'Button' },
	{ id: 'icon-button', label: 'IconButton' },
	{ id: 'checkbox', label: 'Checkbox' },
	{ id: 'switch', label: 'Switch' },
	{ id: 'radio-group', label: 'RadioGroup' },
	{ id: 'input', label: 'Input' },
	{ id: 'field', label: 'Field' },
	{ id: 'dialog', label: 'Dialog' },
	{ id: 'command-palette', label: 'Command Palette' },
	{ id: 'drawer', label: 'Drawer' },
	{ id: 'menu', label: 'Menu' },
	{ id: 'disclosure', label: 'Disclosure' },
	{ id: 'popover', label: 'Popover' },
	{ id: 'tooltip', label: 'Tooltip' },
	{ id: 'toast', label: 'Toast' },
	{ id: 'notification', label: 'Notification' },
	{ id: 'tabs', label: 'Tabs' },
	{ id: 'listbox', label: 'Listbox' },
	{ id: 'combobox', label: 'Combobox' },
	{ id: 'transition', label: 'Transition' },
	{ id: 'spinner', label: 'Spinner' },
	{ id: 'skeleton', label: 'Skeleton' },
	{ id: 'stats', label: 'Stats' },
	{ id: 'grid-lists', label: 'Grid Lists' },
	{ id: 'stacked-lists', label: 'Stacked Lists' },
	{ id: 'tables', label: 'Tables' },
	{ id: 'pagination', label: 'Pagination' },
	{ id: 'progress-bars', label: 'Progress Bars' },
	{ id: 'vertical-navigation', label: 'Vertical Navigation' },
	{ id: 'breadcrumbs', label: 'Breadcrumbs' },
	{ id: 'sidebar-navigation', label: 'Sidebar Navigation' },
	{ id: 'feeds', label: 'Feeds' },
	{ id: 'empty-states', label: 'Empty States' },
];

// Application UI subcategories (placeholder sections for future demos)
interface SidebarSection {
	id: string;
	label: string;
}

interface SidebarCategory {
	id: string;
	label: string;
	sections: SidebarSection[];
}

const applicationUiCategories: SidebarCategory[] = [
	{
		id: 'application-shells',
		label: 'Application Shells',
		sections: [
			{ id: 'multi-column', label: 'Multi-column' },
			{ id: 'sidebar', label: 'Sidebar' },
			{ id: 'stacked', label: 'Stacked' },
		],
	},
	{
		id: 'data-display',
		label: 'Data Display',
		sections: [
			{ id: 'calendars', label: 'Calendars' },
			{ id: 'description-lists', label: 'Description Lists' },
			{ id: 'stats', label: 'Stats' },
		],
	},
	{
		id: 'elements',
		label: 'Elements',
		sections: [
			{ id: 'avatars', label: 'Avatars' },
			{ id: 'badges', label: 'Badges' },
			{ id: 'button-groups', label: 'Button Groups' },
			{ id: 'buttons', label: 'Buttons' },
			{ id: 'dropdowns', label: 'Dropdowns' },
		],
	},
	{
		id: 'feedback',
		label: 'Feedback',
		sections: [
			{ id: 'alerts', label: 'Alerts' },
			{ id: 'empty-states', label: 'Empty States' },
		],
	},
	{
		id: 'forms',
		label: 'Forms',
		sections: [
			{ id: 'action-panels', label: 'Action Panels' },
			{ id: 'checkboxes', label: 'Checkboxes' },
			{ id: 'comboboxes', label: 'Comboboxes' },
			{ id: 'form-layouts', label: 'Form Layouts' },
			{ id: 'input-groups', label: 'Input Groups' },
			{ id: 'radio-groups', label: 'Radio Groups' },
			{ id: 'select-menus', label: 'Select Menus' },
			{ id: 'sign-in-forms', label: 'Sign-in Forms' },
			{ id: 'textareas', label: 'Textareas' },
			{ id: 'toggles', label: 'Toggles' },
		],
	},
	{
		id: 'headings',
		label: 'Headings',
		sections: [
			{ id: 'card-headings', label: 'Card Headings' },
			{ id: 'page-headings', label: 'Page Headings' },
			{ id: 'section-headings', label: 'Section Headings' },
		],
	},
	{
		id: 'layout',
		label: 'Layout',
		sections: [
			{ id: 'cards', label: 'Cards' },
			{ id: 'containers', label: 'Containers' },
			{ id: 'dividers', label: 'Dividers' },
			{ id: 'list-containers', label: 'List Containers' },
			{ id: 'media-objects', label: 'Media Objects' },
		],
	},
	{
		id: 'lists',
		label: 'Lists',
		sections: [
			{ id: 'feeds', label: 'Feeds' },
			{ id: 'grid-lists', label: 'Grid Lists' },
			{ id: 'stacked-lists', label: 'Stacked Lists' },
			{ id: 'tables', label: 'Tables' },
		],
	},
	{
		id: 'navigation',
		label: 'Navigation',
		sections: [
			{ id: 'breadcrumbs', label: 'Breadcrumbs' },
			{ id: 'command-palettes', label: 'Command Palettes' },
			{ id: 'navbars', label: 'Navbars' },
			{ id: 'pagination', label: 'Pagination' },
			{ id: 'progress-bars', label: 'Progress Bars' },
			{ id: 'sidebar-navigation', label: 'Sidebar Navigation' },
			{ id: 'tabs', label: 'Tabs' },
			{ id: 'vertical-navigation', label: 'Vertical Navigation' },
		],
	},
	{
		id: 'overlays',
		label: 'Overlays',
		sections: [
			{ id: 'drawers', label: 'Drawers' },
			{ id: 'modal-dialogs', label: 'Modal Dialogs' },
			{ id: 'notifications', label: 'Notifications' },
		],
	},
	{
		id: 'page-examples',
		label: 'Page Examples',
		sections: [
			{ id: 'detail-screens', label: 'Detail Screens' },
			{ id: 'home-screens', label: 'Home Screens' },
			{ id: 'settings-screens', label: 'Settings Screens' },
		],
	},
];

interface CategoryProps {
	category: SidebarCategory;
	defaultOpen?: boolean;
}

function Category({ category, defaultOpen = false }: CategoryProps) {
	const [isOpen, setIsOpen] = useState(defaultOpen);

	return (
		<li>
			<button
				type="button"
				onClick={() => setIsOpen(!isOpen)}
				class="flex items-center w-full px-3 py-2 text-sm font-medium text-text-secondary hover:text-text-primary hover:bg-surface-2 rounded transition-colors cursor-pointer"
			>
				{isOpen ? (
					<ChevronDown class="w-4 h-4 mr-2 flex-shrink-0" />
				) : (
					<ChevronRight class="w-4 h-4 mr-2 flex-shrink-0" />
				)}
				{category.label}
			</button>
			{isOpen && (
				<ul class="ml-4 mt-1 space-y-0.5 border-l border-surface-border pl-2">
					{category.sections.map((section) => (
						<li key={section.id}>
							<a
								href={`#${category.id}-${section.id}`}
								class="block px-3 py-1.5 text-xs text-text-tertiary hover:text-text-primary hover:bg-surface-2 rounded transition-colors"
							>
								{section.label}
							</a>
						</li>
					))}
				</ul>
			)}
		</li>
	);
}

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
			<nav class="fixed left-0 top-0 w-64 h-screen overflow-y-auto bg-surface-1 border-r border-surface-border z-10">
				<div class="p-4">
					{/* Components section */}
					<div class="mb-6">
						<p class="px-3 text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-2">
							Components
						</p>
						<ul class="space-y-0.5">
							{componentSections.map((s) => (
								<li key={s.id}>
									<a
										href={`#${s.id}`}
										class="block px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary hover:bg-surface-2 rounded transition-colors"
									>
										{s.label}
									</a>
								</li>
							))}
						</ul>
					</div>

					{/* Application UI section */}
					<div>
						<p class="px-3 text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-2">
							Application UI
						</p>
						<ul class="space-y-1">
							{applicationUiCategories.map((category) => (
								<Category
									key={category.id}
									category={category}
									defaultOpen={[
										'application-shells',
										'elements',
										'feedback',
										'forms',
										'headings',
										'layout',
									].includes(category.id)}
								/>
							))}
						</ul>
					</div>
				</div>
			</nav>

			{/* Content */}
			<div class="ml-64">
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
						{theme === 'dark' ? <Sun class="w-5 h-5" /> : <Moon class="w-5 h-5" />}
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
					<DemoSection id="command-palette" title="Command Palette (Dialog + Combobox)">
						<CommandPaletteDemo />
					</DemoSection>
					<DemoSection id="drawer" title="Drawer">
						<DrawerDemo />
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
					<DemoSection id="notification" title="Notification (Toast Variants)">
						<NotificationDemo />
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
					<DemoSection id="stats" title="Stats">
						<StatsDemo />
					</DemoSection>
					<DemoSection id="grid-lists" title="Grid Lists">
						<GridListsDemo />
					</DemoSection>
					<DemoSection id="stacked-lists" title="Stacked Lists">
						<StackedListsDemo />
					</DemoSection>
					<DemoSection id="tables" title="Tables">
						<TablesDemo />
					</DemoSection>
					<DemoSection id="pagination" title="Pagination">
						<PaginationDemo />
					</DemoSection>
					<DemoSection id="progress-bars" title="Progress Bars">
						<ProgressBarsDemo />
					</DemoSection>
					<DemoSection id="vertical-navigation" title="Vertical Navigation">
						<VerticalNavigationDemo />
					</DemoSection>
					<DemoSection id="breadcrumbs" title="Breadcrumbs">
						<BreadcrumbsDemo />
					</DemoSection>
					<DemoSection id="sidebar-navigation" title="Sidebar Navigation">
						<SidebarNavigationDemo />
					</DemoSection>
					<DemoSection id="feeds" title="Feeds">
						<FeedsDemo />
					</DemoSection>
					<DemoSection id="empty-states" title="Empty States">
						<EmptyStatesDemo />
					</DemoSection>
					{/* Application UI - Feedback */}
					<DemoSection id="feedback-alerts" title="Feedback / Alerts">
						<AlertsDemo />
					</DemoSection>

					{/* Application UI - Elements */}
					<DemoSection id="elements-avatars" title="Elements / Avatars">
						<AvatarsDemo />
					</DemoSection>
					<DemoSection id="elements-badges" title="Elements / Badges">
						<BadgesDemo />
					</DemoSection>
					<DemoSection id="elements-buttons" title="Elements / Buttons">
						<ButtonsDemo />
					</DemoSection>
					<DemoSection id="elements-button-groups" title="Elements / Button Groups">
						<ButtonGroupsDemo />
					</DemoSection>

					{/* Application UI - Headings */}
					<DemoSection id="headings-card-headings" title="Headings / Card Headings">
						<CardHeadingsDemo />
					</DemoSection>
					<DemoSection id="headings-page-headings" title="Headings / Page Headings">
						<PageHeadingsDemo />
					</DemoSection>
					<DemoSection id="headings-section-headings" title="Headings / Section Headings">
						<SectionHeadingsDemo />
					</DemoSection>

					{/* Application UI - Layout */}
					<DemoSection id="layout-cards" title="Layout / Cards">
						<CardsDemo />
					</DemoSection>
					<DemoSection id="layout-containers" title="Layout / Containers">
						<ContainersDemo />
					</DemoSection>
					<DemoSection id="layout-dividers" title="Layout / Dividers">
						<DividersDemo />
					</DemoSection>
					<DemoSection id="layout-list-containers" title="Layout / List Containers">
						<ListContainersDemo />
					</DemoSection>
					<DemoSection id="layout-media-objects" title="Layout / Media Objects">
						<MediaObjectsDemo />
					</DemoSection>

					{/* Application UI - Forms */}
					<DemoSection id="forms-form-layouts" title="Forms / Form Layouts">
						<FormLayoutsDemo />
					</DemoSection>
					<DemoSection id="forms-input-groups" title="Forms / Input Groups">
						<InputGroupsDemo />
					</DemoSection>
					<DemoSection id="forms-radio-groups" title="Forms / Radio Groups">
						<RadioGroupsDemo />
					</DemoSection>
					<DemoSection id="forms-select-menus" title="Forms / Select Menus">
						<SelectMenusDemo />
					</DemoSection>
					<DemoSection id="forms-action-panels" title="Forms / Action Panels">
						<ActionPanelsDemo />
					</DemoSection>
					<DemoSection id="forms-checkboxes" title="Forms / Checkboxes">
						<CheckboxesDemo />
					</DemoSection>
					<DemoSection id="forms-sign-in-forms" title="Forms / Sign-in Forms">
						<SignInFormsDemo />
					</DemoSection>
					<DemoSection id="forms-textareas" title="Forms / Textareas">
						<TextareasDemo />
					</DemoSection>
					<DemoSection id="forms-toggles" title="Forms / Toggles">
						<TogglesDemo />
					</DemoSection>

					{/* Application UI - Application Shells */}
					<DemoSection
						id="application-shells-multi-column"
						title="Multi-column (Application Shell)"
					>
						<MultiColumnDemo />
					</DemoSection>
					<DemoSection
						id="application-shells-multi-column-shells"
						title="Multi-column Shells (Headless+Icon)"
					>
						<MultiColumnShellsDemo />
					</DemoSection>
					<DemoSection id="application-shells-sidebar" title="Sidebar Shells (Headless+Icon)">
						<SidebarShellsDemo />
					</DemoSection>
					<DemoSection id="application-shells-stacked" title="Stacked Shells (Headless+Icon)">
						<StackedShellsDemo />
					</DemoSection>

					{/* Application UI - Forms / Comboboxes */}
					<DemoSection id="forms-comboboxes" title="Comboboxes (Headless+Icon)">
						<ComboboxesDemo />
					</DemoSection>
					<DemoSection id="forms-select-menus-headless" title="Custom Select Menus (Headless+Icon)">
						<CustomSelectMenusDemo />
					</DemoSection>

					{/* Application UI - Elements / Dropdowns */}
					<DemoSection id="elements-dropdowns" title="Dropdowns (Headless+Icon)">
						<DropdownsDemo />
					</DemoSection>

					{/* Application UI - Data Display */}
					<DemoSection id="data-display-calendars" title="Calendars (Data Display)">
						<CalendarsDemo />
					</DemoSection>
					<DemoSection id="data-display-calendars-headless" title="Calendars (Headless+Icon)">
						<CalendarsHeadlessDemo />
					</DemoSection>
					<DemoSection id="data-display-description-lists" title="Description Lists (Data Display)">
						<DescriptionListsDemo />
					</DemoSection>
				</main>
			</div>
		</div>
	);
}
