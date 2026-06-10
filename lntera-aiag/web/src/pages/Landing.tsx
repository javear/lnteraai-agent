import type { ComponentType } from 'react';
import {
  ArrowRight,
  BellRing,
  Boxes,
  KeyRound,
  RefreshCw,
  Rocket,
  ShieldCheck,
  ShoppingBag,
  Smartphone,
  Sparkles,
  Store,
  Zap,
} from 'lucide-react';
import { AuthPanel } from '../components/auth/AuthPanel';
import { Container } from '../components/landing/Container';
import { Section } from '../components/landing/Section';
import { Reveal } from '../components/landing/Reveal';
import { MockChat } from '../components/landing/MockChat';
import { HighlightRotator } from '../components/landing/HighlightRotator';
import { LandingNav } from '../components/landing/LandingNav';
import { LandingFooter } from '../components/landing/LandingFooter';
import { Button, Card, Code, Step, Steps } from '../ui';
import { cn } from '@/lib/utils';

const HERO_HIGHLIGHTS = [
  "Track today's orders",
  'Confirm fulfillment & print labels',
  'Update price & stock',
  'Publish a product draft',
  'Realtime order alerts',
];

const FEATURES: { icon: ComponentType<{ className?: string }>; title: string; desc: string }[] = [
  {
    icon: ShoppingBag,
    title: 'Orders & fulfillment',
    desc: 'Search orders, confirm fulfillment, create packages and pull shipping labels — without leaving the chat.',
  },
  {
    icon: Boxes,
    title: 'Products & pricing',
    desc: 'Find products and update attributes, price or stock — or archive a listing — across every shop at once.',
  },
  {
    icon: Rocket,
    title: 'Listings & drafts',
    desc: 'Draft a product, refine it, then publish to Shopee or TikTok Shop — or discard the draft.',
  },
  {
    icon: Store,
    title: 'Multi-store',
    desc: 'Connect as many Shopee and TikTok Shop stores as you run. The agent works across all of them.',
  },
  {
    icon: KeyRound,
    title: 'Bring your own LLM',
    desc: 'Use your free Groq or Gemini key via Portkey. Add both and the agent rolls across them automatically.',
  },
  {
    icon: BellRing,
    title: 'Realtime Active Agent',
    desc: 'Order and event updates arrive in-app, on Discord and as push — reply to ask the agent for details.',
  },
];

const DIFFERENTIATORS: { icon: ComponentType<{ className?: string }>; title: string; desc: string }[] = [
  {
    icon: ShieldCheck,
    title: 'No model markup',
    desc: 'You pay your LLM provider directly with your own free key. We never resell or mark up tokens.',
  },
  {
    icon: RefreshCw,
    title: 'Never blocked by limits',
    desc: 'Connect Groq and Gemini together and the agent automatically rolls over when one hits a rate limit.',
  },
  {
    icon: Zap,
    title: 'Realtime, everywhere',
    desc: 'Webhook events become notifications in-app, in Discord, and as push the moment they happen.',
  },
  {
    icon: Smartphone,
    title: 'Installable PWA',
    desc: 'Install Lntera on your phone or desktop. It works offline with your last-known data cached.',
  },
];

// Sample Active-Agent feed — mirrors the real minimal notifications the backend delivers.
const FEED = [
  { emoji: '🛒', title: 'New order on Shopee', meta: 'Main Store · 2 items', tone: 'brand' as const },
  { emoji: '📦', title: 'Shipping update on TikTok Shop', meta: 'Outlet · 1 package ready', tone: 'muted' as const },
  { emoji: '↩️', title: 'Return requested on Shopee', meta: 'Main Store · awaiting review', tone: 'muted' as const },
];

