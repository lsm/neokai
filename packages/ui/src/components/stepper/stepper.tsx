import { createContext, createElement, type Ref } from 'preact';
import { forwardRef } from 'preact/compat';
import { useContext } from 'preact/hooks';
import { render } from '../../internal/render.ts';
import type { ElementType } from '../../internal/types.ts';
import { useId } from '../../internal/use-id.ts';

// --- Context types ---

type StepStatus = 'complete' | 'current' | 'upcoming';

interface StepperContextValue {
	currentStep: number;
	orientation: 'horizontal' | 'vertical';
}

const StepperContext = createContext<StepperContextValue | null>(null);
StepperContext.displayName = 'StepperContext';

function useStepperContext(component: string): StepperContextValue {
	const ctx = useContext(StepperContext);
	if (ctx === null) {
		throw new Error(`<${component}> must be used within a <Stepper>`);
	}
	return ctx;
}

// --- Stepper (container) ---

interface StepperProps {
	currentStep: number;
	orientation?: 'horizontal' | 'vertical';
	as?: ElementType;
	children?: unknown;
	[key: string]: unknown;
}

function StepperFn({
	currentStep,
	orientation = 'horizontal',
	as: Tag = 'div',
	children,
	...rest
}: StepperProps) {
	const ctx: StepperContextValue = {
		currentStep,
		orientation,
	};

	const slot = { orientation };

	const ourProps: Record<string, unknown> = {
		'data-orientation': orientation,
	};

	return createElement(
		StepperContext.Provider,
		{ value: ctx },
		render({
			ourProps,
			theirProps: { as: Tag, children, ...rest },
			slot,
			defaultTag: 'div',
			name: 'Stepper',
		})
	);
}

StepperFn.displayName = 'Stepper';
export const Stepper = forwardRef(StepperFn);

// --- StepperStep (individual step) ---

interface StepperStepProps {
	status: StepStatus;
	as?: ElementType;
	children?: unknown;
	[key: string]: unknown;
}

function StepperStepFn(
	{ status, as: Tag = 'div', children, ...rest }: StepperStepProps,
	ref: Ref<HTMLElement>
) {
	const { orientation } = useStepperContext('StepperStep');

	const ourProps: Record<string, unknown> = {
		ref,
		role: 'listitem',
		'aria-current': status === 'current' ? 'step' : undefined,
		'data-status': status,
	};

	const slot = { status, orientation };

	return render({
		ourProps,
		theirProps: { as: Tag, children, ...rest },
		slot,
		defaultTag: 'div',
		name: 'StepperStep',
	});
}

StepperStepFn.displayName = 'StepperStep';
export const StepperStep = forwardRef(StepperStepFn);

// --- StepperIcon (step indicator) ---

interface StepperIconProps {
	status: StepStatus;
	as?: ElementType;
	children?: unknown;
	[key: string]: unknown;
}

function StepperIconFn({ status, as: Tag = 'span', children, ...rest }: StepperIconProps) {
	const { currentStep } = useStepperContext('StepperIcon');

	const ourProps: Record<string, unknown> = {
		'aria-hidden': 'true',
	};

	const slot = { status };

	// Default icon content based on status
	const defaultContent =
		status === 'complete'
			? createElement(
					'svg',
					{
						xmlns: 'http://www.w3.org/2000/svg',
						viewBox: '0 0 20 20',
						fill: 'currentColor',
						className: 'stepper-icon-check',
					},
					createElement('path', {
						fillRule: 'evenodd',
						d: 'M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z',
						clipRule: 'evenodd',
					})
				)
			: String(currentStep + 1);

	return render({
		ourProps,
		theirProps: { as: Tag, children: children ?? defaultContent, ...rest },
		slot,
		defaultTag: 'span',
		name: 'StepperIcon',
	});
}

StepperIconFn.displayName = 'StepperIcon';
export const StepperIcon = StepperIconFn;

// --- StepperLabel (step label) ---

interface StepperLabelProps {
	as?: ElementType;
	children?: unknown;
	[key: string]: unknown;
}

function StepperLabelFn({ as: Tag = 'span', children, ...rest }: StepperLabelProps) {
	const slot = {};

	const ourProps: Record<string, unknown> = {};

	return render({
		ourProps,
		theirProps: { as: Tag, children, ...rest },
		slot,
		defaultTag: 'span',
		name: 'StepperLabel',
	});
}

StepperLabelFn.displayName = 'StepperLabel';
export const StepperLabel = StepperLabelFn;

// --- StepperDescription (optional description) ---

interface StepperDescriptionProps {
	as?: ElementType;
	children?: unknown;
	[key: string]: unknown;
}

function StepperDescriptionFn({ as: Tag = 'span', children, ...rest }: StepperDescriptionProps) {
	const id = useId();

	const ourProps: Record<string, unknown> = {
		id,
	};

	const slot = {};

	return render({
		ourProps,
		theirProps: { as: Tag, children, ...rest },
		slot,
		defaultTag: 'span',
		name: 'StepperDescription',
	});
}

StepperDescriptionFn.displayName = 'StepperDescription';
export const StepperDescription = StepperDescriptionFn;

// --- StepperSeparator (connector between steps) ---

interface StepperSeparatorProps {
	as?: ElementType;
	children?: unknown;
	[key: string]: unknown;
}

function StepperSeparatorFn({ as: Tag = 'div', children, ...rest }: StepperSeparatorProps) {
	const { orientation, currentStep } = useStepperContext('StepperSeparator');

	const ourProps: Record<string, unknown> = {
		'aria-hidden': 'true',
		'data-orientation': orientation,
		'data-status': currentStep === 0 ? 'upcoming' : currentStep > 0 ? 'complete' : 'upcoming',
	};

	const slot = { orientation };

	return render({
		ourProps,
		theirProps: { as: Tag, children, ...rest },
		slot,
		defaultTag: 'div',
		name: 'StepperSeparator',
	});
}

StepperSeparatorFn.displayName = 'StepperSeparator';
export const StepperSeparator = StepperSeparatorFn;
