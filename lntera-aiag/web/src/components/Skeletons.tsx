import { Skeleton } from '@/components/ui/skeleton';

/** Connection list placeholder shown in the shell sidebar while status loads. */
export function SidebarSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-2">
          <Skeleton className="h-1.5 w-1.5 rounded-full" />
          <Skeleton className="h-3.5" style={{ width: `${60 - i * 6}%` }} />
        </div>
      ))}
    </div>
  );
}

/** Integration cards placeholder. */
export function IntegrationListSkeleton() {
  return (
    <div className="mt-6 grid gap-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2.5">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-5 w-20 rounded-full" />
              </div>
              <Skeleton className="mt-2.5 h-3.5 w-3/4" />
            </div>
            <Skeleton className="h-9 w-24 shrink-0 rounded-md" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Route-level fallback while the lazy Chat chunk loads — mirrors the chat layout. */
export function ChatRouteSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
          <div className="flex justify-end">
            <Skeleton className="h-10 w-48 rounded-2xl" />
          </div>
          <div className="flex gap-3">
            <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2 pt-1">
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-4/6" />
              <Skeleton className="h-4 w-3/6" />
            </div>
          </div>
        </div>
      </div>
      <div className="border-t px-3 py-3 sm:px-4">
        <div className="mx-auto max-w-3xl">
          <Skeleton className="h-11 w-full rounded-md" />
        </div>
      </div>
    </div>
  );
}

/** Route-level fallback for page routes (Login / Integrations). */
export function PageRouteSkeleton() {
  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-8 sm:px-6 sm:py-10">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="mt-3 h-4 w-72" />
      <IntegrationListSkeleton />
    </div>
  );
}
