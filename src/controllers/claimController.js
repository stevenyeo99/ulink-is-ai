const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { promisify } = require('util');
const { execFile } = require('child_process');
const createDebug = require('debug');

const debug = createDebug('app:controller:claim');
const execFileAsync = promisify(execFile);

async function preApprovalJson(req, res) {
  const { paths } = req.body || {};

  if (!Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: 'paths must be a non-empty array of file paths' });
  }

  debug('Received pre-approval OCR request for %d paths', paths.length);

  try {
    const conversions = await convertFilesToJpeg300ppi(paths);

    // TODO: Integrate with LM Studio OCR processing using `conversions.outputPath`.
    return res.status(202).json({
      message: 'OCR request accepted; conversion completed; LLM OCR not yet implemented',
      conversions,
    });
  } catch (error) {
    debug('Conversion error: %s', error.message);
    return res.status(500).json({ error: 'Failed to prepare files for OCR', detail: error.message });
  }
}

async function convertFilesToJpeg300ppi(paths) {
  const tempDir = path.join(os.tmpdir(), 'claim-preapproval');
  await fs.promises.mkdir(tempDir, { recursive: true });

  const results = [];

  for (const inputPath of paths) {
    const ext = path.extname(inputPath).toLowerCase();
    const base = path.basename(inputPath, ext);
    const uniqueId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const outputPrefix = path.join(tempDir, `${base}-${uniqueId}`);

    if (ext === '.pdf') {
      try {
        const pdfPages = await convertPdfToJpegs(inputPath, outputPrefix);
        results.push(...pdfPages);
      } catch (error) {
        results.push({
          inputPath,
          outputPath: null,
          status: 'error',
          error: error.message,
        });
      }
      continue;
    }

    try {
      const outputPath = `${outputPrefix}.jpg`;
      await sharp(inputPath, { density: 300 })
        .withMetadata({ density: 300 })
        .jpeg({ quality: 90 })
        .toFile(outputPath);

      results.push({
        inputPath,
        outputPath,
        status: 'success',
        error: null,
      });
    } catch (error) {
      results.push({
        inputPath,
        outputPath: null,
        status: 'error',
        error: error.message,
      });
    }
  }

  return results;
}

async function convertPdfToJpegs(inputPath, outputPrefix) {
  debug('Converting PDF to 300 PPI JPEG(s): %s', inputPath);

  try {
    await execFileAsync('pdftoppm', [
      '-r',
      '300',
      '-jpeg',
      '-jpegopt',
      'quality=90',
      inputPath,
      outputPrefix,
    ]);
  } catch (error) {
    const stderr = (error.stderr || '').toString().trim();
    const stdout = (error.stdout || '').toString().trim();
    const details = stderr || stdout || error.message;
    throw new Error(`pdftoppm failed: ${details}`);
  }

  const tempDir = path.dirname(outputPrefix);
  const prefixBase = path.basename(outputPrefix);
  const files = await fs.promises.readdir(tempDir);
  const pageFiles = files
    .filter((file) => file.startsWith(prefixBase) && file.endsWith('.jpg'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (pageFiles.length === 0) {
    throw new Error('pdftoppm produced no JPEG pages (check Poppler install)');
  }

  const conversions = [];

  for (const fileName of pageFiles) {
    const outputPath = path.join(tempDir, fileName);
    // Re-encode to stamp 300 PPI metadata for downstream OCR hints.
    await sharp(outputPath)
      .withMetadata({ density: 300 })
      .jpeg({ quality: 90 })
      .toFile(outputPath);

    const pageMatch = fileName.match(/-(\d+)\.jpg$/);
    conversions.push({
      inputPath,
      outputPath,
      pageNumber: pageMatch ? Number(pageMatch[1]) : null,
      status: 'success',
      error: null,
    });
  }

  return conversions;
}

module.exports = {
  preApprovalJson,
};
