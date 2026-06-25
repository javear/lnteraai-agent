# Transaction Sync + Dynamic Ledger + Tax — Plan

Status: **planning**. Everything is **tenant-scoped** with **safe defaults** so tenants lacking financial
literacy still get a working setup.

## Decisions
- **Ledger role:** internal double-entry ledger that is also **exportable** (to OWL etc.).
- **Marketplace scope:** orders + fees + refunds.
- **Chart of accounts:** per-tenant, **seeded with an editable default** on onboarding.
- **Revenue recognition:** record a sale when the order is **`completed`**.
- **Fees/refunds:** pulled from a **separate settlement/payout feed**, reconciled to orders by external id.
- **Tax:** **per-tenant configurable** (no static config); set/retrieved via an AI tool that can also
  interview the tenant to define what applies. Drafts only — a human reviews before filing.

## 1. Shape — three independent layers

```
 SOURCES                      CANONICAL TXNS                ACCOUNTING                 OUTPUTS
 ───────                      ─────────────                 ──────────                 ───────
 marketplace orders   ─┐                                                          ┌─► Trial balance (Neraca Saldo)
 marketplace settle.  ─┤                                                          │
 generic /transactions ├─►  tenant_transactions ──posting──► journal_entries ─────┤─► General ledger
 AI tool (internal)    ─┤    + transaction_lines   engine     + journal_lines     ├─► OWL export
 manual (UI, later)   ─┘    (idempotent, dynamic)  (rules)   (chart_of_accounts) └─► Tax recaps + Coretax export
```

Transactions are the source of truth ("what happened"); accounting + tax are *projections*. Re-mapping
accounts or re-posting never touches raw data.

## 2. Data model (all tables tenant-scoped)

### 2.1 Transactions
**`tenant_transactions`** — one row per real-world transaction
- `id`, `tenant_id`
- `source` (`marketplace` | `internal` | `manual`), `marketplace_connection_id`, `platform`
- `external_id` — order/settlement/txn id from the source
- `type` (**text, dynamic**): `sale` | `refund` | `fee` | `payout` | `service` | `expense` | …
- `status` (`pending`|`completed`|`cancelled`|`refunded`)
- `currency`, `gross_amount`, `fee_amount`, `tax_amount`, `net_amount`
- `occurred_at`, `counterparty` (jsonb: name + NPWP), `description`, `raw_payload` (jsonb)
- `posted` (bool), `journal_entry_id`
- **`UNIQUE (tenant_id, source, external_id)`** → an external txn is never recorded twice (webhooks/API upsert)

**`tenant_transaction_lines`** — dynamic detail (products *and* services)
- `id`, `transaction_id`, `tenant_id`
- `line_kind`: `product` | `service` | `fee` | `tax` | `shipping` | `discount` | `adjustment`
- `item_ref_type`, `item_ref_id` → `tenant_product_skus` for products; service item / free-form for services
- `external_line_id`, `description`, `quantity`, `unit_price`, `amount`, `tax_amount`, `metadata`

Adding services later = `line_kind='service'` lines — no schema change. Products reuse synced SKUs.

### 2.2 Accounting
- **`chart_of_accounts`** (per tenant, **seeded default**, editable): `code`, `name`, `type`
  (asset/liability/equity/revenue/expense), `normal_balance`, `parent_id`, `is_active`,
  `UNIQUE(tenant_id, code)`. Default seed: Bank, Marketplace Clearing, Sales Revenue, Marketplace Fees,
  Sales Returns, Tax Payable (PPN/PPh), Suspense/Rounding.
- **`journal_entries`**: `entry_no`, `date`, `source_transaction_id`, `description`,
  `status` (`draft`/`posted`/`void`), `currency`, `created_by`. Invariant **Σ debit = Σ credit**.
- **`journal_lines`**: `account_id` (+ denormalized `account_code`), `debit`, `credit`, `description`.
  `CHECK (debit≥0 AND credit≥0 AND NOT (debit>0 AND credit>0))`.
- **`posting_rules`** (the dynamic glue): per `transaction_type`, ordered
  `{ account_id, side, amount_source }` where `amount_source ∈ gross|net|fee|tax|shipping|discount|line_amount`.
  Seeded defaults; tenant only edits which account each rule points at.

