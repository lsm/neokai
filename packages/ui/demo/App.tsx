import { useState, useEffect } from 'preact/hooks';
import type { ComponentType } from 'preact';
import { Sun, Moon } from 'lucide-preact';
import { Sidebar } from './Sidebar.tsx';

// ─── Headless component demos ─────────────────────────────────────────────────
import { ButtonDemo } from './sections/ButtonDemo.tsx';
import { IconButtonDemo } from './sections/IconButtonDemo.tsx';
import { CheckboxDemo } from './sections/CheckboxDemo.tsx';
import { SwitchDemo } from './sections/SwitchDemo.tsx';
import { RadioGroupDemo } from './sections/RadioGroupDemo.tsx';
import { InputDemo } from './sections/InputDemo.tsx';
import { FieldDemo } from './sections/FieldDemo.tsx';
import { DialogDemo } from './sections/DialogDemo.tsx';
import { CommandPaletteDemo } from './sections/CommandPaletteDemo.tsx';
import { DrawerDemo } from './sections/DrawerDemo.tsx';
import { MenuDemo } from './sections/MenuDemo.tsx';
import { DisclosureDemo } from './sections/DisclosureDemo.tsx';
import { PopoverDemo } from './sections/PopoverDemo.tsx';
import { TooltipDemo } from './sections/TooltipDemo.tsx';
import { ToastDemo } from './sections/ToastDemo.tsx';
import { NotificationDemo } from './sections/NotificationDemo.tsx';
import { TabsDemo } from './sections/TabsDemo.tsx';
import { ListboxDemo } from './sections/ListboxDemo.tsx';
import { ComboboxDemo } from './sections/ComboboxDemo.tsx';
import { TransitionDemo } from './sections/TransitionDemo.tsx';
import { SpinnerDemo } from './sections/SpinnerDemo.tsx';
import { SkeletonDemo } from './sections/SkeletonDemo.tsx';

// ─── Application UI demos — Application Shells ───────────────────────────────
import { MultiColumnDemo } from './sections/MultiColumnDemo.tsx';
import { MultiColumnShellsDemo } from './sections/application-shells/multi-column/MultiColumnShellsDemo.tsx';
import { SidebarShellsDemo } from './sections/application-shells/sidebar/SidebarShellsDemo.tsx';
import { StackedShellsDemo } from './sections/application-shells/stacked/StackedShellsDemo.tsx';

// ─── Application UI demos — Data Display ─────────────────────────────────────
import { StatsDemo } from './sections/StatsDemo.tsx';
import { CalendarsDemo } from './sections/CalendarsDemo.tsx';
import { CalendarsHeadlessDemo } from './sections/data-display/calendars/CalendarsHeadlessDemo.tsx';
import { DescriptionListsDemo } from './sections/DescriptionListsDemo.tsx';

// ─── Application UI demos — Elements ─────────────────────────────────────────
import { AvatarsDemo } from './sections/elements/avatars/AvatarsDemo.tsx';
import { BadgesDemo } from './sections/elements/badges/BadgesDemo.tsx';
import { ButtonsDemo } from './sections/elements/buttons/ButtonsDemo.tsx';
import { ButtonGroupsDemo } from './sections/elements/button-groups/ButtonGroupsDemo.tsx';
import { DropdownsDemo } from './sections/elements/dropdowns/DropdownsDemo.tsx';

// ─── Application UI demos — Feedback ─────────────────────────────────────────
import { AlertsDemo } from './sections/feedback/alerts/AlertsDemo.tsx';
import { EmptyStatesDemo } from './sections/EmptyStatesDemo.tsx';

