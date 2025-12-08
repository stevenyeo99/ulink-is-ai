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
- **POST** `/claim/pre_approval/json`
- **Description**: Accepts a list of file paths for pre-approval OCR via LM Studio. Images are re-encoded to 300 PPI JPEGs; PDFs are rendered with `pdftoppm` at 300 PPI into per-page JPEGs (quality 90) before OCR.
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
      "outputPath": "/tmp/claim-preapproval/image1-<timestamp>-<rand>.jpg",
      "pageNumber": null,
      "status": "success",
      "error": null
    },
    {
      "inputPath": "/path/to/document.pdf",
      "outputPath": "/tmp/claim-preapproval/document-<timestamp>-<rand>-1.jpg",
      "pageNumber": 1,
      "status": "success",
      "error": null
    }
  ]
}
```

## Conventions
- Content type: `application/json` for requests/responses unless noted.
- Auth: not required for current endpoints; document when added.
- Versioning: unversioned; introduce `/v1` prefix when APIs expand.
- Errors: use HTTP status codes with JSON body `{ "error": "message" }`.
