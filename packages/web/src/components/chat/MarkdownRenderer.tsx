import { useEffect, useRef } from "preact/hooks";
import { marked } from "marked";
import hljs from "highlight.js";

interface MarkdownRendererProps {
  content: string;
  class?: string;
}

export default function MarkdownRenderer({
  content,
  class: className,
}: MarkdownRendererProps) {
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
      const codeBlocks = containerRef.current.querySelectorAll("pre code");
      codeBlocks.forEach((block) => {
        hljs.highlightElement(block as HTMLElement);
      });
    }
  }, [content]);

  return <div ref={containerRef} class={`prose ${className || ""}`} />;
}
