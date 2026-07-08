import { useCallback, useEffect, useRef, useState } from 'react';
import { lazy, Suspense } from 'react';
import { toast } from 'sonner';
import { useAuth } from '../auth';
import { Badge, Button, Card, Skeleton } from '../ui';
import { apiErrorMessage } from '../lib/integrations';
import { BuildTag } from '../components/BuildTag';

// The force-graph canvas is a heavy dependency (d3-force + canvas rendering) — split it out of the
// main Knowledge chunk so the document list/upload UI stays fast even before the graph loads.
const ForceGraph2D = lazy(() => import('react-force-graph-2d'));

const ALLOWED_EXTENSIONS = ['.pdf', '.xlsx', '.xls', '.txt', '.md', '.csv'];
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';

interface KnowledgeDocument {
  id: string;
  filename: string;
  mime_type: string;
  byte_size: number;
  status: DocumentStatus;
  source_type: 'document' | 'chat';
  error_message: string | null;
  created_at: string;
}

interface KnowledgeUsage {
  bytes_used: number;
  byte_limit: number;
  graph_evicted_at: string | null;
}

interface GraphSnapshot {
  nodes: Array<{ id: string; caption: string; type?: string }>;
  edges: Array<{ source: string; target: string; label: string }>;
  rebuilding?: boolean;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function statusTone(status: DocumentStatus): 'success' | 'danger' | 'neutral' {
  if (status === 'ready') return 'success';
  if (status === 'failed') return 'danger';
  return 'neutral';
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // "data:<mime>;base64,<payload>" — keep only the payload.
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file.'));
    reader.readAsDataURL(file);
  });
}

