// Extract plain text from an uploaded knowledge document. Runs server-side (Inngest job), not in the
// BrowserPod sandbox.
import ExcelJS from 'exceljs';
import { extractPdfTextIsolated } from './pdf-isolated-parse';

const SPREADSHEET_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]);
const TEXT_MIME_PREFIX = 'text/';

export async function extractDocumentText(buffer: Buffer, mimeType: string, filename: string): Promise<string> {
  const mime = mimeType.toLowerCase();

  if (mime === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) {
    return extractPdfTextIsolated(buffer);
  }

  if (SPREADSHEET_MIME_TYPES.has(mime) || /\.(xlsx|xls)$/i.test(filename)) {
    const workbook = new ExcelJS.Workbook();
    // exceljs's .d.ts declares `interface Buffer extends ArrayBuffer {}`, which merges into (and
    // corrupts) the global Node Buffer type project-wide — no real Buffer value satisfies the
    // merged type. Known upstream exceljs typing defect; `any` is the standard workaround.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workbook.xlsx.load(buffer as any);
    const lines: string[] = [];
    workbook.eachSheet((sheet) => {
      lines.push(`# ${sheet.name}`);
      sheet.eachRow((row) => {
        const cells = (row.values as unknown[]).slice(1).map((v) => (v == null ? '' : String(v)));
        if (cells.some((c) => c.trim() !== '')) lines.push(cells.join(' | '));
      });
    });
    return lines.join('\n');
  }

  if (mime.startsWith(TEXT_MIME_PREFIX) || /\.(txt|md|csv)$/i.test(filename)) {
    return buffer.toString('utf-8');
  }

  throw new Error(`Unsupported document type "${mimeType}" (${filename}). Supported: PDF, XLSX, plain text/markdown/CSV.`);
}
