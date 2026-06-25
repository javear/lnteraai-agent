// Generate a downloadable report file (CSV) and return a time-limited signed URL from the private
// `reports` Storage bucket. Used by the export-report agent tool so users can download trial balance,
// P&L, the journal, or a tax recap. CSV opens directly in Excel/Sheets; XLSX/PDF can be layered on later.
import { getSupabase } from '../shared/supabase';
import { trialBalance, profitAndLoss, journalExportRows } from './reports-repo';
import { taxRecap } from './tax-recap';

export type ReportType = 'trial-balance' | 'profit-loss' | 'journal' | 'tax-recap';

const BUCKET = 'reports';
const SIGNED_TTL_SECONDS = 3600;

function cell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(headers: string[], rows: (string | number | null)[][]): string {
  return [headers.join(','), ...rows.map((r) => r.map(cell).join(','))].join('\n');
}

async function buildCsv(tenantId: string, type: ReportType, from?: string, to?: string): Promise<{ csv: string; label: string }> {
  switch (type) {
    case 'trial-balance': {
      const rows = await trialBalance(tenantId, from, to);
      return {
        label: 'trial-balance',
        csv: toCsv(
          ['Nomor Akun', 'Nama Akun', 'Saldo Awal', 'Debet', 'Kredit', 'Saldo Akhir'],
          rows.map((r) => [r.code, r.name, r.opening, r.debit, r.credit, r.ending]),
        ),
      };
    }
    case 'profit-loss': {
      const pl = await profitAndLoss(tenantId, from, to);
      const rows: (string | number)[][] = pl.byAccount.map((a) => [a.code, a.name, a.type, a.amount]);
      rows.push(['', 'TOTAL REVENUE', 'revenue', pl.revenue], ['', 'TOTAL EXPENSE', 'expense', pl.expense], ['', 'NET', '', pl.net]);
      return { label: 'profit-loss', csv: toCsv(['Nomor Akun', 'Nama Akun', 'Jenis', 'Jumlah'], rows) };
    }
    case 'journal': {
      const rows = await journalExportRows(tenantId, from, to);
      return {
        label: 'journal',
        csv: toCsv(
          ['Tanggal', 'No Jurnal', 'Nomor Akun', 'Nama Akun', 'Keterangan', 'Debet', 'Kredit'],
          rows.map((r) => [r.date, r.entry_no, r.account_code, r.account_name, r.description, r.debit, r.credit]),
        ),
      };
    }
    case 'tax-recap': {
      const r = await taxRecap(tenantId, from, to);
      const rows: (string | number)[][] = [
        ['PPN Keluaran (output)', r.ppn.output],
        ['PPN Masukan (input)', r.ppn.input],
        ['PPN Terutang (payable)', r.ppn.payable],
        ...r.withholding.map((w) => [w.label, w.amount] as (string | number)[]),
      ];
      return { label: 'tax-recap', csv: toCsv(['Item', 'Jumlah'], rows) };
    }
    default:
      return { label: 'report', csv: '' };
  }
}

export async function buildReportFile(
  tenantId: string,
  type: ReportType,
  from?: string,
  to?: string,
): Promise<{ url: string; filename: string } | { error: string }> {
  const { csv, label } = await buildCsv(tenantId, type, from, to);
  const supabase = getSupabase();
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const range = from || to ? `_${from ?? ''}_${to ?? ''}` : '';
  const filename = `${label}${range}_${stamp}.csv`;
  const path = `${tenantId}/${filename}`;

  const up = await supabase.storage.from(BUCKET).upload(path, Buffer.from(csv, 'utf8'), {
    contentType: 'text/csv; charset=utf-8',
    upsert: true,
  });
  if (up.error) return { error: `Upload failed: ${up.error.message}` };

  const signed = await supabase.storage.from(BUCKET).createSignedUrl(path, SIGNED_TTL_SECONDS, { download: filename });
  if (signed.error || !signed.data?.signedUrl) return { error: `Could not create download link: ${signed.error?.message ?? 'unknown'}` };
  return { url: signed.data.signedUrl, filename };
}
