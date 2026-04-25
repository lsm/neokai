/**
 * Standalone entry point for the minimal-thread style exploration page.
 *
 * Open `/dev-minimal-thread.html` while the dev server is running (e.g.
 * `bun run --filter @neokai/web dev`) to view all 6 styles side-by-side.
 *
 * Not part of the main app bundle — lives outside `App.tsx` and the router.
 */

import './styles.css';
import { render } from 'preact';
import { MinimalStyleExploration } from './components/space/thread/minimal/MinimalStyleExploration.tsx';

// styles.css locks html/body to viewport height with overflow:hidden for the
// main single-screen app.  This exploration page needs natural scrolling,
// so we reset those constraints before mounting.
const reset = document.createElement('style');
reset.id = 'minimal-exploration-reset';
reset.textContent = `
html, body { overflow: auto !important; height: auto !important; min-height: 0 !important; }
#root { overflow: auto !important; height: auto !important; }
`;
document.head.appendChild(reset);

const root = document.getElementById('root');
if (!root) {
	throw new Error('Root element not found');
}

render(<MinimalStyleExploration />, root);

if (import.meta.hot) {
	import.meta.hot.accept(() => {
		render(<MinimalStyleExploration />, root);
	});
}
