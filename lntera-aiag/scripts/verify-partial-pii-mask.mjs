/**
 * Verifies partial/full PII masking helpers.
 * Run: npx tsx scripts/verify-partial-pii-mask.mjs
 */

function assert(cond, label) {
  if (!cond) {
    console.error('FAIL:', label);
    process.exit(1);
  }
}

function assertSameLength(original, masked, label) {
  assert(masked.length === original.length, `${label}: masked length matches original`);
}

const { getPiiMaskChar } = await import('../src/mastra/agents/agent-redaction-normalize.ts');
const {
  applyPartialPiiMask,
  applyFullPiiMask,
  applyPiiMask,
} = await import('../src/mastra/agents/partial-pii-mask.ts');

const m = getPiiMaskChar();
const m3 = m.repeat(3);

assert(m !== '*', 'default mask char is not asterisk (Discord markdown safe)');

assert(
  applyPartialPiiMask('andrew@gmail.com') === `a${m3}@${m3}.c${m.repeat(2)}`,
  'partial email andrew@gmail.com (.com → c··)',
);

assert(
  applyPartialPiiMask('andrew@example.co.id') === `a${m3}@${m3}.c${m.repeat(4)}`,
  'partial email co.id TLD',
);

const phone = '081234567771';
const email = 'alice@example.com';
const combined = `call ${phone} for ${email}`;

const partialCombined = applyPartialPiiMask(combined);
assert(
  partialCombined === `call 08${m.repeat(6)}7771 for a${m3}@${m3}.c${m.repeat(2)}`,
  'partial phone + email',
);
assertSameLength(phone, `08${m.repeat(6)}7771`, 'partial phone');
assert(applyPartialPiiMask(email) === `a${m3}@${m3}.c${m.repeat(2)}`, 'partial alice@example.com');

const ssn = '123-45-6789';
const partialSsn = applyPartialPiiMask(`SSN ${ssn}`);
assert(partialSsn === `SSN ${m.repeat(3)}-${m.repeat(2)}-6789`, 'partial SSN');
assertSameLength(ssn, `${m.repeat(3)}-${m.repeat(2)}-6789`, 'partial SSN token');

const card = '4111-1111-1111-1234';
const partialCard = applyPartialPiiMask(`card ${card}`);
const maskedCard = `${m.repeat(4)}-${m.repeat(4)}-${m.repeat(4)}-1234`;
assert(partialCard === `card ${maskedCard}`, 'partial credit card');
assertSameLength(card, maskedCard, 'partial card token');

const usPhone = '(555) 123-4567';
const partialUs = applyPartialPiiMask(`US ${usPhone}`);
const maskedUs = `(55${m}) ${m.repeat(3)}-4567`;
assert(partialUs === `US ${maskedUs}`, 'partial US phone');
assertSameLength(usPhone, maskedUs, 'partial US phone token');

const fullCombined = applyFullPiiMask(`${phone} ${email}`);
assert(
  fullCombined === `${m.repeat(phone.length)} ${m.repeat(email.length)}`,
  'full mask uses length-matched mask char',
);

assert(applyPiiMask(phone, 'partial') === `08${m.repeat(6)}7771`, 'applyPiiMask partial mode');
assert(applyPiiMask(phone, 'full') === m.repeat(phone.length), 'applyPiiMask full mode');

assert(
  applyPartialPiiMask('583861234561077') === '583861234561077',
  'order ids are not phone-masked',
);
assert(
  applyPartialPiiMask('| 583861234561077 | TikTok |') === '| 583861234561077 | TikTok |',
  'order ids in table-like text stay intact',
);

console.log('verify-partial-pii-mask: OK');