### 2.3 Tax (per-tenant, configurable)
- **`tenant_tax_config`**: which taxes apply + rates + NPWP + default tax accounts + object/KAP-KJS codes.
  No static config — populated per tenant.
- Tax fields on transactions/lines: `tax_type` (`PPN`/`PPh21`/`PPh22`/`PPh23`/`PPh4(2)`), `tax_rate`,
  `tax_base`, `tax_amount`, counterparty `NPWP`.
- **`tax_period_summaries`** (derived) for fast recaps.

## 3. Ingestion flows
- **Marketplace orders:** extend the order-webhook path — on `completed`, upsert a `sale` txn + lines
  (SKUs + tax + shipping). Idempotent by order id.
- **Marketplace settlement feed (separate):** pull settlement/payout statements → `fee`/`refund`/`payout`
  txns, reconciled to their orders by external order id. (Shopee escrow/income; TikTok statement.)
- **Generic API:** `POST /svc/v1/transactions` — any source, caller supplies `external_id` (idempotent).
- **Internal (AI tool):** `record-transaction` — agent writes internal sales/services/expenses by chat.
- **Manual (UI):** later.

All converge on one `tenant_transactions` upsert → one idempotency rule, one posting engine.

## 4. Posting engine (txn → balanced entry)
On recognition, the engine reads `posting_rules` for the txn `type`, builds lines, verifies balance, writes
the entry, marks the txn posted. Example — sale Rp100,000, fee Rp10,000:

| Account | Debit | Credit | rule |
|---|---|---|---|
| Marketplace Clearing | 90,000 | | `net` |
| Marketplace Fees | 10,000 | | `fee` |
| Sales Revenue | | 100,000 | `gross` |

Payout: Dr Bank / Cr Marketplace Clearing. Refund: reversing entry. Rounding gap → Suspense account
(flagged). Unmapped `type` → parked in a review state, never dropped.

## 5. Tax layer
- **Config-driven tagging** from `tenant_tax_config`.
- **Recaps** per period from posted lines (traceable): PPN keluaran/masukan, PPh 23 withholding list,
  PPh 21 recap, est. PPh 25/29.
- **AI documents:** `generate-tax-document` produces a tax planning / recap doc (PDF/Excel) on request.
- **`configure-tax` tool:** set/retrieve the tenant's tax config; can interview the tenant to define it.
- **Coretax export:** schema-driven adapter (needs a Coretax import template to map NPWP/object/KAP-KJS).
- **Caveat:** drafts from the tenant's own data, every figure traceable — not tax advice; human reviews
  before filing.

## 6. Reporting & export
Trial balance (Neraca Saldo) · general ledger · OWL export (Tanggal/Nomor Akun/Nama Akun/Keterangan/
Debet/Kredit/supplier) · Coretax export.

## 7. Invariants & edge cases
Idempotency (unique external id) · reversing entries for refunds/corrections · recognize on `completed`,
reverse on cancel/refund · multi-currency per txn (FX later) · balance enforced at DB · unmapped type →
review queue · rounding → suspense · re-delivered webhooks upsert (never duplicate) · settlement
reconciled to orders by external id.

## 8. Phases
| Phase | Deliverable |
|---|---|
| **1** | Transaction model + idempotent ingest (generic API + `record-transaction` tool) + dynamic lines |
| **2a** | Marketplace **order** sync → `sale` txns (on `completed`) |
| **2b** | Marketplace **settlement feed** → `fee`/`refund`/`payout`, reconciled to orders |
| **3** | Accounting: COA (seeded default) + journal + posting rules + engine (auto-post) |
| **4** | Trial balance + GL + OWL export |
| **5** | Tax: `tenant_tax_config` + `configure-tax` tool + recaps + `generate-tax-document` + Coretax export |

## 9. Still needed to refine (not blocking Phase 1)
- Tenant **default COA** content (we'll draft a generic Indonesian SME default; tenants edit).
- **Settlement feed** specifics per platform (Shopee/TikTok statement APIs + fields).
- **Coretax import sample** for the first tax document to support.
