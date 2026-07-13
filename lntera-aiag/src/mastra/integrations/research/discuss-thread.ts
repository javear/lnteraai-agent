// Dedicated per-report follow-up chat thread — mirrors notificationsThreadId's stable synthetic id
// pattern (web-delivery.ts), seeded with the report's own content so a follow-up question is grounded
// without the agent re-deriving everything from scratch. Reuses the normal chat UI/general agent —
// this is NOT a separate chat surface, just a distinct threadId scoped to one report.
import { randomUUID } from 'node:crypto';
import type { MastraDBMessage } from '@mastra/core/agent';
import type { ResearchReport } from './reports-repo';

export function researchDiscussThreadId(reportId: string): string {
  return `research:${reportId}`;
}

/** Ensures the thread exists and (if brand new) seeds it with a briefing assistant message summarizing
 *  the report — so the general agent's own thread memory already has the report's sections/citations
 *  as prior context by the time the user's first follow-up question arrives. */
export async function ensureResearchDiscussThread(tenantId: string, report: ResearchReport): Promise<string> {
  const threadId = researchDiscussThreadId(report.id);
  // Dynamic import — same general-agent -> ... -> (this module) circular-dependency risk web-delivery.ts
  // already works around; general-agent pulls in tools that could reach back into this file.
  const { generalAgent } = await import('../../agents/general-agent');
  const memory = await generalAgent.getMemory();
  if (!memory) return threadId;

  const existing = await memory.getThreadById({ threadId }).catch(() => null);
  if (existing) return threadId;

  await memory.saveThread({
    thread: {
      id: threadId,
      resourceId: tenantId,
      title: report.topic,
      metadata: { channel: 'web', kind: 'research-report', reportId: report.id },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });

  const message: MastraDBMessage = {
    id: randomUUID(),
    role: 'assistant',
    createdAt: new Date(),
    threadId,
    resourceId: tenantId,
    content: {
      format: 2,
      parts: [{ type: 'text', text: briefingText(report) }],
      metadata: { channel: 'web', source: 'research-report-briefing' },
    },
  };
  await memory.saveMessages({ messages: [message] });
  return threadId;
}

function briefingText(report: ResearchReport): string {
  const content = report.content;
  if (!content) return `Here's your research report on "${report.topic}". Ask me anything about it.`;
  const sections = content.sections.map((s) => `**${s.heading}**\n${s.body}`).join('\n\n');
  const citations =
    content.citations.length > 0
      ? `\n\nSources:\n${content.citations.map((c) => `- ${c.title}: ${c.url}`).join('\n')}`
      : '';
  return `Here's your research report on "${report.topic}":\n\n${sections}${citations}\n\nAsk me anything about it — I can dig deeper or search for more.`;
}
