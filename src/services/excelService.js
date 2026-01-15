const XLSX = require('xlsx');

function formatHeader(key) {
  return String(key || '').replace(/_/g, ' ').trim();
}

function mapRowWithHeaders(row, headers) {
  const mapped = {};
  for (const key of headers) {
    mapped[formatHeader(key)] = row[key] ?? '';
  }
  return mapped;
}

function buildSheetFromObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return XLSX.utils.aoa_to_sheet([]);
  }
  const headers = Object.keys(obj);
  const row = mapRowWithHeaders(obj, headers);
  return XLSX.utils.json_to_sheet([row], { header: headers.map(formatHeader) });
}

function buildSheetFromArray(rows, defaultHeaders = []) {
  if (!Array.isArray(rows) || rows.length === 0) {
    if (!defaultHeaders.length) {
      return XLSX.utils.aoa_to_sheet([]);
    }
    const headerRow = defaultHeaders.map(formatHeader);
    return XLSX.utils.aoa_to_sheet([headerRow]);
  }
  const headers = Object.keys(rows[0]);
  const mappedRows = rows.map((row) => mapRowWithHeaders(row || {}, headers));
  return XLSX.utils.json_to_sheet(mappedRows, { header: headers.map(formatHeader) });
}

function buildProviderClaimWorkbook(payload) {
  const mainSheet = payload?.main_sheet || {};
  const documentSourceSummary = payload?.document_source_summary || {};
  const validationSummary = payload?.validation_summary || [];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, buildSheetFromObject(mainSheet), 'Main Sheet');
  XLSX.utils.book_append_sheet(
    workbook,
    buildSheetFromObject(documentSourceSummary),
    'Document Source Summary'
  );
  XLSX.utils.book_append_sheet(
    workbook,
    buildSheetFromArray(validationSummary, [
      'patient',
      'item',
      'prescribed_tested',
      'validation_result',
      'dx_treatment_consistency',
      'notes',
    ]),
    'Validation Summary'
  );

  return XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
}

async function saveProviderClaimWorkbook(payload, { dir, filename }) {
  if (!dir) {
    throw new Error('dir is required to save provider claim workbook');
  }
  const buffer = buildProviderClaimWorkbook(payload);
  const safeName = filename || `provider-claim-${Date.now()}.xlsx`;
  const filePath = require('path').join(dir, safeName);
  await require('fs').promises.mkdir(dir, { recursive: true });
  await require('fs').promises.writeFile(filePath, buffer);
  return filePath;
}

module.exports = {
  buildProviderClaimWorkbook,
  saveProviderClaimWorkbook,
};
