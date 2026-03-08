interface IconProps {
	className?: string;
}

const defaults = {
	class: 'w-5 h-5',
	fill: 'none',
	viewBox: '0 0 24 24',
	stroke: 'currentColor',
} as const;

function svgProps(className?: string) {
	return { ...defaults, class: className ?? defaults.class };
}

const stroke = {
	'stroke-linecap': 'round' as const,
	'stroke-linejoin': 'round' as const,
	'stroke-width': 2,
};

/** Stylized AI/robot head outline — clean, minimal, monoline */
export function NeoKaiLogo({ className }: IconProps = {}) {
	return (
		<svg {...svgProps(className)}>
			<path
				{...stroke}
				d="M9 2v2M15 2v2M6 6h12a2 2 0 012 2v7a7 7 0 01-7 7h-2a7 7 0 01-7-7V8a2 2 0 012-2z"
			/>
			<circle cx="9.5" cy="12" r="1.5" fill="currentColor" stroke="none" />
			<circle cx="14.5" cy="12" r="1.5" fill="currentColor" stroke="none" />
			<path {...stroke} d="M9 17h6" />
		</svg>
	);
}

/** Chat bubble with dots */
export function ChatIcon({ className }: IconProps = {}) {
	return (
		<svg {...svgProps(className)}>
			<path
				{...stroke}
				d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
			/>
		</svg>
	);
}

/** Building icon for rooms */
export function RoomIcon({ className }: IconProps = {}) {
	return (
		<svg {...svgProps(className)}>
			<path
				{...stroke}
				d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
			/>
		</svg>
	);
}

/** Folder icon */
export function FolderIcon({ className }: IconProps = {}) {
	return (
		<svg {...svgProps(className)}>
			<path
				{...stroke}
				d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
			/>
		</svg>
	);
}

/** Gear/settings icon */
export function GearIcon({ className }: IconProps = {}) {
	return (
		<svg {...svgProps(className)}>
			<path
				{...stroke}
				d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
			/>
			<path {...stroke} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
		</svg>
	);
}

/** Warning triangle with exclamation */
export function WarningIcon({ className }: IconProps = {}) {
	return (
		<svg {...svgProps(className)}>
			<path
				{...stroke}
				d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
			/>
		</svg>
	);
}

/** Lightning bolt */
export function LightningIcon({ className }: IconProps = {}) {
	return (
		<svg {...svgProps(className)}>
			<path {...stroke} d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
		</svg>
	);
}

/** Brain outline */
export function BrainIcon({ className }: IconProps = {}) {
	return (
		<svg {...svgProps(className)}>
			<path
				{...stroke}
				d="M12 2a5 5 0 00-4.546 2.914A4.5 4.5 0 004 9.5a4.5 4.5 0 001.07 2.911A4.5 4.5 0 004 15.5a4.5 4.5 0 004 4.473V22h4v-2.027A4.5 4.5 0 0016 15.5a4.5 4.5 0 00-1.07-2.089A4.5 4.5 0 0016 9.5a4.5 4.5 0 00-3.454-4.586A5 5 0 0012 2z"
			/>
			<path {...stroke} d="M12 2v20" />
		</svg>
	);
}

/** Diamond/gem shape */
export function DiamondIcon({ className }: IconProps = {}) {
	return (
		<svg {...svgProps(className)}>
			<path {...stroke} d="M6 3h12l3 6-9 12L3 9l3-6z" />
			<path {...stroke} d="M3 9h18" />
			<path {...stroke} d="M12 21L9 9l3-6 3 6-3 12z" />
		</svg>
	);
}

/** Globe/earth */
export function GlobeIcon({ className }: IconProps = {}) {
	return (
		<svg {...svgProps(className)}>
			<circle {...stroke} cx="12" cy="12" r="10" />
			<path {...stroke} d="M2 12h20" />
			<path
				{...stroke}
				d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"
			/>
		</svg>
	);
}

