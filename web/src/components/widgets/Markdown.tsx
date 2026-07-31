import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Tooltip, message as antdMessage } from "antd";
import { CopyOutlined, CheckOutlined } from "@ant-design/icons";

/**
 * Markdown renderer for assistant messages.
 *
 * - GitHub-flavored Markdown via `remark-gfm` (tables, task lists, strikethrough)
 * - Code highlighting via `rehype-highlight` (highlight.js, static)
 * - Each fenced code block gets a copy button in the top-right corner.
 *
 * User messages intentionally stay plain text (`white-space: pre-wrap`),
 * rendered directly in Chat.tsx rather than through this component.
 */
export const Markdown = memo(function Markdown({ content }: { content: string }) {
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          // Code blocks: ```lang\n...``` → <pre><code class="language-lang hljs">
          // Inline code: `x` → <code>
          pre({ children }) {
            return <CodeBlock>{children}</CodeBlock>;
          },
          code({ className, children, ...props }) {
            // Inline code (no language- class) — render as-is.
            const isInline = !className?.includes("language-");
            if (isInline) {
              return (
                <code className="md-inline-code" {...props}>
                  {children}
                </code>
              );
            }
            // Block code is wrapped by <pre> above; just forward.
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          a({ children, ...props }) {
            return (
              <a {...props} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

/**
 * Code block wrapper with a copy button.
 * Extracts the raw text from the nested <code> child for copying.
 */
function CodeBlock({ children }: { children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const text = extractText(children);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      antdMessage.success({ content: "已复制", duration: 1.2 });
      setTimeout(() => setCopied(false), 1500);
    } catch {
      antdMessage.error("复制失败");
    }
  };

  return (
    <pre className="md-pre">
      <button
        className="md-copy-btn"
        onClick={handleCopy}
        aria-label="复制代码"
        type="button"
      >
        <Tooltip title={copied ? "已复制" : "复制"}>
          {copied ? <CheckOutlined /> : <CopyOutlined />}
        </Tooltip>
      </button>
      {children}
    </pre>
  );
}

/** Recursively pull text content out of React children for clipboard copy. */
function extractText(node: React.ReactNode): string {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in (node as any)) {
    return extractText((node as any).props?.children);
  }
  return "";
}
