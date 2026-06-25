// Generate a downloadable report file (CSV / XLSX / PDF) and return a time-limited signed URL from the
// private `reports` Storage bucket. One structured data shape per report, rendered into the chosen format.
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { getSupabase } from '../shared/supabase';
import { trialBalance, profitAndLoss, journalExportRows } from './reports-repo';
import { taxRecap } from './tax-recap';

export type ReportType = 'trial-balance' | 'profit-loss' | 'journal' | 'tax-recap';
export type ReportFormat = 'csv' | 'xlsx' | 'pdf';

const BUCKET = 'reports';
const SIGNED_TTL_SECONDS = 3600;

interface ReportData {
  label: string;
  title: string;
  subtitle?: string;
  headers: string[];
  rows: (string | number | null)[][];
}

async function buildReportData(tenantId: string, type: ReportType, from?: string, to?: string): Promise<ReportData> {
  const period = from || to ? `Period: ${from ?? '…'} → ${to ?? 'now'}` : 'All time';
  switch (type) {
    case 'trial-balance': {
      const rows = await trialBalance(tenantId, from, to);
      return {
        label: 'trial-balance',
        title: 'Neraca Saldo / Trial Balance',
        subtitle: period,
        headers: ['Nomor Akun', 'Nama Akun', 'Saldo Awal', 'Debet', 'Kredit', 'Saldo Akhir'],
        rows: rows.map((r) => [r.code, r.name, r.opening, r.debit, r.credit, r.ending]),
      };
    }
    case 'profit-loss': {
      const pl = await profitAndLoss(tenantId, from, to);
      const rows: (string | number)[][] = pl.byAccount.map((a) => [a.code, a.name, a.type, a.amount]);
      rows.push(['', 'TOTAL REVENUE', 'revenue', pl.revenue], ['', 'TOTAL EXPENSE', 'expense', pl.expense], ['', 'NET', '', pl.net]);
      return { label: 'profit-loss', title: 'Laba Rugi / Profit & Loss', subtitle: period, headers: ['Nomor Akun', 'Nama Akun', 'Jenis', 'Jumlah'], rows };
    }
    case 'journal': {
      const rows = await journalExportRows(tenantId, from, to);
      return {
        label: 'journal',
        title: 'Jurnal / Journal Entries',
        subtitle: period,
        headers: ['Tanggal', 'No Jurnal', 'Nomor Akun', 'Nama Akun', 'Keterangan', 'Debet', 'Kredit'],
        rows: rows.map((r) => [r.date, r.entry_no, r.account_code, r.account_name, r.description, r.debit, r.credit]),
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
      return { label: 'tax-recap', title: 'Rekap Pajak / Tax Recap', subtitle: `${period}${r.npwp ? ` · NPWP ${r.npwp}` : ''}`, headers: ['Item', 'Jumlah'], rows };
    }
    default:
      return { label: 'report', title: 'Report', headers: [], rows: [] };
  }
}

function cell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function renderCsv(d: ReportData): Buffer {
  const lines = [d.headers.join(','), ...d.rows.map((r) => r.map(cell).join(','))];
  return Buffer.from(lines.join('\n'), 'utf8');
}

async function renderXlsx(d: ReportData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(d.label);
  ws.addRow([d.title]).font = { bold: true, size: 13 };
  if (d.subtitle) ws.addRow([d.subtitle]).font = { color: { argb: 'FF666666' }, size: 9 };
  ws.addRow([]);
  ws.addRow(d.headers).font = { bold: true };
  for (const r of d.rows) ws.addRow(r.map((c) => (c === null || c === undefined ? '' : c)));
  d.headers.forEach((h, i) => {
    let max = h.length;
    for (const r of d.rows) max = Math.max(max, String(r[i] ?? '').length);
    ws.getColumn(i + 1).width = Math.min(max + 2, 60);
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function renderPdf(d: ReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 36, size: 'A4', layout: d.headers.length > 4 ? 'landscape' : 'portrait' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const colW = pageW / Math.max(d.headers.length, 1);

    doc.fontSize(14).font('Helvetica-Bold').text(d.title);
    if (d.subtitle) doc.fontSize(9).font('Helvetica').fillColor('#666666').text(d.subtitle);
    doc.fillColor('#000000').moveDown(0.5);

    const drawRow = (cells: (string | number | null)[], bold: boolean) => {
      if (doc.y > doc.page.height - doc.page.margins.bottom - 16) {
        doc.addPage();
      }
      const y = doc.y;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
      cells.forEach((c, i) => doc.text(c === null || c === undefined ? '' : String(c), left + i * colW, y, { width: colW - 4, ellipsis: true }));
      doc.y = y + 14;
    };
    drawRow(d.headers, true);
    doc.moveTo(left, doc.y).lineTo(left + pageW, doc.y).stroke();
    doc.moveDown(0.2);
    for (const r of d.rows) drawRow(r, false);
    doc.end();
  });
}

const FORMAT_META: Record<ReportFormat, { ext: string; contentType: string }> = {
  csv: { ext: 'csv', contentType: 'text/csv' },
  xlsx: { ext: 'xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  pdf: { ext: 'pdf', contentType: 'application/pdf' },
};

export async function buildReportFile(
  tenantId: string,
  type: ReportType,
  format: ReportFormat,
  from?: string,
  to?: string,
): Promise<{ url: string; filename: string } | { error: string }> {
  const data = await buildReportData(tenantId, type, from, to);
  let buf: Buffer;
  try {
    buf = format === 'xlsx' ? await renderXlsx(data) : format === 'pdf' ? await renderPdf(data) : renderCsv(data);
  } catch (err) {
    return { error: `Could not render ${format.toUpperCase()}: ${err instanceof Error ? err.message : 'unknown'}` };
  }

  const meta = FORMAT_META[format];
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const range = from || to ? `_${from ?? ''}_${to ?? ''}` : '';
  const filename = `${data.label}${range}_${stamp}.${meta.ext}`;
  const path = `${tenantId}/${filename}`;

  const supabase = getSupabase();
  const up = await supabase.storage.from(BUCKET).upload(path, buf, { contentType: meta.contentType, upsert: true });
  if (up.error) return { error: `Upload failed: ${up.error.message}` };
  const signed = await supabase.storage.from(BUCKET).createSignedUrl(path, SIGNED_TTL_SECONDS, { download: filename });
  if (signed.error || !signed.data?.signedUrl) return { error: `Could not create download link: ${signed.error?.message ?? 'unknown'}` };
  return { url: signed.data.signedUrl, filename };
}