/** Fire/flame */
export function FireIcon({ className }: IconProps = {}) {
	return (
		<svg {...svgProps(className)}>
			<path
				{...stroke}
				d="M12 22c4.418 0 8-3.134 8-7 0-3.866-4-7-4-11a4.007 4.007 0 00-4-2 4.007 4.007 0 00-4 2c0 4-4 7.134-4 11 0 3.866 3.582 7 8 7z"
			/>
			<path
				{...stroke}
				d="M12 22c-2.21 0-4-1.343-4-3 0-1.657 2-3 2-5 1 .5 2 2 2 2s1-1.5 2-2c0 2 2 3.343 2 5 0 1.657-1.79 3-4 3z"
			/>
		</svg>
	);
}

/** Clock */
export function ClockIcon({ className }: IconProps = {}) {
	return (
		<svg {...svgProps(className)}>
			<circle {...stroke} cx="12" cy="12" r="10" />
			<path {...stroke} d="M12 6v6l4 2" />
		</svg>
	);
}

/** Hourglass */
export function HourglassIcon({ className }: IconProps = {}) {
	return (
		<svg {...svgProps(className)}>
			<path
				{...stroke}
				d="M5 3h14M5 21h14M7 3v3a5 5 0 005 5 5 5 0 005-5V3M7 21v-3a5 5 0 015-5 5 5 0 015 5v3"
			/>
		</svg>
	);
}

/** Sparkle/star */
export function SparkleIcon({ className }: IconProps = {}) {
	return (
		<svg {...svgProps(className)}>
			<path
				{...stroke}
				d="M12 2l2.09 6.26L20 10l-5.91 1.74L12 18l-2.09-6.26L4 10l5.91-1.74L12 2z"
			/>
			<path {...stroke} d="M18 14l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3z" />
		</svg>
	);
}

/** Crystal ball / magic sphere */
export function CrystalBallIcon({ className }: IconProps = {}) {
	return (
		<svg {...svgProps(className)}>
			<circle {...stroke} cx="12" cy="11" r="8" />
			<path {...stroke} d="M7 19.5l-2 2.5h14l-2-2.5" />
			<path {...stroke} d="M8 8a5 5 0 014-2" />
		</svg>
	);
}

/** Pause symbol */
export function PauseIcon({ className }: IconProps = {}) {
	return (
		<svg {...svgProps(className)}>
			<path {...stroke} d="M10 4H6v16h4V4zM18 4h-4v16h4V4z" />
		</svg>
	);
}

/** Home icon */
export function HomeIcon({ className }: IconProps = {}) {
	return (
		<svg {...svgProps(className)}>
			<path
				{...stroke}
				d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
			/>
		</svg>
	);
}

/** Small chevron right (for breadcrumbs) */
export function ChevronRightIcon({ className }: IconProps = {}) {
	return (
		<svg {...svgProps(className)}>
			<path {...stroke} d="M9 5l7 7-7 7" />
		</svg>
	);
}

/** Plus sign */
export function PlusIcon({ className }: IconProps = {}) {
	return (
		<svg {...svgProps(className)}>
			<path {...stroke} d="M12 5v14M5 12h14" />
		</svg>
	);
}

/** Checkmark */
export function CheckIcon({ className }: IconProps = {}) {
	return (
		<svg {...svgProps(className)}>
			<path {...stroke} d="M5 13l4 4L19 7" />
		</svg>
	);
}

/** Maps model family strings to the appropriate icon component */
export interface ModelFamilyIconProps {
	family: string;
	className?: string;
}

const FAMILY_ICON_MAP: Record<string, (props: IconProps) => preact.JSX.Element> = {
	claude: BrainIcon,
	gemini: SparkleIcon,
	gpt: LightningIcon,
	glm: GlobeIcon,
	mistral: FireIcon,
	deepseek: CrystalBallIcon,
	default: DiamondIcon,
};

export function ModelFamilyIcon({ family, className }: ModelFamilyIconProps) {
	const Icon = FAMILY_ICON_MAP[family] ?? FAMILY_ICON_MAP.default;
	return <Icon className={className} />;
}