// ─── Application UI demos — Forms ────────────────────────────────────────────
import { FormLayoutsDemo } from './sections/forms/form-layouts/FormLayoutsDemo.tsx';
import { InputGroupsDemo } from './sections/forms/input-groups/InputGroupsDemo.tsx';
import { RadioGroupsDemo } from './sections/forms/radio-groups/RadioGroupsDemo.tsx';
import { SelectMenusDemo } from './sections/forms/select-menus/SelectMenusDemo.tsx';
import { CustomSelectMenusDemo } from './sections/forms/select-menus/CustomSelectMenusDemo.tsx';
import { ComboboxesDemo } from './sections/forms/comboboxes/ComboboxesDemo.tsx';
import { ActionPanelsDemo } from './sections/ActionPanelsDemo.tsx';
import { CheckboxesDemo } from './sections/CheckboxesDemo.tsx';
import { SignInFormsDemo } from './sections/SignInFormsDemo.tsx';
import { TextareasDemo } from './sections/TextareasDemo.tsx';
import { TogglesDemo } from './sections/TogglesDemo.tsx';

// ─── Application UI demos — Headings ─────────────────────────────────────────
import { CardHeadingsDemo } from './sections/headings/card-headings/CardHeadingsDemo.tsx';
import { PageHeadingsDemo } from './sections/headings/page-headings/PageHeadingsDemo.tsx';
import { SectionHeadingsDemo } from './sections/headings/section-headings/SectionHeadingsDemo.tsx';

// ─── Application UI demos — Layout ───────────────────────────────────────────
import { CardsDemo } from './sections/layout/cards/CardsDemo.tsx';
import { ContainersDemo } from './sections/layout/containers/ContainersDemo.tsx';
import { DividersDemo } from './sections/layout/dividers/DividersDemo.tsx';
import { ListContainersDemo } from './sections/layout/list-containers/ListContainersDemo.tsx';
import { MediaObjectsDemo } from './sections/layout/media-objects/MediaObjectsDemo.tsx';

// ─── Application UI demos — Lists ────────────────────────────────────────────
import { FeedsDemo } from './sections/FeedsDemo.tsx';
import { GridListsDemo } from './sections/GridListsDemo.tsx';
import { StackedListsDemo } from './sections/StackedListsDemo.tsx';
import { TablesDemo } from './sections/TablesDemo.tsx';

// ─── Application UI demos — Navigation ───────────────────────────────────────
import { BreadcrumbsDemo } from './sections/BreadcrumbsDemo.tsx';
import { CommandPalettesDemo } from './sections/navigation/CommandPalettesDemo.tsx';
import { NavbarsDemo } from './sections/navigation/NavbarsDemo.tsx';
import { PaginationDemo } from './sections/PaginationDemo.tsx';
import { ProgressBarsDemo } from './sections/ProgressBarsDemo.tsx';
import { SidebarNavigationDemo } from './sections/SidebarNavigationDemo.tsx';
import { VerticalNavigationDemo } from './sections/VerticalNavigationDemo.tsx';

// ─── Application UI demos — Overlays ─────────────────────────────────────────
import { DrawersDemo } from './sections/overlays/DrawersDemo.tsx';
import { ModalDialogsDemo } from './sections/overlays/ModalDialogsDemo.tsx';

// ─── Application UI demos — Page Examples ────────────────────────────────────
import { DetailScreensDemo } from './sections/DetailScreensDemo.tsx';
import { HomeScreensDemo } from './sections/HomeScreensDemo.tsx';
import { SettingsScreensDemo } from './sections/SettingsScreensDemo.tsx';

// ─── Section registry ─────────────────────────────────────────────────────────

interface SectionDef {
	id: string;
	title: string;
	Component: ComponentType;
}

