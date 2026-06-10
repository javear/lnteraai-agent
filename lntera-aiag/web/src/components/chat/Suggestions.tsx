export function Suggestions({ items, onPick }: { items: string[]; onPick: (s: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="flex animate-fade-in flex-wrap gap-2 pl-0 sm:pl-11">
      {items.map((s, i) => (
        <button
          key={`${i}-${s}`}
          type="button"
          onClick={() => onPick(s)}
          className="rounded-full border bg-background px-3.5 py-1.5 text-[13px] text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {s}
        </button>
      ))}
    </div>
  );
}