function scrollToForm() {
  document.getElementById('get-started')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

export default function Landing() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <LandingNav />

      <main>
        {/* ───────────────────────── Hero ───────────────────────── */}
        <section className="relative overflow-hidden">
          <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
            <div className="absolute left-1/2 top-[-12%] h-[460px] w-[min(880px,95vw)] -translate-x-1/2 rounded-full bg-brand/10 blur-3xl" />
          </div>

          <Container className="grid items-center gap-12 py-14 sm:py-20 lg:grid-cols-2 lg:gap-12">
            {/* Left — pitch + auth */}
            <div className="max-w-xl">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-brand/25 bg-brand/10 px-3 py-1 text-xs font-medium text-brand">
                <Sparkles className="h-3.5 w-3.5" />
                For Shopee &amp; TikTok Shop sellers
              </span>
              <h1 className="mt-5 text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl">
                Run your shops from <span className="text-brand">one chat.</span>
              </h1>
              <p className="mt-4 text-[17px] leading-relaxed text-muted-foreground">
                Lntera is an AI agent that handles orders, fulfillment, products and pricing across your
                Shopee and TikTok Shop stores. Bring your own free Groq or Gemini key — no model markup.
              </p>
              <div id="get-started" className="mt-8 max-w-sm scroll-mt-24">
                <AuthPanel variant="bare" defaultMode="signup" showLogo={false} />
              </div>
            </div>

            {/* Right — live demo + slider */}
            <div className="w-full">
              <Reveal>
                <MockChat />
              </Reveal>
              <HighlightRotator className="mt-6" items={HERO_HIGHLIGHTS} />
            </div>
          </Container>
        </section>

        {/* ──────────────────────── Trust strip ──────────────────────── */}
        <section className="border-y bg-muted/30 py-8">
          <Container>
            <p className="text-center text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Connects with
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-[15px] font-semibold text-muted-foreground">
              {['Shopee', 'TikTok Shop', 'Discord', 'Groq', 'Gemini', 'Portkey'].map((name) => (
                <span key={name} className="inline-flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-brand/50" />
                  {name}
                </span>
              ))}
            </div>
          </Container>
        </section>

        {/* ──────────────────────── Features ──────────────────────── */}
        <Section
          id="features"
          eyebrow="Capabilities"
          title="One agent for the whole storefront"
          subtitle="Lntera turns the things you'd click through dashboards for into a sentence. It runs the real marketplace APIs for you."
        >
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f, i) => (
              <Reveal key={f.title} delay={i * 60}>
                <Card className="h-full">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 text-brand">
                    <f.icon className="h-5 w-5" />
                  </div>
                  <h3 className="mt-4 text-[15px] font-semibold">{f.title}</h3>
                  <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">{f.desc}</p>
                </Card>
              </Reveal>
            ))}
          </div>
        </Section>

        {/* ──────────────────────── How it works ──────────────────────── */}
        <section className="border-t bg-muted/20 py-16 sm:py-24">
          <Container className="grid gap-12 lg:grid-cols-2 lg:items-center lg:gap-16">
            <div className="max-w-md">
              <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-brand">Setup</div>
              <h2 className="text-2xl font-semibold tracking-tight sm:text-4xl">Live in minutes</h2>
              <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground sm:text-base">
                No infrastructure, no model bills. Connect a key, connect a shop, and start asking.
              </p>
            </div>
            <Reveal as="div" className="rounded-2xl border bg-card p-6 shadow-sm sm:p-8">
              <Steps>
                <Step n={1} title="Connect your LLM key">
                  Add Groq or Gemini via Portkey — your own free key, stored securely.
                </Step>
                <Step n={2} title="Connect a shop">
                  Link your Shopee or TikTok Shop store with one click. Add as many as you run.
                </Step>
                <Step n={3} title="Just ask">
                  <span className="flex flex-wrap gap-1.5">
                    <Code>List my connected shops</Code>
                    <Code>Show today's orders</Code>
                    <Code>Search my products</Code>
                  </span>
                </Step>
                <Step n={4} title="Turn on Active mode">
                  Get realtime order and event alerts in-app, on Discord, and via push.
                </Step>
              </Steps>
            </Reveal>
          </Container>
        </section>

        {/* ──────────────────────── Product preview (Active Agent) ──────────────────────── */}
        <Section
          id="realtime"
          eyebrow="Active Agent"
          title="Your shops, in real time"
          subtitle="The moment an order, shipment or return happens, Lntera tells you — and you can reply to dig in."
        >
          <div className="mx-auto mt-12 grid max-w-4xl gap-8 lg:grid-cols-2 lg:items-center">
            <div className="space-y-4">
              {DIFFERENTIATORS.slice(2).map((d) => (
                <div key={d.title} className="flex gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
                    <d.icon className="h-4 w-4" />
                  </div>
                  <div>
                    <h3 className="text-[15px] font-semibold">{d.title}</h3>
                    <p className="mt-1 text-[13.5px] leading-relaxed text-muted-foreground">{d.desc}</p>
                  </div>
                </div>
              ))}
            </div>
            <Reveal>
              <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
                <div className="flex items-center gap-2 border-b px-4 py-2.5">
                  <Sparkles className="h-4 w-4 text-brand" />
                  <span className="text-[13px] font-medium">Active Agent</span>
                </div>
                <ul className="divide-y">
                  {FEED.map((e) => (
                    <li key={e.title} className="flex items-start gap-3 px-4 py-3">
                      <span className="text-lg leading-none">{e.emoji}</span>
                      <div className="min-w-0">
                        <div className="text-[13.5px] font-medium">{e.title}</div>
                        <div className="text-[12px] text-muted-foreground">{e.meta}</div>
                      </div>
                      <span
                        className={cn(
                          'ml-auto mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
                          e.tone === 'brand' ? 'bg-brand' : 'bg-muted-foreground/30',
                        )}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
          </div>
        </Section>

        {/* ──────────────────────── Differentiators ──────────────────────── */}
        <section className="border-t bg-muted/20 py-16 sm:py-24">
          <Container>
            <div className="mx-auto max-w-2xl text-center">
              <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-brand">Why Lntera</div>
              <h2 className="text-2xl font-semibold tracking-tight sm:text-4xl">Built for sellers, priced like a tool</h2>
            </div>
            <div className="mx-auto mt-12 grid max-w-4xl gap-x-8 gap-y-6 sm:grid-cols-2">
              {DIFFERENTIATORS.map((d) => (
                <div key={d.title} className="flex gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
                    <d.icon className="h-4 w-4" />
                  </div>
                  <div>
                    <h3 className="text-[15px] font-semibold">{d.title}</h3>
                    <p className="mt-1 text-[13.5px] leading-relaxed text-muted-foreground">{d.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </Container>
        </section>

        {/* ──────────────────────── Final CTA ──────────────────────── */}
        <Section>
          <div className="relative overflow-hidden rounded-3xl border bg-card px-6 py-14 text-center shadow-sm sm:px-12">
            <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
              <div className="absolute left-1/2 top-1/2 h-[300px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand/10 blur-3xl" />
            </div>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-4xl">Bring your own key. Start free.</h2>
            <p className="mx-auto mt-3 max-w-md text-[15px] leading-relaxed text-muted-foreground">
              Create your workspace, connect a shop, and put your storefront on autopilot today.
            </p>
            <div className="mt-7 flex justify-center">
              <Button onClick={scrollToForm}>
                Get started
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </Section>
      </main>

      <LandingFooter />
    </div>
  );
}
