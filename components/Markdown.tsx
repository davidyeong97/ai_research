import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const SAFE_URL = /^(https?:|mailto:)/i;

/** Allow only http(s) and mailto links; everything else is stripped. */
export function safeUrlTransform(url: string): string {
  return SAFE_URL.test(url.trim()) ? url : "";
}

const components: Components = {
  a: ({ href, children }) => (
    <a
      href={href || undefined}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="text-sky-300 underline break-words hover:text-amber-300"
    >
      {children}
    </a>
  ),
  pre: ({ children }) => (
    <pre className="my-2 max-w-full overflow-x-auto border-2 border-indigo-400/60 bg-black/60 p-2 font-mono text-xs text-emerald-200">
      {children}
    </pre>
  ),
  code: ({ className, children }) => (
    <code className={`font-mono ${className ?? ""} [:not(pre)>&]:bg-black/40 [:not(pre)>&]:px-1`}>
      {children}
    </code>
  ),
  table: ({ children }) => (
    <div className="my-2 max-w-full overflow-x-auto">
      <table className="min-w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-indigo-400/50 bg-indigo-900/60 px-2 py-1 text-left">{children}</th>
  ),
  td: ({ children }) => <td className="border border-indigo-400/40 px-2 py-1">{children}</td>,
  h1: ({ children }) => (
    <h3 className="mt-2 mb-1 text-base font-bold text-amber-300">{children}</h3>
  ),
  h2: ({ children }) => <h4 className="mt-2 mb-1 text-sm font-bold text-amber-300">{children}</h4>,
  h3: ({ children }) => <h5 className="mt-2 mb-1 text-sm font-bold text-amber-200">{children}</h5>,
  ul: ({ children }) => <ul className="my-1 list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-decimal pl-5">{children}</ol>,
  p: ({ children }) => <p className="my-1">{children}</p>,
  blockquote: ({ children }) => (
    <blockquote className="my-1 border-l-4 border-amber-300/60 pl-2 text-indigo-200">
      {children}
    </blockquote>
  ),
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className="break-words" data-testid="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={safeUrlTransform}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
