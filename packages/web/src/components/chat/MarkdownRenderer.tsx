import { useEffect, useRef, useMemo } from 'preact/hooks';
import { marked } from 'marked';
import hljs from 'highlight.js';

interface MarkdownRendererProps {
	content: string;
	class?: string;
}

// Configure marked once at module level
marked.setOptions({
	breaks: true,
	gfm: true,
});

export default function MarkdownRenderer({ content, class: className }: MarkdownRendererProps) {
	const containerRef = useRef<HTMLDivElement>(null);

	// Memoize markdown parsing - only re-parse when content changes
	const html = useMemo(() => {
		return marked.parse(content) as string;
	}, [content]);

	useEffect(() => {
		if (containerRef.current) {
			// Set innerHTML only when html changes
			containerRef.current.innerHTML = html;

			// Apply syntax highlighting to code blocks
			const codeBlocks = containerRef.current.querySelectorAll('pre code');
			codeBlocks.forEach((block) => {
				hljs.highlightElement(block as HTMLElement);
			});

			// Remove top margin from first paragraph and bottom margin from last paragraph
			const paragraphs = containerRef.current.querySelectorAll('p');
			if (paragraphs.length > 0) {
				const firstP = paragraphs[0] as HTMLElement;
				const lastP = paragraphs[paragraphs.length - 1] as HTMLElement;
				firstP.style.marginTop = '0';
				lastP.style.marginBottom = '0';
			}
		}
	}, [html]);

	return <div ref={containerRef} class={`prose ${className || ''}`} />;
}
