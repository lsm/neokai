import type { RefObject } from 'preact';
import { useEffect, useState } from 'preact/hooks';

export function useOwnerDocument(ref: RefObject<HTMLElement | null>): Document | null {
	const [ownerDocument, setOwnerDocument] = useState<Document | null>(null);

	useEffect(() => {
		if (ref.current) {
			setOwnerDocument(ref.current.ownerDocument);
		}
	}, [ref]);

	return ownerDocument ?? (typeof document !== 'undefined' ? document : null);
}
