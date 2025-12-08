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

## Conventions
- Content type: `application/json` for requests/responses unless noted.
- Auth: not required for current endpoints; document when added.
- Versioning: unversioned; introduce `/v1` prefix when APIs expand.
- Errors: use HTTP status codes with JSON body `{ "error": "message" }`.
