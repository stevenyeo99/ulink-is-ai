# Project Setup

## Prerequisites
- Node.js and npm installed.
- (For PDF inputs) Poppler and Ghostscript available in PATH.
  ```bash
  sudo apt-get update
  sudo apt-get install -y poppler-utils ghostscript
  which pdftoppm
  which gs
  ```

## Install
```bash
npm install
cp .env.example .env
```
Set `PORT` and `DEBUG` as needed.

## Run
- Prod-style: `npm start` (entry: `src/bin/www`)
- Dev (WSL-friendly autoreload): `npm run dev` (`nodemon --legacy-watch`)

## PDF Handling Notes
- PDFs will be converted to 300 PPI JPEGs before OCR. Multi-page PDFs default to per-page images; adjust policy if needed (e.g., first N pages or merge).
- Conversion uses `pdftoppm` (Poppler) to render at 300 PPI, then re-encodes with `sharp` to stamp density metadata for OCR.
- Ensure temp/output storage has space for multi-page renders.
- If system binaries are not allowed, switch to a Node PDF rendering library and document the change here.
