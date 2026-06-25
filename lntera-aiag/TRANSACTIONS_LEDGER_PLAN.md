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
- **Feature gating:** **transaction recording is always on** for every tenant. **Advanced finance
  (accounting ledger + tax) is an opt-in per-tenant toggle** (default OFF) — not every business needs it.

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

## 9. Feature gating
- **Always on:** transaction recording/sync (Phases 1–2) for every tenant — the canonical record is the
  foundation and useful standalone.
- **Opt-in (default OFF):** advanced finance — the posting engine, journal/trial-balance, and tax
  (Phases 3–5). Gated by **`tenant_finance_settings.accounting_enabled`** (+ later `base_currency`,
  `fiscal_year_start`). Toggle via settings UI **and** a `configure-finance` AI tool.
- **OFF:** transactions accumulate, no journal entries. **ON:** seed the COA + optionally **backfill-post**
  existing transactions, or post from then on. Tax sits under accounting (needs the ledger), so it's only
  available when accounting is ON.

## 10. Still needed to refine (not blocking Phase 1)
- **Settlement feed** specifics per platform (Shopee/TikTok statement APIs + fields).
- **Coretax import sample** for the first tax document to support.

## Appendix A — Default chart of accounts (Indonesian SME)
Seeded per tenant when accounting is enabled; fully editable (tenants mirroring OWL just renumber).
Simple 4-digit codes; Indonesian names (English in parens). Accounts referenced by the default posting
rules are marked ★.

| Code | Nama Akun | Type | Normal |
|---|---|---|---|
| 1100 | Kas (Cash) | asset | debit |
| 1110 | Kas Kecil (Petty Cash) | asset | debit |
| 1200 | ★ Bank | asset | debit |
| 1300 | Piutang Usaha (Accounts Receivable) | asset | debit |
| 1310 | ★ Saldo/Piutang Marketplace (clearing — funds held pending payout) | asset | debit |
| 1400 | Persediaan Barang (Inventory) | asset | debit |
| 1500 | PPN Masukan (Input VAT) | asset | debit |
| 1600 | Biaya Dibayar Dimuka (Prepaid Expenses) | asset | debit |
| 1700 | Aset Tetap (Fixed Assets) | asset | debit |
| 1710 | Akumulasi Penyusutan (Accumulated Depreciation) | asset (contra) | credit |
| 2100 | Utang Usaha (Accounts Payable) | liability | credit |
| 2200 | ★ PPN Keluaran (Output VAT) | liability | credit |
| 2310 | Utang PPh 21 | liability | credit |
| 2320 | Utang PPh 23 | liability | credit |
| 2330 | Utang PPh Final 4(2) | liability | credit |
| 2340 | Utang PPh 25/29 | liability | credit |
| 2400 | Utang Bank/Pinjaman (Loans payable) | liability | credit |
| 3100 | Modal Pemilik (Owner's Capital) | equity | credit |
| 3200 | Laba Ditahan (Retained Earnings) | equity | credit |
| 3900 | Ikhtisar Laba Rugi (Income Summary) | equity | credit |
| 4100 | ★ Penjualan (Sales Revenue) | revenue | credit |
| 4110 | Pendapatan Jasa (Service Revenue) | revenue | credit |
| 4200 | ★ Retur & Potongan Penjualan (Sales Returns & Discounts) | revenue (contra) | debit |
| 4900 | Pendapatan Lain-lain (Other Income) | revenue | credit |
| 5100 | Harga Pokok Penjualan (COGS) | expense | debit |
| 5200 | Ongkos Kirim (Shipping cost borne by seller) | expense | debit |
| 6100 | ★ Beban Komisi Marketplace (commission fees) | expense | debit |
| 6110 | Beban Admin/Layanan Marketplace | expense | debit |
| 6200 | Beban Gaji (Salaries) | expense | debit |
| 6300 | Beban Iklan & Pemasaran (Advertising & Marketing) | expense | debit |
| 6400 | Beban Sewa (Rent) | expense | debit |
| 6500 | Beban Utilitas (Utilities) | expense | debit |
| 6600 | Beban Administrasi Bank (Bank charges) | expense | debit |
| 6700 | Beban Penyusutan (Depreciation) | expense | debit |
| 6900 | Beban Lain-lain (Other Expenses) | expense | debit |
| 9999 | Akun Sementara/Selisih (Suspense / Rounding) | asset | debit |

**Default posting rules (settlement-aware — fees arrive separately from the order):**
- **Sale** (order `completed`): Dr 1310 (gross) / Cr 4100 (gross) [+ Cr 2200 if PPN].
- **Fee** (settlement): Dr 6100 / Cr 1310.
- **Refund**: Dr 4200 / Cr 1310 (or 1200).
- **Payout** (settlement): Dr 1200 / Cr 1310. → 1310 nets to ~0 per cycle (built-in reconciliation).
