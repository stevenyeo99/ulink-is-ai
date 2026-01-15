const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { promisify } = require('util');
const { execFile } = require('child_process');
const createDebug = require('debug');

const debug = createDebug('app:service:image');
const execFileAsync = promisify(execFile);

async function convertFilesToJpeg300ppi(paths) {
  const tempDir = path.join(os.tmpdir(), 'claim-provider-claim');
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

    if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
      results.push({
        inputPath,
        outputPath: inputPath,
        status: 'success',
        error: null,
      });
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

async function convertFilesToPng300dpi(paths) {
  const tempDir = path.join(os.tmpdir(), 'claim-member-claim');
  await fs.promises.mkdir(tempDir, { recursive: true });

  const results = [];

  for (const inputPath of paths) {
    const ext = path.extname(inputPath).toLowerCase();
    const base = path.basename(inputPath, ext);
    const uniqueId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const outputPrefix = path.join(tempDir, `${base}-${uniqueId}`);

    if (ext === '.pdf') {
      try {
        const pdfPages = await convertPdfToPngs(inputPath, outputPrefix);
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

    if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
      results.push({
        inputPath,
        outputPath: inputPath,
        status: 'success',
        error: null,
      });
      continue;
    }

    try {
      const outputPath = `${outputPrefix}.png`;
      await sharp(inputPath, { density: 300 })
        .withMetadata({ density: 300 })
        .png()
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

async function convertPdfToPngs(inputPath, outputPrefix) {
  debug('Converting PDF to 300 DPI PNG(s): %s', inputPath);

  try {
    await execFileAsync('pdftoppm', [
      '-r',
      '300',
      '-png',
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
    .filter((file) => file.startsWith(prefixBase) && file.endsWith('.png'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (pageFiles.length === 0) {
    throw new Error('pdftoppm produced no PNG pages (check Poppler install)');
  }

  const conversions = [];

  for (const fileName of pageFiles) {
    const outputPath = path.join(tempDir, fileName);
    const pageMatch = fileName.match(/-(\d+)\.png$/);
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
  convertFilesToJpeg300ppi,
  convertPdfToJpegs,
  convertFilesToPng300dpi,
  convertPdfToPngs,
};
