import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

// Token-styled markdown — no Tailwind typography plugin. Loosely-typed component overrides
// (react-markdown passes extra props we ignore) cast to Components.
const components = {
  p: (p: any) => <p className="my-2 leading-relaxed first:mt-0 last:mb-0">{p.children}</p>,
  ul: (p: any) => <ul className="my-2 list-disc space-y-1 pl-5">{p.children}</ul>,
  ol: (p: any) => <ol className="my-2 list-decimal space-y-1 pl-5">{p.children}</ol>,
  li: (p: any) => <li className="marker:text-muted-foreground">{p.children}</li>,
  a: (p: any) => (
    <a
      href={p.href}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-foreground underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground"
    >
      {p.children}
    </a>
  ),
  strong: (p: any) => <strong className="font-semibold text-foreground">{p.children}</strong>,
  h1: (p: any) => <h3 className="mb-1.5 mt-4 text-lg font-semibold tracking-tight first:mt-0">{p.children}</h3>,
  h2: (p: any) => <h3 className="mb-1.5 mt-4 text-base font-semibold tracking-tight first:mt-0">{p.children}</h3>,
  h3: (p: any) => <h4 className="mb-1 mt-3 text-[15px] font-semibold first:mt-0">{p.children}</h4>,
  code: (p: any) =>
    p.className ? (
      <code className={p.className}>{p.children}</code>
    ) : (
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[13px] text-foreground">{p.children}</code>
    ),
  pre: (p: any) => (
    <pre className="my-2.5 overflow-x-auto rounded-lg border bg-muted p-3 font-mono text-[13px] leading-relaxed text-foreground">
      {p.children}
    </pre>
  ),
  blockquote: (p: any) => (
    <blockquote className="my-2 border-l-2 pl-3 text-muted-foreground">{p.children}</blockquote>
  ),
  hr: () => <hr className="my-3" />,
  table: (p: any) => (
    <div className="my-2.5 overflow-x-auto rounded-lg border">
      <table className="w-full border-collapse text-[13px]">{p.children}</table>
    </div>
  ),
  th: (p: any) => (
    <th className="border-b bg-muted px-2.5 py-1.5 text-left font-medium text-foreground">{p.children}</th>
  ),
  td: (p: any) => <td className="border-b px-2.5 py-1.5 align-top">{p.children}</td>,
} as Components;

export function Markdown({ children }: { children: string }) {
  return (
    <div className="text-[15px] leading-relaxed text-foreground">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