export default function Knowledge() {
  const { api } = useAuth();
  const [documents, setDocuments] = useState<KnowledgeDocument[] | null>(null);
  const [usage, setUsage] = useState<KnowledgeUsage | null>(null);
  const [graph, setGraph] = useState<GraphSnapshot | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadDocuments = useCallback(async () => {
    const res = await api('/svc/v1/knowledge/documents');
    if (!res.ok) throw new Error(await apiErrorMessage(res, 'Could not load your knowledge base.'));
    const data = (await res.json()) as { documents: KnowledgeDocument[]; usage: KnowledgeUsage };
    setDocuments(data.documents);
    setUsage(data.usage);
  }, [api]);

  const loadGraph = useCallback(async () => {
    const res = await api('/svc/v1/knowledge/graph');
    if (!res.ok) return;
    setGraph((await res.json()) as GraphSnapshot);
  }, [api]);

  useEffect(() => {
    loadDocuments().catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
    loadGraph().catch(() => {});
  }, [loadDocuments, loadGraph]);

  // Any document still pending/processing → keep polling so status updates without a manual refresh.
  useEffect(() => {
    if (!documents?.some((d) => d.status === 'pending' || d.status === 'processing')) return;
    const t = window.setInterval(() => {
      loadDocuments().catch(() => {});
    }, 4000);
    return () => window.clearInterval(t);
  }, [documents, loadDocuments]);

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const ext = `.${file.name.split('.').pop()?.toLowerCase() ?? ''}`;
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      toast.error(`Unsupported file type. Supported: ${ALLOWED_EXTENSIONS.join(', ')}`);
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error('File is larger than the 10MB knowledge base limit.');
      return;
    }

    setUploading(true);
    try {
      const fileBase64 = await fileToBase64(file);
      const res = await api('/svc/v1/knowledge/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, mimeType: file.type || 'application/octet-stream', fileBase64 }),
      });
      if (!res.ok) throw new Error(await apiErrorMessage(res, 'Upload failed.'));
      toast.success(`${file.name} uploaded — indexing now.`);
      await loadDocuments();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(doc: KnowledgeDocument) {
    setBusyId(doc.id);
    try {
      const res = await api(`/svc/v1/knowledge/documents/${doc.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await apiErrorMessage(res, 'Delete failed.'));
      toast.success(`${doc.filename} removed.`);
      await Promise.all([loadDocuments(), loadGraph()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  const usagePct = usage ? Math.min(100, Math.round((usage.bytes_used / usage.byte_limit) * 100)) : 0;

  return (
    <div className="mx-auto w-full max-w-3xl px-5 pb-16 pt-8 sm:px-6 sm:pb-24 sm:pt-10">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-[26px]">Knowledge</h1>
      <p className="mt-2 text-[15px] text-muted-foreground">
        Upload documents and let your assistant remember facts from chat — it can search this to answer
        questions specific to your business.
      </p>

      <Card className="mt-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold">Upload a document</h3>
            <p className="mt-1 text-[13px] text-muted-foreground">
              PDF, XLSX, XLS, TXT, MD, or CSV. {usage ? `${formatBytes(usage.bytes_used)} of ${formatBytes(usage.byte_limit)} used.` : null}
            </p>
            {usage ? (
              <div className="mt-2 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full rounded-full ${usagePct >= 90 ? 'bg-destructive' : 'bg-brand'}`}
                  style={{ width: `${usagePct}%` }}
                />
              </div>
            ) : null}
          </div>
          <div className="shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              accept={ALLOWED_EXTENSIONS.join(',')}
              className="hidden"
              onChange={handleFileSelected}
            />
            <Button disabled={uploading} onClick={() => fileInputRef.current?.click()}>
              {uploading ? 'Uploading…' : 'Upload'}
            </Button>
          </div>
        </div>
        {usage?.graph_evicted_at ? (
          <p className="mt-3 text-[13px] text-muted-foreground">
            Your knowledge base was paused after a long period of inactivity. It rebuilds automatically the
            next time it's used.
          </p>
        ) : null}
      </Card>

      <div className="mt-6">
        <h2 className="text-[15px] font-semibold">Documents</h2>
        {documents === null ? (
          <div className="mt-3 flex flex-col gap-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : documents.length === 0 ? (
          <p className="mt-3 text-[13px] text-muted-foreground">Nothing uploaded yet.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {documents.map((doc) => (
              <li key={doc.id}>
                <Card className="transition-shadow hover:shadow-md">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[14px] font-medium">{doc.filename}</span>
                        <Badge tone={statusTone(doc.status)}>{doc.status}</Badge>
                        {doc.source_type === 'chat' ? <Badge tone="neutral">from chat</Badge> : null}
                      </div>
                      <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
                        {formatBytes(doc.byte_size)}
                        {doc.status === 'failed' && doc.error_message ? ` · ${doc.error_message}` : ''}
                      </p>
                    </div>
                    <Button
                      variant="danger"
                      disabled={busyId === doc.id}
                      onClick={() => handleDelete(doc)}
                    >
                      {busyId === doc.id ? 'Removing…' : 'Remove'}
                    </Button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-6">
        <h2 className="text-[15px] font-semibold">Knowledge graph</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Entities extracted from your documents and saved facts, connected by their relationships.
        </p>
        <Card className="mt-3 overflow-hidden p-0">
          {graph?.rebuilding ? (
            <div className="flex h-[360px] items-center justify-center text-[13px] text-muted-foreground">
              Rebuilding your knowledge graph — check back shortly.
            </div>
          ) : !graph || graph.nodes.length === 0 ? (
            <div className="flex h-[360px] items-center justify-center text-[13px] text-muted-foreground">
              Upload a document to see its knowledge graph here.
            </div>
          ) : (
            <Suspense
              fallback={<div className="flex h-[360px] items-center justify-center"><Skeleton className="h-full w-full" /></div>}
            >
              <div style={{ height: 360 }}>
                <ForceGraph2D
                  graphData={{
                    nodes: graph.nodes.map((n) => ({ id: n.id, caption: n.caption, type: n.type })),
                    links: graph.edges.map((e) => ({ source: e.source, target: e.target, label: e.label })),
                  }}
                  height={360}
                  nodeLabel="caption"
                  nodeAutoColorBy="type"
                  linkLabel="label"
                  linkDirectionalArrowLength={4}
                  nodeRelSize={4}
                />
              </div>
            </Suspense>
          )}
        </Card>
      </div>

      <BuildTag />
    </div>
  );
}
