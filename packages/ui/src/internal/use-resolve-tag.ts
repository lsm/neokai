import type { ElementType } from './types.ts';

export function useResolveTag<TTag extends ElementType>(
	as: TTag | undefined,
	defaultTag: ElementType
): ElementType {
	return as ?? defaultTag;
}
