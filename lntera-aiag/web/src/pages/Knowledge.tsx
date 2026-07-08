import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense, type ReactNode } from 'react';
import { toast } from 'sonner';
import { FileText, Loader2, Search, Trash2, Upload, X, type LucideIcon } from 'lucide-react';
import { useAuth } from '../auth';
import { Badge, Button, Skeleton } from '../ui';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import {
  ALLOWED_KNOWLEDGE_EXTENSIONS,
  MAX_KNOWLEDGE_UPLOAD_BYTES,
  formatBytes,
  isAllowedKnowledgeFile,
  uploadKnowledgeDocument,
  listKnowledgeDocuments,
  deleteKnowledgeDocument,
  fetchKnowledgeGraph,
  type KnowledgeDocument,
  type KnowledgeUsage,
  type KnowledgeGraphSnapshot,
  type KnowledgeGraphNode,
} from '../lib/knowledge';

// The force-graph canvas is a heavy dependency (d3-force + canvas rendering) — split it out so the
// toolbar/sheet UI stays fast even before the graph engine loads.
const ForceGraph2D = lazy(() => import('react-force-graph-2d'));

function statusTone(status: KnowledgeDocument['status']): 'success' | 'danger' | 'neutral' {
  if (status === 'ready') return 'success';
  if (status === 'failed') return 'danger';
  return 'neutral';
}

function EmptyState({
  icon: Icon,
  title,
  desc,
  action,
  spin,
}: {
  icon: LucideIcon;
  title: string;
  desc: string;
  action?: ReactNode;
  spin?: boolean;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
        <Icon className={`h-7 w-7 text-muted-foreground ${spin ? 'animate-spin' : ''}`} />
      </div>
      <div>
        <p className="text-[16px] font-semibold">{title}</p>
        <p className="mt-1 max-w-xs text-[13px] text-muted-foreground">{desc}</p>
      </div>
      {action}
    </div>
  );
}

