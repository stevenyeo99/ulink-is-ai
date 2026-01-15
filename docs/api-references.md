# API References

## Health
- **GET** `/health`
- **Description**: Service liveness probe.
- **Response**: `200 OK`
- **Body**:
```json
{
  "status": "ok"
}
```

## Claims
- **POST** `/claim/provider_claim/json`
- **Description**: Accepts a list of file paths for provider claim OCR via LM Studio. Images are re-encoded to 300 PPI JPEGs; PDFs are rendered with `pdftoppm` at 300 PPI into per-page JPEGs (quality 90) before OCR.
- **Request Body**:
```json
{
  "paths": ["/path/to/image1.png", "/path/to/document.pdf"]
}
```
- **Response**: `202 Accepted` (conversion complete; OCR pending integration)
```json
{
  "message": "OCR request accepted; conversion completed; LLM OCR not yet implemented",
  "conversions": [
    {
      "inputPath": "/path/to/image1.png",
      "outputPath": "/tmp/claim-provider-claim/image1-<timestamp>-<rand>.jpg",
      "pageNumber": null,
      "status": "success",
      "error": null
    },
    {
      "inputPath": "/path/to/document.pdf",
      "outputPath": "/tmp/claim-provider-claim/document-<timestamp>-<rand>-1.jpg",
      "pageNumber": 1,
      "status": "success",
      "error": null
    }
  ]
}
```
- **POST** `/provider_claim/json/excel`
- **Description**: Accepts a provider claim JSON payload and saves an Excel workbook (Main Sheet, Document Source Summary, Validation Summary tabs). Column headers replace underscores with spaces. Returns the saved file path.

## Conventions
- Content type: `application/json` for requests/responses unless noted.
- Auth: not required for current endpoints; document when added.
- Versioning: unversioned; introduce `/v1` prefix when APIs expand.
- Errors: use HTTP status codes with JSON body `{ "error": "message" }`.
