// Renders one assistant turn's inline activity timeline (file writes, terminal commands, git actions,
// thoughts) — the Lovable / Claude-Code "watch it work" experience, inline in the chat rather than a
// separate terminal tab. Purely presentational: it renders the StudioActivity[] the send() loop builds.
import { memo, useState } from 'react';
import {
  ChevronRight,
  CircleCheck,
  FilePen,
  FilePlus,
  FileX,
  FolderPlus,
  GitCommitHorizontal,
  LoaderCircle,
  Search,
  Terminal,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CommandActivity, StudioActivity, ThoughtActivity } from '@/lib/studio/activity';

function FileRow({ op, path }: { op: 'write' | 'delete' | 'mkdir'; path: string }) {
  const Icon = op === 'delete' ? FileX : op === 'mkdir' ? FolderPlus : path ? FilePen : FilePlus;
  const tone = op === 'delete' ? 'text-red-500' : 'text-emerald-500';
  const sign = op === 'delete' ? '-' : op === 'mkdir' ? '□' : '+';
  return (
    <div className="flex items-center gap-2 py-0.5 text-[13px]">
      <Icon className={cn('h-3.5 w-3.5 shrink-0', tone)} />
      <span className={cn('font-mono tabular-nums', tone)}>{sign}</span>
      <span className="truncate font-mono text-foreground/90">{path}</span>
    </div>
  );
}

function ReadRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5 text-[12.5px] text-muted-foreground">
      <Search className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
    </div>
  );
}

function GitRow({ label, detail, running }: { label: string; detail?: string; running: boolean }) {
  return (
    <div className="flex items-center gap-2 py-0.5 text-[13px]">
      {running ? (
        <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0 text-violet-500" />
      )}
      <span className="text-foreground/90">{label}</span>
      {detail ? <span className="font-mono text-[12px] text-muted-foreground">{detail}</span> : null}
    </div>
  );
}

function CommandCard({ activity }: { activity: CommandActivity }) {
  // Collapsed by default once done and successful; auto-expanded while running or on failure, so the
  // user watches long installs/builds live and always sees errors without a click.
  const failed = activity.exitCode != null && activity.exitCode !== 0;
  const [open, setOpen] = useState(true);
  const expanded = activity.running || failed || open;
  const output = activity.output.trim();

  return (
    <div className="overflow-hidden rounded-lg border bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-muted/50"
      >
        {activity.running ? (
          <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : failed ? (
          <span className="h-3.5 w-3.5 shrink-0 text-center font-mono text-red-500">✕</span>
        ) : (
          <CircleCheck className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
        )}
        <Terminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-foreground/90">{activity.command}</span>
        {!activity.running && failed ? (
          <span className="ml-auto shrink-0 font-mono text-[11px] text-red-500">exit {activity.exitCode}</span>
        ) : null}
        <ChevronRight className={cn('ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90', !activity.running && failed && 'ml-2')} />
      </button>
      {expanded && output ? (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap border-t bg-background/60 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-foreground/80">
          {output}
        </pre>
      ) : null}
    </div>
  );
}

function ThoughtRow({ activity }: { activity: ThoughtActivity }) {
  const [open, setOpen] = useState(false);
  const secs = activity.durationMs != null ? Math.max(1, Math.round(activity.durationMs / 1000)) : null;
  const label = activity.durationMs == null ? 'Thinking…' : `Thought for ${secs}s`;
  return (
    <div className="text-[12.5px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
        <span>{label}</span>
      </button>
      {open && activity.text.trim() ? (
        <div className="mt-1 whitespace-pre-wrap border-l-2 pl-3 text-[12px] leading-relaxed text-muted-foreground/70">
          {activity.text.trim()}
        </div>
      ) : null}
    </div>
  );
}

function StudioActivityTimelineImpl({ activity }: { activity: StudioActivity[] }) {
  if (activity.length === 0) return null;
  return (
    <div className="mb-2 flex flex-col gap-1.5">
      {activity.map((a) => {
        switch (a.kind) {
          case 'file':
            return <FileRow key={a.id} op={a.op} path={a.path} />;
          case 'read':
            return <ReadRow key={a.id} label={a.label} />;
          case 'git':
            return <GitRow key={a.id} label={a.label} detail={a.detail} running={a.running} />;
          case 'command':
            return <CommandCard key={a.id} activity={a} />;
          case 'thought':
            return <ThoughtRow key={a.id} activity={a} />;
        }
      })}
    </div>
  );
}

export const StudioActivityTimeline = memo(StudioActivityTimelineImpl);
