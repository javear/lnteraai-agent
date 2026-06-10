/**
 * Verifies Discord table → bullet conversion.
 * Run: npx tsx scripts/verify-discord-markdown-sanitize.mjs
 */

function assert(cond, label) {
  if (!cond) {
    console.error('FAIL:', label);
    process.exit(1);
  }
}

const { sanitizeMarkdownTablesForDiscord } = await import(
  '../src/mastra/processors/discord-markdown-sanitize.ts'
);

const table = `Marketplace Order List

| Order ID | Platform | Status | Total | Created |
|----------|----------|--------|-------|---------|
| 583865982332471077 | TikTok | Shipped | 50,010 IDR | 2026-05-05 |
| 583867341493471013 | TikTok | Cancelled | 150,030 IDR | 2026-05-05 |`;

const out = sanitizeMarkdownTablesForDiscord(table);
assert(!out.includes('| Order'), 'table pipes removed');
assert(out.includes('583865982332471077'), 'order id preserved');
assert(out.includes('• **583865982332471077**'), 'row becomes bullet with bold id');
assert(out.includes('Platform: TikTok'), 'header labels on row fields');

const plain = 'Playground | not a table row alone';
assert(
  sanitizeMarkdownTablesForDiscord(plain) === plain,
  'single pipe line without table shape unchanged',
);

console.log('verify-discord-markdown-sanitize: OK');