const sections: SectionDef[] = [
	// Headless Components
	{ id: 'hc-button', title: 'Button', Component: ButtonDemo },
	{ id: 'hc-icon-button', title: 'IconButton', Component: IconButtonDemo },
	{ id: 'hc-checkbox', title: 'Checkbox', Component: CheckboxDemo },
	{ id: 'hc-switch', title: 'Switch', Component: SwitchDemo },
	{ id: 'hc-radio-group', title: 'RadioGroup', Component: RadioGroupDemo },
	{ id: 'hc-input', title: 'Input', Component: InputDemo },
	{ id: 'hc-field', title: 'Field', Component: FieldDemo },
	{ id: 'hc-dialog', title: 'Dialog', Component: DialogDemo },
	{
		id: 'hc-command-palette',
		title: 'Command Palette (Dialog + Combobox)',
		Component: CommandPaletteDemo,
	},
	{ id: 'hc-drawer', title: 'Drawer', Component: DrawerDemo },
	{ id: 'hc-menu', title: 'Menu', Component: MenuDemo },
	{ id: 'hc-disclosure', title: 'Disclosure', Component: DisclosureDemo },
	{ id: 'hc-popover', title: 'Popover', Component: PopoverDemo },
	{ id: 'hc-tooltip', title: 'Tooltip', Component: TooltipDemo },
	{ id: 'hc-toast', title: 'Toast', Component: ToastDemo },
	{
		id: 'hc-notification',
		title: 'Notification (Toast Variants)',
		Component: NotificationDemo,
	},
	{ id: 'hc-tabs', title: 'Tabs', Component: TabsDemo },
	{ id: 'hc-listbox', title: 'Listbox', Component: ListboxDemo },
	{ id: 'hc-combobox', title: 'Combobox', Component: ComboboxDemo },
	{ id: 'hc-transition', title: 'Transition', Component: TransitionDemo },
	{ id: 'hc-spinner', title: 'Spinner', Component: SpinnerDemo },
	{ id: 'hc-skeleton', title: 'Skeleton', Component: SkeletonDemo },

	// Application UI — Application Shells
	{
		id: 'ui-appshells-multi-column',
		title: 'Application Shells / Multi-column',
		Component: MultiColumnDemo,
	},
	{
		id: 'ui-appshells-multi-column-shells',
		title: 'Application Shells / Multi-column (Headless)',
		Component: MultiColumnShellsDemo,
	},
	{
		id: 'ui-appshells-sidebar',
		title: 'Application Shells / Sidebar (Headless)',
		Component: SidebarShellsDemo,
	},
	{
		id: 'ui-appshells-stacked',
		title: 'Application Shells / Stacked (Headless)',
		Component: StackedShellsDemo,
	},

	// Application UI — Data Display
	{ id: 'ui-data-display-stats', title: 'Data Display / Stats', Component: StatsDemo },
	{ id: 'ui-data-display-calendars', title: 'Data Display / Calendars', Component: CalendarsDemo },
	{
		id: 'ui-data-display-calendars-hl',
		title: 'Data Display / Calendars (Headless)',
		Component: CalendarsHeadlessDemo,
	},
	{
		id: 'ui-data-display-description-lists',
		title: 'Data Display / Description Lists',
		Component: DescriptionListsDemo,
	},

	// Application UI — Elements
	{ id: 'ui-elements-avatars', title: 'Elements / Avatars', Component: AvatarsDemo },
	{ id: 'ui-elements-badges', title: 'Elements / Badges', Component: BadgesDemo },
	{ id: 'ui-elements-buttons', title: 'Elements / Buttons', Component: ButtonsDemo },
	{
		id: 'ui-elements-button-groups',
		title: 'Elements / Button Groups',
		Component: ButtonGroupsDemo,
	},
	{ id: 'ui-elements-dropdowns', title: 'Elements / Dropdowns', Component: DropdownsDemo },

	// Application UI — Feedback
	{ id: 'ui-feedback-alerts', title: 'Feedback / Alerts', Component: AlertsDemo },
	{ id: 'ui-feedback-empty-states', title: 'Feedback / Empty States', Component: EmptyStatesDemo },

	// Application UI — Forms
	{ id: 'ui-forms-form-layouts', title: 'Forms / Form Layouts', Component: FormLayoutsDemo },
	{ id: 'ui-forms-input-groups', title: 'Forms / Input Groups', Component: InputGroupsDemo },
	{ id: 'ui-forms-radio-groups', title: 'Forms / Radio Groups', Component: RadioGroupsDemo },
	{ id: 'ui-forms-select-menus', title: 'Forms / Select Menus', Component: SelectMenusDemo },
	{
		id: 'ui-forms-select-menus-hl',
		title: 'Forms / Select Menus (Headless)',
		Component: CustomSelectMenusDemo,
	},
	{ id: 'ui-forms-comboboxes', title: 'Forms / Comboboxes', Component: ComboboxesDemo },
	{ id: 'ui-forms-action-panels', title: 'Forms / Action Panels', Component: ActionPanelsDemo },
	{ id: 'ui-forms-checkboxes', title: 'Forms / Checkboxes', Component: CheckboxesDemo },
	{ id: 'ui-forms-sign-in-forms', title: 'Forms / Sign-in Forms', Component: SignInFormsDemo },
	{ id: 'ui-forms-textareas', title: 'Forms / Textareas', Component: TextareasDemo },
	{ id: 'ui-forms-toggles', title: 'Forms / Toggles', Component: TogglesDemo },

	// Application UI — Headings
	{
		id: 'ui-headings-card-headings',
		title: 'Headings / Card Headings',
		Component: CardHeadingsDemo,
	},
	{
		id: 'ui-headings-page-headings',
		title: 'Headings / Page Headings',
		Component: PageHeadingsDemo,
	},
	{
		id: 'ui-headings-section-headings',
		title: 'Headings / Section Headings',
		Component: SectionHeadingsDemo,
	},

	// Application UI — Layout
	{ id: 'ui-layout-cards', title: 'Layout / Cards', Component: CardsDemo },
	{ id: 'ui-layout-containers', title: 'Layout / Containers', Component: ContainersDemo },
	{ id: 'ui-layout-dividers', title: 'Layout / Dividers', Component: DividersDemo },
	{
		id: 'ui-layout-list-containers',
		title: 'Layout / List Containers',
		Component: ListContainersDemo,
	},
	{
		id: 'ui-layout-media-objects',
		title: 'Layout / Media Objects',
		Component: MediaObjectsDemo,
	},

	// Application UI — Lists
	{ id: 'ui-lists-feeds', title: 'Lists / Feeds', Component: FeedsDemo },
	{ id: 'ui-lists-grid-lists', title: 'Lists / Grid Lists', Component: GridListsDemo },
	{ id: 'ui-lists-stacked-lists', title: 'Lists / Stacked Lists', Component: StackedListsDemo },
	{ id: 'ui-lists-tables', title: 'Lists / Tables', Component: TablesDemo },

	// Application UI — Navigation
	{ id: 'ui-nav-breadcrumbs', title: 'Navigation / Breadcrumbs', Component: BreadcrumbsDemo },
	{
		id: 'ui-nav-command-palettes',
		title: 'Navigation / Command Palettes',
		Component: CommandPalettesDemo,
	},
	{ id: 'ui-nav-navbars', title: 'Navigation / Navbars', Component: NavbarsDemo },
	{ id: 'ui-nav-pagination', title: 'Navigation / Pagination', Component: PaginationDemo },
	{
		id: 'ui-nav-progress-bars',
		title: 'Navigation / Progress Bars',
		Component: ProgressBarsDemo,
	},
	{
		id: 'ui-nav-sidebar-navigation',
		title: 'Navigation / Sidebar Navigation',
		Component: SidebarNavigationDemo,
	},
	{
		id: 'ui-nav-vertical-navigation',
		title: 'Navigation / Vertical Navigation',
		Component: VerticalNavigationDemo,
	},

	// Application UI — Overlays
	{ id: 'ui-overlays-drawers', title: 'Overlays / Drawers', Component: DrawersDemo },
	{
		id: 'ui-overlays-modal-dialogs',
		title: 'Overlays / Modal Dialogs',
		Component: ModalDialogsDemo,
	},
	{
		id: 'ui-overlays-notifications',
		title: 'Overlays / Notifications',
		Component: NotificationDemo,
	},

	// Application UI — Page Examples
	{
		id: 'ui-pages-detail-screens',
		title: 'Page Examples / Detail Screens',
		Component: DetailScreensDemo,
	},
	{
		id: 'ui-pages-home-screens',
		title: 'Page Examples / Home Screens',
		Component: HomeScreensDemo,
	},
	{
		id: 'ui-pages-settings-screens',
		title: 'Page Examples / Settings Screens',
		Component: SettingsScreensDemo,
	},
];

