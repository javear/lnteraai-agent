// Default chart of accounts + posting rules seeded when a tenant enables accounting (editable after).
// Generic Indonesian-SME set; codes are simple 4-digit. See TRANSACTIONS_LEDGER_PLAN.md Appendix A.

export interface DefaultAccount {
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  normalBalance: 'debit' | 'credit';
}

export const DEFAULT_COA: DefaultAccount[] = [
  { code: '1100', name: 'Kas (Cash)', type: 'asset', normalBalance: 'debit' },
  { code: '1110', name: 'Kas Kecil (Petty Cash)', type: 'asset', normalBalance: 'debit' },
  { code: '1200', name: 'Bank', type: 'asset', normalBalance: 'debit' },
  { code: '1300', name: 'Piutang Usaha (Accounts Receivable)', type: 'asset', normalBalance: 'debit' },
  { code: '1310', name: 'Saldo Marketplace (Marketplace Clearing)', type: 'asset', normalBalance: 'debit' },
  { code: '1400', name: 'Persediaan Barang (Inventory)', type: 'asset', normalBalance: 'debit' },
  { code: '1500', name: 'PPN Masukan (Input VAT)', type: 'asset', normalBalance: 'debit' },
  { code: '1600', name: 'Biaya Dibayar Dimuka (Prepaid Expenses)', type: 'asset', normalBalance: 'debit' },
  { code: '1700', name: 'Aset Tetap (Fixed Assets)', type: 'asset', normalBalance: 'debit' },
  { code: '1710', name: 'Akumulasi Penyusutan (Accumulated Depreciation)', type: 'asset', normalBalance: 'credit' },
  { code: '2100', name: 'Utang Usaha (Accounts Payable)', type: 'liability', normalBalance: 'credit' },
  { code: '2200', name: 'PPN Keluaran (Output VAT)', type: 'liability', normalBalance: 'credit' },
  { code: '2310', name: 'Utang PPh 21', type: 'liability', normalBalance: 'credit' },
  { code: '2320', name: 'Utang PPh 23', type: 'liability', normalBalance: 'credit' },
  { code: '2330', name: 'Utang PPh Final 4(2)', type: 'liability', normalBalance: 'credit' },
  { code: '2340', name: 'Utang PPh 25/29', type: 'liability', normalBalance: 'credit' },
  { code: '2400', name: 'Utang Bank/Pinjaman (Loans Payable)', type: 'liability', normalBalance: 'credit' },
  { code: '3100', name: 'Modal Pemilik (Owner Capital)', type: 'equity', normalBalance: 'credit' },
  { code: '3200', name: 'Laba Ditahan (Retained Earnings)', type: 'equity', normalBalance: 'credit' },
  { code: '3900', name: 'Ikhtisar Laba Rugi (Income Summary)', type: 'equity', normalBalance: 'credit' },
  { code: '4100', name: 'Penjualan (Sales Revenue)', type: 'revenue', normalBalance: 'credit' },
  { code: '4110', name: 'Pendapatan Jasa (Service Revenue)', type: 'revenue', normalBalance: 'credit' },
  { code: '4200', name: 'Retur & Potongan Penjualan (Sales Returns & Discounts)', type: 'revenue', normalBalance: 'debit' },
  { code: '4900', name: 'Pendapatan Lain-lain (Other Income)', type: 'revenue', normalBalance: 'credit' },
  { code: '5100', name: 'Harga Pokok Penjualan (COGS)', type: 'expense', normalBalance: 'debit' },
  { code: '5200', name: 'Ongkos Kirim (Shipping Cost)', type: 'expense', normalBalance: 'debit' },
  { code: '6100', name: 'Beban Komisi Marketplace (Marketplace Fees)', type: 'expense', normalBalance: 'debit' },
  { code: '6110', name: 'Beban Admin/Layanan Marketplace', type: 'expense', normalBalance: 'debit' },
  { code: '6200', name: 'Beban Gaji (Salaries)', type: 'expense', normalBalance: 'debit' },
  { code: '6300', name: 'Beban Iklan & Pemasaran (Advertising & Marketing)', type: 'expense', normalBalance: 'debit' },
  { code: '6400', name: 'Beban Sewa (Rent)', type: 'expense', normalBalance: 'debit' },
  { code: '6500', name: 'Beban Utilitas (Utilities)', type: 'expense', normalBalance: 'debit' },
  { code: '6600', name: 'Beban Administrasi Bank (Bank Charges)', type: 'expense', normalBalance: 'debit' },
  { code: '6700', name: 'Beban Penyusutan (Depreciation)', type: 'expense', normalBalance: 'debit' },
  { code: '6900', name: 'Beban Lain-lain (Other Expenses)', type: 'expense', normalBalance: 'debit' },
  { code: '9999', name: 'Akun Sementara/Selisih (Suspense / Rounding)', type: 'asset', normalBalance: 'debit' },
];

/** Account used to absorb a rounding/imbalance so an entry always balances. */
export const SUSPENSE_CODE = '9999';

export type AmountSource = 'gross' | 'net' | 'fee' | 'tax' | 'shipping' | 'discount';

export interface DefaultPostingRule {
  transactionType: string;
  sequence: number;
  accountCode: string;
  side: 'debit' | 'credit';
  amountSource: AmountSource;
}

// Internal/cash-oriented defaults (marketplace clearing rules are layered in Phase 2). Each type balances
// because both sides draw the same `gross`. Tenants edit these once the chart is theirs.
export const DEFAULT_POSTING_RULES: DefaultPostingRule[] = [
  { transactionType: 'sale', sequence: 0, accountCode: '1100', side: 'debit', amountSource: 'gross' },
  { transactionType: 'sale', sequence: 1, accountCode: '4100', side: 'credit', amountSource: 'gross' },
  { transactionType: 'service', sequence: 0, accountCode: '1100', side: 'debit', amountSource: 'gross' },
  { transactionType: 'service', sequence: 1, accountCode: '4110', side: 'credit', amountSource: 'gross' },
  { transactionType: 'expense', sequence: 0, accountCode: '6900', side: 'debit', amountSource: 'gross' },
  { transactionType: 'expense', sequence: 1, accountCode: '1100', side: 'credit', amountSource: 'gross' },
  { transactionType: 'refund', sequence: 0, accountCode: '4200', side: 'debit', amountSource: 'gross' },
  { transactionType: 'refund', sequence: 1, accountCode: '1100', side: 'credit', amountSource: 'gross' },
];