function NodeDetailCard({
  node,
  graph,
  onClose,
}: {
  node: KnowledgeGraphNode;
  graph: KnowledgeGraphSnapshot | null;
  onClose: () => void;
}) {
  const related = useMemo(() => {
    if (!graph) return [];
    const ids = new Set<string>();
    for (const e of graph.edges) {
      if (e.source === node.id) ids.add(e.target);
      else if (e.target === node.id) ids.add(e.source);
    }
    return graph.nodes.filter((n) => ids.has(n.id));
  }, [graph, node]);

  return (
    <div className="animate-fade-in-up absolute bottom-4 left-4 right-4 z-20 max-w-sm rounded-2xl border bg-background/95 p-4 shadow-lg backdrop-blur-md sm:left-6 sm:right-auto">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold">{node.caption}</p>
          {node.type ? <Badge tone="neutral">{node.type}</Badge> : null}
        </div>
        <button
          onClick={onClose}
          className="shrink-0 rounded-full p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {related.length > 0 ? (
        <div className="mt-3">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Connected to</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {related.slice(0, 10).map((r) => (
              <span key={r.id} className="rounded-full border bg-muted/40 px-2 py-0.5 text-[12px]">
                {r.caption}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <p className="mt-2 text-[13px] text-muted-foreground">No direct connections yet.</p>
      )}
    </div>
  );
}

function DocumentsSheet({
  open,
  onOpenChange,
  documents,
  usage,
  uploading,
  busyId,
  onUploadClick,
  onDelete,
  fileInputRef,
  onFileSelected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  documents: KnowledgeDocument[] | null;
  usage: KnowledgeUsage | null;
  uploading: boolean;
  busyId: string | null;
  onUploadClick: () => void;
  onDelete: (doc: KnowledgeDocument) => void;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onFileSelected: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  const usagePct = usage ? Math.min(100, Math.round((usage.bytes_used / usage.byte_limit) * 100)) : 0;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-[88vw] flex-col p-6 sm:w-[420px] sm:max-w-none">
        <SheetTitle>Documents</SheetTitle>
        <SheetDescription>Upload documents to grow your knowledge graph.</SheetDescription>

        <input
          ref={fileInputRef}
          type="file"
          accept={ALLOWED_KNOWLEDGE_EXTENSIONS.join(',')}
          className="hidden"
          onChange={onFileSelected}
        />
        <Button disabled={uploading} onClick={onUploadClick} className="gap-2">
          <Upload className="h-4 w-4" />
          {uploading ? 'Uploading…' : 'Upload a document'}
        </Button>
        <p className="-mt-2 text-[12px] text-muted-foreground">PDF, XLSX, XLS, TXT, MD, or CSV.</p>

        {usage ? (
          <div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full ${usagePct >= 90 ? 'bg-destructive' : 'bg-brand'}`}
                style={{ width: `${usagePct}%` }}
              />
            </div>
            <p className="mt-1 text-[12px] text-muted-foreground">
              {formatBytes(usage.bytes_used)} of {formatBytes(usage.byte_limit)} used
            </p>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {documents === null ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : documents.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">Nothing uploaded yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {documents.map((doc) => (
                <li key={doc.id} className="rounded-xl border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-[13px] font-medium">{doc.filename}</span>
                        <Badge tone={statusTone(doc.status)}>{doc.status}</Badge>
                        {doc.source_type === 'chat' ? <Badge tone="neutral">from chat</Badge> : null}
                      </div>
                      <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
                        {formatBytes(doc.byte_size)}
                        {doc.status === 'failed' && doc.error_message ? ` · ${doc.error_message}` : ''}
                      </p>
                    </div>
                    <button
                      disabled={busyId === doc.id}
                      onClick={() => onDelete(doc)}
                      className="shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                      aria-label={`Remove ${doc.filename}`}
                    >
                      {busyId === doc.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default function Knowledge() {
  const { api } = useAuth();
  const [documents, setDocuments] = useState<KnowledgeDocument[] | null>(null);
  const [usage, setUsage] = useState<KnowledgeUsage | null>(null);
  const [graph, setGraph] = useState<KnowledgeGraphSnapshot | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedNode, setSelectedNode] = useState<KnowledgeGraphNode | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  const loadDocuments = useCallback(async () => {
    const data = await listKnowledgeDocuments(api);
    setDocuments(data.documents);
    setUsage(data.usage);
  }, [api]);

  const loadGraph = useCallback(async () => {
    try {
      setGraph(await fetchKnowledgeGraph(api));
    } catch {
      // keep the previously rendered graph on a transient error rather than blanking the canvas
    }
  }, [api]);

  useEffect(() => {
    loadDocuments().catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
    void loadGraph();
  }, [loadDocuments, loadGraph]);

  // Any document still pending/processing → keep polling so status + the graph update live.
  useEffect(() => {
    if (!documents?.some((d) => d.status === 'pending' || d.status === 'processing')) return;
    const t = window.setInterval(() => {
      loadDocuments().catch(() => {});
      void loadGraph();
    }, 4000);
    return () => window.clearInterval(t);
  }, [documents, loadDocuments, loadGraph]);

  // react-force-graph needs explicit pixel dimensions — track the canvas wrapper's actual size.
  useEffect(() => {
    const el = canvasWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setCanvasSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!isAllowedKnowledgeFile(file.name)) {
      toast.error(`Unsupported file type. Supported: ${ALLOWED_KNOWLEDGE_EXTENSIONS.join(', ')}`);
      return;
    }
    if (file.size > MAX_KNOWLEDGE_UPLOAD_BYTES) {
      toast.error('File is larger than the 10MB knowledge base limit.');
      return;
    }
    setUploading(true);
    try {
      await uploadKnowledgeDocument(api, file);
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
      await deleteKnowledgeDocument(api, doc.id);
      toast.success(`${doc.filename} removed.`);
      await Promise.all([loadDocuments(), loadGraph()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  // Search narrows the rendered graph to matching entities + the edges directly between them.
  const visibleGraphData = useMemo(() => {
    if (!graph) return { nodes: [], links: [] };
    const q = search.trim().toLowerCase();
    if (!q) return { nodes: graph.nodes, links: graph.edges };
    const matchIds = new Set(graph.nodes.filter((n) => n.caption.toLowerCase().includes(q)).map((n) => n.id));
    return {
      nodes: graph.nodes.filter((n) => matchIds.has(n.id)),
      links: graph.edges.filter((e) => matchIds.has(e.source) && matchIds.has(e.target)),
    };
  }, [graph, search]);

  const hasNodes = (graph?.nodes.length ?? 0) > 0;
  const rebuilding = Boolean(graph?.rebuilding);

  return (
    <div className="relative h-[calc(100vh-3.5rem)] w-full overflow-hidden bg-muted/10">
      <div ref={canvasWrapRef} className="absolute inset-0">
        {rebuilding ? (
          <EmptyState
            icon={Loader2}
            spin
            title="Rebuilding your knowledge graph"
            desc="Your knowledge base was paused after a period of inactivity and is repopulating from your documents — check back shortly."
          />
        ) : !hasNodes ? (
          <EmptyState
            icon={FileText}
            title="No knowledge yet"
            desc="Upload a document or save a fact from chat — entities and their relationships will appear here as a graph."
            action={
              <Button onClick={() => setSheetOpen(true)} className="gap-2">
                <Upload className="h-4 w-4" />
                Upload a document
              </Button>
            }
          />
        ) : canvasSize.width > 0 && canvasSize.height > 0 ? (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center">
                <Skeleton className="h-3/4 w-3/4 rounded-2xl" />
              </div>
            }
          >
            <ForceGraph2D
              width={canvasSize.width}
              height={canvasSize.height}
              graphData={visibleGraphData}
              backgroundColor="rgba(0,0,0,0)"
              nodeLabel="caption"
              nodeAutoColorBy="type"
              linkColor={() => 'rgba(148,163,184,0.4)'}
              linkWidth={1}
              nodeRelSize={5}
              onNodeClick={(node) => setSelectedNode(node as unknown as KnowledgeGraphNode)}
              onBackgroundClick={() => setSelectedNode(null)}
              cooldownTicks={100}
            />
          </Suspense>
        ) : null}
      </div>

      {/* Floating glass toolbar */}
      <div className="absolute left-4 right-4 top-4 z-10 flex items-center gap-2 rounded-2xl border bg-background/75 px-3 py-2 shadow-md backdrop-blur-md sm:left-6 sm:right-6">
        <h1 className="shrink-0 text-[15px] font-semibold tracking-tight">Knowledge</h1>
        <div className="relative min-w-0 max-w-xs flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search entities…"
            className="w-full rounded-lg border bg-background/60 py-1.5 pl-8 pr-7 text-[13px] outline-none focus:ring-2 focus:ring-ring"
          />
          {search ? (
            <button
              onClick={() => setSearch('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {usage ? (
            <span className="hidden text-[12px] text-muted-foreground sm:inline">
              {formatBytes(usage.bytes_used)} / {formatBytes(usage.byte_limit)}
            </span>
          ) : null}
          <button
            onClick={() => setSheetOpen(true)}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Documents"
            title="Documents"
          >
            <FileText className="h-[18px] w-[18px]" />
          </button>
        </div>
      </div>

      {selectedNode ? (
        <NodeDetailCard node={selectedNode} graph={graph} onClose={() => setSelectedNode(null)} />
      ) : null}

      <DocumentsSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        documents={documents}
        usage={usage}
        uploading={uploading}
        busyId={busyId}
        onUploadClick={() => fileInputRef.current?.click()}
        onDelete={handleDelete}
        fileInputRef={fileInputRef}
        onFileSelected={handleFileSelected}
      />
    </div>
  );
}