// ─── App ──────────────────────────────────────────────────────────────────────

export function App() {
	const [theme, setTheme] = useState<'dark' | 'light'>('dark');
	const [activeSection, setActiveSection] = useState<string>('');
	const [searchQuery, setSearchQuery] = useState<string>('');

	function toggleTheme() {
		const next = theme === 'dark' ? 'light' : 'dark';
		setTheme(next);
		if (next === 'dark') {
			document.documentElement.classList.add('dark');
		} else {
			document.documentElement.classList.remove('dark');
		}
	}

	// Scroll-spy: track which section is most visible
	useEffect(() => {
		const visibleSections = new Map<string, number>();

		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						visibleSections.set(entry.target.id, entry.intersectionRatio);
					} else {
						visibleSections.delete(entry.target.id);
					}
				}

				let bestId = '';
				let bestRatio = 0;
				for (const [id, ratio] of visibleSections) {
					if (ratio > bestRatio) {
						bestRatio = ratio;
						bestId = id;
					}
				}
				setActiveSection(bestId);
			},
			{ rootMargin: '-20% 0px -70% 0px', threshold: [0, 0.1, 0.5, 1.0] }
		);

		const sectionEls = document.querySelectorAll('section[id]');
		for (const el of sectionEls) observer.observe(el);

		return () => observer.disconnect();
	}, []);

	return (
		<div class="min-h-screen bg-surface-0 text-text-primary">
			<Sidebar
				activeSection={activeSection}
				searchQuery={searchQuery}
				setSearchQuery={setSearchQuery}
			/>

			<div class="ml-64">
				{/* Header */}
				<header class="px-8 pt-10 pb-4 border-b border-surface-border flex items-start justify-between">
					<div>
						<h1 class="text-3xl font-bold text-text-primary">
							@neokai/ui — Component Library & Application UI Reference
						</h1>
						<p class="mt-2 text-text-tertiary">
							364+ Tailwind Application UI examples · headless primitives · design tokens
						</p>
					</div>
					<div class="flex items-center gap-2 mt-2">
						<a
							href="https://github.com/lsm/neokai"
							target="_blank"
							rel="noopener noreferrer"
							class="py-2 px-3 rounded-lg border border-surface-border text-text-tertiary hover:text-text-primary hover:bg-surface-2 transition-colors text-sm"
						>
							GitHub
						</a>
						<button
							type="button"
							onClick={toggleTheme}
							title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
							class="p-2 rounded-lg border border-surface-border text-text-tertiary hover:text-text-primary hover:bg-surface-2 transition-colors cursor-pointer"
						>
							{theme === 'dark' ? <Sun class="w-5 h-5" /> : <Moon class="w-5 h-5" />}
						</button>
					</div>
				</header>

				{/* Main content — all sections rendered from the registry */}
				<main class="px-8 max-w-6xl">
					{sections.map(({ id, title, Component }) => (
						<section key={id} id={id} class="py-12 border-b border-surface-border">
							<h2 class="text-2xl font-bold mb-6">{title}</h2>
							<Component />
						</section>
					))}
				</main>
			</div>
		</div>
	);
}
