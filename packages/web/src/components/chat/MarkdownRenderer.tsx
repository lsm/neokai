import { useEffect, useRef } from 'preact/hooks';
import { marked } from 'marked';
import hljs from 'highlight.js';

interface MarkdownRendererProps {
	content: string;
	class?: string;
}

export default function MarkdownRenderer({ content, class: className }: MarkdownRendererProps) {
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (containerRef.current) {
			// Configure marked
			marked.setOptions({
				breaks: true,
				gfm: true,
			});

			// Render markdown
			const html = marked.parse(content) as string;
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
	}, [content]);

	return <div ref={containerRef} class={`prose ${className || ''}`} />;
}
