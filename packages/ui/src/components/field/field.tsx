import { createContext, createElement } from 'preact';
import { useCallback, useContext, useEffect, useState } from 'preact/hooks';
import { render } from '../../internal/render.ts';
import type { ElementType } from '../../internal/types.ts';
import { useId } from '../../internal/use-id.ts';

// --- FieldsetContext ---

interface FieldsetContextValue {
	disabled: boolean;
}

const FieldsetContext = createContext<FieldsetContextValue | null>(null);
FieldsetContext.displayName = 'FieldsetContext';

// --- FieldContext ---

interface FieldContextValue {
	disabled: boolean;
	labelId: string | null;
	setLabelId: (id: string | null) => void;
	descriptionId: string | null;
	setDescriptionId: (id: string | null) => void;
	controlId: string | null;
	setControlId: (id: string | null) => void;
}

const FieldContext = createContext<FieldContextValue | null>(null);
FieldContext.displayName = 'FieldContext';

export function useFieldContext(): FieldContextValue | null {
	return useContext(FieldContext);
}

export function useFieldsetContext(): FieldsetContextValue | null {
	return useContext(FieldsetContext);
}

// --- Fieldset ---

interface FieldsetProps {
	as?: ElementType;
	disabled?: boolean;
	children?: unknown;
	[key: string]: unknown;
}

function FieldsetFn({ as: Tag = 'fieldset', disabled = false, children, ...rest }: FieldsetProps) {
	const parentFieldset = useContext(FieldsetContext);
	const isDisabled = disabled || (parentFieldset?.disabled ?? false);

	const ctx: FieldsetContextValue = { disabled: isDisabled };

	const slot = { disabled: isDisabled };

	const ourProps: Record<string, unknown> = {
		disabled: isDisabled || undefined,
	};

	return createElement(
		FieldsetContext.Provider,
		{ value: ctx },
		render({
			ourProps,
			theirProps: { as: Tag, children, ...rest },
			slot,
			defaultTag: 'fieldset',
			name: 'Fieldset',
		})
	);
}

FieldsetFn.displayName = 'Fieldset';
export const Fieldset = FieldsetFn;

// --- Field ---

interface FieldProps {
	as?: ElementType;
	disabled?: boolean;
	children?: unknown;
	[key: string]: unknown;
}

function FieldFn({ as: Tag = 'div', disabled = false, children, ...rest }: FieldProps) {
	const fieldsetCtx = useContext(FieldsetContext);
	const isDisabled = disabled || (fieldsetCtx?.disabled ?? false);

	const [labelId, setLabelId] = useState<string | null>(null);
	const [descriptionId, setDescriptionId] = useState<string | null>(null);
	const [controlId, setControlId] = useState<string | null>(null);

	const stableLabelId = useCallback((id: string | null) => setLabelId(id), []);
	const stableDescriptionId = useCallback((id: string | null) => setDescriptionId(id), []);
	const stableControlId = useCallback((id: string | null) => setControlId(id), []);

	const ctx: FieldContextValue = {
		disabled: isDisabled,
		labelId,
		setLabelId: stableLabelId,
		descriptionId,
		setDescriptionId: stableDescriptionId,
		controlId,
		setControlId: stableControlId,
	};

	const slot = { disabled: isDisabled };

	const ourProps: Record<string, unknown> = {};

	return createElement(
		FieldContext.Provider,
		{ value: ctx },
		render({
			ourProps,
			theirProps: { as: Tag, children, ...rest },
			slot,
			defaultTag: 'div',
			name: 'Field',
		})
	);
}

FieldFn.displayName = 'Field';
export const Field = FieldFn;

// --- Legend ---

interface LegendProps {
	as?: ElementType;
	children?: unknown;
	[key: string]: unknown;
}

function LegendFn({ as: Tag = 'legend', children, ...rest }: LegendProps) {
	return render({
		ourProps: {},
		theirProps: { as: Tag, children, ...rest },
		slot: {},
		defaultTag: 'legend',
		name: 'Legend',
	});
}

LegendFn.displayName = 'Legend';
export const Legend = LegendFn;

// --- Label ---

interface LabelProps {
	as?: ElementType;
	passive?: boolean;
	children?: unknown;
	[key: string]: unknown;
}

function LabelFn({ as: Tag = 'label', passive = false, children, ...rest }: LabelProps) {
	const fieldCtx = useContext(FieldContext);
	const fieldsetCtx = useContext(FieldsetContext);

	const isDisabled = fieldCtx?.disabled ?? fieldsetCtx?.disabled ?? false;

	const id = useId();

	useEffect(() => {
		if (!fieldCtx) return;
		fieldCtx.setLabelId(id);
		return () => {
			fieldCtx.setLabelId(null);
		};
	}, [id, fieldCtx]);

	const handleClick = useCallback(
		(e: MouseEvent) => {
			if (passive) {
				e.preventDefault();
				return;
			}
			if (fieldCtx?.controlId) {
				const el = document.getElementById(fieldCtx.controlId);
				if (el) {
					el.focus();
				}
			}
		},
		[passive, fieldCtx]
	);

	const slot = { disabled: isDisabled };

	const ourProps: Record<string, unknown> = {
		id,
		htmlFor: !passive && fieldCtx?.controlId ? fieldCtx.controlId : undefined,
		onClick: handleClick,
	};

	return render({
		ourProps,
		theirProps: { as: Tag, children, ...rest },
		slot,
		defaultTag: 'label',
		name: 'Label',
	});
}

LabelFn.displayName = 'Label';
export const Label = LabelFn;

// --- Description ---

interface DescriptionProps {
	as?: ElementType;
	children?: unknown;
	[key: string]: unknown;
}

function DescriptionFn({ as: Tag = 'p', children, ...rest }: DescriptionProps) {
	const fieldCtx = useContext(FieldContext);
	const fieldsetCtx = useContext(FieldsetContext);

	const isDisabled = fieldCtx?.disabled ?? fieldsetCtx?.disabled ?? false;

	const id = useId();

	useEffect(() => {
		if (!fieldCtx) return;
		fieldCtx.setDescriptionId(id);
		return () => {
			fieldCtx.setDescriptionId(null);
		};
	}, [id, fieldCtx]);

	const slot = { disabled: isDisabled };

	const ourProps: Record<string, unknown> = {
		id,
	};

	return render({
		ourProps,
		theirProps: { as: Tag, children, ...rest },
		slot,
		defaultTag: 'p',
		name: 'Description',
	});
}

DescriptionFn.displayName = 'Description';
export const Description = DescriptionFn;
