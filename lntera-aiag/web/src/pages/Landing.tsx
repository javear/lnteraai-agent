import { Container } from '../components/landing/Container';
import { Reveal } from '../components/landing/Reveal';
import { MockChat } from '../components/landing/MockChat';
import { AgentCursor } from '../components/landing/AgentCursor';
import { BrandAuth } from '../components/landing/BrandAuth';
import { SpaceBackdrop } from '../components/landing/SpaceBackdrop';
import { LandingNav } from '../components/landing/LandingNav';
import { LandingFooter } from '../components/landing/LandingFooter';
import '../styles/landing.css';

const CAPS: { title: string; desc: string; chips?: string[]; featured?: boolean }[] = [
  {
    title: 'Run orders like you have a backroom team',
    desc: 'Say "ship today’s orders" — Lntera finds them across every shop, builds the packages, and pulls the labels. No tab-switching.',
    chips: ['search-orders', 'create-package', 'get-shipping-labels'],
    featured: true,
  },
  { title: 'Price & stock, by sentence', desc: '"Drop the linen shirts 10%." Done — across SKUs and shops at once.' },
  { title: 'List once, sell everywhere', desc: 'Draft a product, refine it, push it live to Shopee or TikTok Shop.' },
  { title: 'Every shop, one brain', desc: 'Connect as many Shopee and TikTok Shop stores as you run.' },
  { title: 'Bring your own model', desc: 'Your free Groq or Gemini key. Add both and never hit a rate wall.' },
  { title: 'It watches while you sleep', desc: 'Orders, shipments, returns → in-app, Discord, push. Reply to act.' },
];

const STEPS: { title: string; body: string; chips?: string[] }[] = [
  { title: 'Bring a key', body: 'Connect your free Groq or Gemini key via Portkey — stored securely.' },
  { title: 'Connect a shop', body: 'Link Shopee or TikTok Shop in a click. Add as many as you run.' },
  {
    title: 'Just ask',
    body: 'Talk to your storefront in plain language:',
    chips: ["Show today’s orders", 'Search my products', 'List my shops'],
  },
  { title: 'Go Active', body: 'Flip on realtime alerts — in-app, on Discord, and as push.' },
];

const WHY: { title: string; desc: string }[] = [
  {
    title: 'No card, no markup',
    desc: 'You pay your LLM provider directly with your own free key. We never resell or mark up tokens.',
  },
  {
    title: 'Never hits a wall',
    desc: 'Connect Groq and Gemini together; the agent rolls over the moment one rate-limits.',
  },
  {
    title: 'Realtime, everywhere',
    desc: 'Webhook events become alerts in-app, in Discord and as push — the instant they happen.',
  },
  {
    title: 'Yours on every device',
    desc: 'Install it as an app on phone and desktop. Works offline with your last data cached.',
  },
];

const FEED = [
  { emoji: '🛒', title: 'New order on Shopee', meta: 'Main Store · 2 items' },
  { emoji: '📦', title: 'Shipping update on TikTok Shop', meta: 'Outlet · 1 package ready' },
  { emoji: '↩️', title: 'Return requested on Shopee', meta: 'Main Store · awaiting review' },
];

