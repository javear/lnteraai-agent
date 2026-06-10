import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Container } from './Container';

/** A landing `<section>` with consistent vertical rhythm and an optional centered heading block. */
export function Section({
  id,
  eyebrow,
  title,
  subtitle,
  className,
  containerClassName,
  children,
}: {
  id?: string;
  eyebrow?: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  className?: string;
  containerClassName?: string;
  children?: ReactNode;
}) {
  const headingId = id ? `${id}-title` : undefined;
  const hasHeading = Boolean(eyebrow || title || subtitle);
  return (
    <section
      id={id}
      aria-labelledby={title ? headingId : undefined}
      className={cn('py-16 sm:py-24', className)}
    >
      <Container className={containerClassName}>
        {hasHeading ? (
          <div className="mx-auto max-w-2xl text-center">
            {eyebrow ? (
              <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-brand">{eyebrow}</div>
            ) : null}
            {title ? (
              <h2 id={headingId} className="text-2xl font-semibold tracking-tight sm:text-4xl">
                {title}
              </h2>
            ) : null}
            {subtitle ? (
              <p className="mx-auto mt-3 max-w-xl text-[15px] leading-relaxed text-muted-foreground sm:text-base">
                {subtitle}
              </p>
            ) : null}
          </div>
        ) : null}
        {children}
      </Container>
    </section>
  );
}