function toForm() {
  document.getElementById('get-started')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

const n2 = (i: number) => String(i + 1).padStart(2, '0');

export default function Landing() {
  return (
    <div className="lp">
      <LandingNav />

      <main>
        {/* ───────── Hero — deep-space: drifting starfield + warm glow, asymmetric 7/5 ───────── */}
        <section className="lp-space relative overflow-hidden bg-[hsl(var(--bg))] pb-16 pt-10 text-[hsl(var(--fg))] sm:pb-24 sm:pt-16">
          <SpaceBackdrop glow="top" />
          <Container className="relative z-10 grid items-start gap-12 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-16">
            <Reveal className="lg:pt-6">
              <div className="lp-eyebrow">The business agent · Shopee &amp; TikTok Shop</div>
              <h1 className="lp-display mt-5 text-[2.6rem] leading-[1.02] sm:text-[3.4rem] lg:text-[4.2rem]">
                Run your shops
                <br />
                from <span className="text-brand">one calm chat.</span>
              </h1>
              <p className="mt-6 max-w-md text-[1.05rem] leading-relaxed text-[hsl(var(--fg-soft))]">
                Ask in plain language — "ship today&apos;s orders", "drop the linen shirts 10%" — and Lntera
                works your Shopee and TikTok Shop stores for you. Your own free LLM key. No card, no markup.
              </p>
              <div id="get-started" className="mt-8 max-w-sm scroll-mt-28">
                <BrandAuth />
              </div>
            </Reveal>

            <Reveal delay={140} className="lg:mt-12">
              <div className="relative">
                <MockChat />
                <AgentCursor label="Lntera" />
              </div>
              <p className="lp-mono mt-4 text-[0.7rem] uppercase tracking-[0.14em] text-[hsl(var(--fg-soft))]">
                18 marketplace tools · Groq + Gemini · Discord + push
              </p>
            </Reveal>
          </Container>
        </section>

        {/* ───────── Trust — muted, left-aligned ───────── */}
        <section className="border-y bg-[hsl(var(--bg-2)/0.4)]">
          <Container className="flex flex-col gap-3 py-6 sm:flex-row sm:items-center sm:gap-9">
            <span className="lp-mono shrink-0 text-[0.7rem] uppercase tracking-[0.16em] text-[hsl(var(--fg-soft))]">
              Works with
            </span>
            <div className="flex flex-wrap items-center gap-x-7 gap-y-2">
              {['Shopee', 'TikTok Shop', 'Discord', 'Groq', 'Gemini', 'Portkey'].map((nm) => (
                <span key={nm} className="text-[14px] text-[hsl(var(--fg)/0.55)]">
                  {nm}
                </span>
              ))}
            </div>
          </Container>
        </section>

        {/* ───────── Capabilities — sticky label + hairline bento ───────── */}
        <section className="py-20 sm:py-28">
          <Container className="grid gap-8 lg:grid-cols-[200px_1fr] lg:gap-16">
            <div className="lg:sticky lg:top-28 lg:self-start">
              <div className="lp-eyebrow">Capabilities</div>
              <h2 className="lp-display mt-3 text-[1.7rem] leading-[1.05]">The whole storefront, in one chat.</h2>
            </div>
            <Reveal className="grid grid-cols-1 gap-px overflow-hidden rounded-2xl border bg-[hsl(var(--line))] lg:grid-cols-3">
              {CAPS.map((c) => (
                <div
                  key={c.title}
                  className={
                    c.featured
                      ? 'bg-[hsl(var(--brand)/0.06)] p-7 lg:col-span-2 lg:row-span-2'
                      : 'bg-[hsl(var(--bg))] p-7'
                  }
                >
                  <h3 className={c.featured ? 'text-[1.3rem] font-semibold leading-snug' : 'text-[1.02rem] font-semibold'}>
                    {c.title}
                  </h3>
                  <p
                    className={`mt-2 text-[13.5px] leading-relaxed text-[hsl(var(--fg-soft))] ${
                      c.featured ? 'max-w-md' : ''
                    }`}
                  >
                    {c.desc}
                  </p>
                  {c.chips ? (
                    <div className="mt-5 flex flex-wrap gap-1.5">
                      {c.chips.map((ch) => (
                        <span key={ch} className="lp-chip">
                          {ch}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </Reveal>
          </Container>
        </section>

        {/* ───────── Stat band ───────── */}
        <section className="border-y bg-[hsl(var(--bg-2)/0.4)] py-14 sm:py-20">
          <Container className="flex flex-col gap-4 sm:flex-row sm:items-end sm:gap-9">
            <div className="lp-display text-[4.5rem] leading-[0.82] text-brand sm:text-[6.5rem]">18</div>
            <div className="sm:pb-3">
              <div className="text-[1.15rem] font-semibold leading-tight">marketplace tools, one calm chat</div>
              <div className="lp-mono mt-1.5 text-[0.72rem] uppercase tracking-[0.14em] text-[hsl(var(--fg-soft))]">
                orders · fulfillment · products · pricing · drafts
              </div>
            </div>
          </Container>
        </section>

        {/* ───────── Setup — sticky label + steps ───────── */}
        <section className="py-20 sm:py-28">
          <Container className="grid gap-10 lg:grid-cols-[200px_1fr] lg:gap-16">
            <div className="lg:sticky lg:top-28 lg:self-start">
              <div className="lp-eyebrow">Setup</div>
              <h2 className="lp-display mt-3 text-[1.7rem] leading-[1.05]">Live in minutes.</h2>
              <p className="mt-3 text-[14px] leading-relaxed text-[hsl(var(--fg-soft))]">
                No infra, no model bills. A key, a shop, and you&apos;re asking.
              </p>
            </div>
            <ol className="space-y-7">
              {STEPS.map((s, i) => (
                <li key={s.title} className="flex gap-5">
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-[1.5px] border-[hsl(var(--brand)/0.5)] text-[0.85rem] font-semibold text-brand">
                    {i + 1}
                  </span>
                  <div className="border-b pb-6">
                    <h3 className="text-[1.05rem] font-semibold">{s.title}</h3>
                    <p className="mt-1.5 text-[14px] leading-relaxed text-[hsl(var(--fg-soft))]">{s.body}</p>
                    {s.chips ? (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {s.chips.map((ch) => (
                          <span key={ch} className="lp-chip">
                            {ch}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          </Container>
        </section>

        {/* ───────── Active Agent — mirrored: feed left, copy right ───────── */}
        <section className="border-y bg-[hsl(var(--bg-2)/0.4)] py-20 sm:py-28">
          <Container className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
            <Reveal className="lg:order-1">
              <div className="lp-frame overflow-hidden">
                <div className="flex items-center justify-between border-b px-4 py-3">
                  <span className="lp-mono text-[11px] uppercase tracking-[0.14em] text-[hsl(var(--fg-soft))]">
                    Active Agent
                  </span>
                  <span className="lp-mono inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[hsl(var(--fg-soft))]">
                    <span className="h-1.5 w-1.5 rounded-full bg-brand" />
                    live
                  </span>
                </div>
                <ul className="divide-y">
                  {FEED.map((e) => (
                    <li key={e.title} className="flex items-start gap-3 px-4 py-3.5">
                      <span className="text-lg leading-none" aria-hidden>{e.emoji}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13.5px] font-medium">{e.title}</div>
                        <div className="lp-mono text-[11px] text-[hsl(var(--fg-soft))]">{e.meta}</div>
                      </div>
                      <span className="lp-mono text-[10px] uppercase tracking-wide text-brand">now</span>
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
            <div className="lg:order-2">
              <div className="lp-eyebrow">Active Agent</div>
              <h2 className="lp-display mt-3 text-[1.9rem] leading-[1.05] sm:text-[2.6rem]">
                It keeps working when you close the laptop.
              </h2>
              <p className="mt-4 max-w-md text-[15px] leading-relaxed text-[hsl(var(--fg-soft))]">
                Orders, shipments and returns surface the instant they happen — in the app, in Discord, and as a
                push. Reply right there and the agent handles it.
              </p>
              <div className="mt-7 space-y-5">
                <div className="border-l-2 border-brand pl-4">
                  <h3 className="font-semibold">Realtime, everywhere</h3>
                  <p className="mt-1 text-[13.5px] leading-relaxed text-[hsl(var(--fg-soft))]">
                    One webhook → in-app popup, Discord message, and phone push at once.
                  </p>
                </div>
                <div className="border-l-2 border-brand pl-4">
                  <h3 className="font-semibold">Reply to act</h3>
                  <p className="mt-1 text-[13.5px] leading-relaxed text-[hsl(var(--fg-soft))]">
                    "Ship it" or "refund this" — answer the alert and it&apos;s done.
                  </p>
                </div>
              </div>
            </div>
          </Container>
        </section>

        {/* ───────── Why — centered emotional beat ───────── */}
        <section className="py-20 sm:py-28">
          <Container>
            <div className="mx-auto max-w-2xl text-center">
              <div className="lp-eyebrow">Why Lntera</div>
              <h2 className="lp-display mt-3 text-[1.9rem] leading-[1.04] sm:text-[2.8rem]">
                A power tool, priced like a tool.
              </h2>
            </div>
            <div className="mx-auto mt-12 grid max-w-3xl gap-x-12 gap-y-9 sm:grid-cols-2">
              {WHY.map((d, i) => (
                <div key={d.title} className="flex gap-4">
                  <span className="lp-mono mt-1 shrink-0 text-[0.72rem] tracking-widest text-brand">
                    {n2(i)}
                  </span>
                  <div>
                    <h3 className="font-semibold">{d.title}</h3>
                    <p className="mt-1.5 text-[13.5px] leading-relaxed text-[hsl(var(--fg-soft))]">{d.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </Container>
        </section>

        {/* ───────── CTA — deep-space climax: oversized, glow behind the button ───────── */}
        <section className="lp-space relative overflow-hidden border-t bg-[hsl(var(--bg))] py-24 text-[hsl(var(--fg))] sm:py-32">
          <SpaceBackdrop glow="center" />
          <Container className="relative z-10 grid items-end gap-8 lg:grid-cols-[1fr_auto]">
            <h2 className="lp-display max-w-[16ch] text-[2.6rem] leading-[1.0] sm:text-[3.8rem]">
              Put your storefront on autopilot.
            </h2>
            <button onClick={toForm} className="lp-btn shrink-0 !px-6 !py-3.5 !text-[0.95rem]">
              Start free →
            </button>
          </Container>
          <Container className="relative z-10 mt-6">
            <p className="lp-mono text-[0.72rem] uppercase tracking-[0.14em] text-[hsl(var(--fg-soft))]">
              Bring your own key · no card · cancel anytime
            </p>
          </Container>
        </section>
      </main>

      <LandingFooter />
    </div>
  );
}
