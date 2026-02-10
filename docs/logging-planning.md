# Logging Implementation Plan (Demo-Friendly, Non-IT Readable)

## Objective
Add clear, step-by-step backend logs so a non-technical audience can understand what happens for:
- `provider_claim`
- `pre_assestment_form`

The logs should explain:
1. Email intake
2. Attachment download/storage
3. Flow detection decision
4. Each major processing step and final outcome

## Current Flow (As Implemented Today)

### A) Email intake and storage
Current runtime path:
1. Connect IMAP and load unseen emails.
2. Parse each message.
3. Save email content and metadata to import folder.
4. Save all attachments.
5. Build `supportedAttachmentPaths` for claim processing.

Code references:
- `src/services/emailService.js:359`
- `src/services/emailService.js:220`

Current logging status:
- Partial. Most intake/storage steps are not logged with business-friendly text.

### B) Flow detection
Current runtime path:
1. Build decision input from subject/body/attachments.
2. Fast keyword routing for pre-assessment terms (`PAF`, `pre-admission`, etc.).
3. Otherwise use LLM decision.
4. Log selected action, reason, confidence.

Code references:
- `src/services/emailService.js:315`
- `src/services/emailService.js:427`

Current logging status:
- Good single summary log exists: `[email-decision]`.
- Missing explicit "why this path was selected" narrative for non-IT users.

### C) Pre-assessment processing
Current runtime path:
1. Start pre-assessment processing.
2. Convert attachments to PNG.
3. Run required-fields detection.
4. If required fields missing, return missing-docs workflow.
5. If complete, run OCR extraction.
6. Optional fallback extraction for hospital/doctor fields.
7. Save `PAF.json`, send reply, save `reply.json`.

Code references:
- `src/services/claimService.js:249`
- `src/services/claimService.js:341`
- `src/services/emailService.js:454`

Current logging status:
- Moderate detail exists for internal diagnostics.
- Not consistently phrased for business/demo audience.

### D) Provider-claim processing
Current runtime path:
1. Start provider-claim submission from attachment paths.
2. OCR and validation pass.
3. Check document completeness.
4. Call IAS member info.
5. Build payload and submit claim.
6. Save OCR/payload/excel outputs.
7. Send reply and save `reply.json`.

Code references:
- `src/services/claimService.js:1112`
- `src/services/claimService.js:94`
- `src/services/emailService.js:561`

Current logging status:
- Has technical logs (payload/result oriented).
- Missing plain-language stage logs and durations.

## Gaps to Address
1. No unified stage-based logging format across `emailService` and `claimService`.
2. Missing business-readable logs for attachment handling details (file count/type/size).
3. No consistent start/end + duration per stage.
4. LLM logging is too verbose/raw in some places and not demo-friendly.
5. No correlation identifier in all log lines for one email lifecycle.

## Proposed Logging Design

### 1) Standard event format
Use one JSON log envelope for all major steps:
- `event`: short event name (`email.received`, `flow.selected`, `preaf.required_fields.checked`)
- `message`: human-readable sentence for demo
- `request_id`: per-email correlation id
- `email_uid`, `subject`, `action`
- `status`: `start|success|warning|error`
- `duration_ms` (for completion logs)
- `details` (small structured object, no sensitive full payloads)

### 2) Required log points

Email intake:
- Start polling inbox
- Unseen email count
- Email parsed (from/subject/date)
- Attachment saved summary

Flow decision:
- Decision started
- Decision completed with selected action and reason

Pre-assessment flow:
- Pre-assessment started
- Image conversion result
- Required fields check result
- Missing required fields (if any)
- OCR extraction completed
- Reply prepared and sent

Provider-claim flow:
- Provider claim started
- OCR completed
- Document completeness check result
- IAS member lookup result
- Claim payload built
- Claim submission result
- Reply prepared and sent

### 3) Non-IT wording examples
- "We received a new email and started processing it."
- "3 attachments were downloaded and stored."
- "This email was identified as a Pre-Assessment Form request."
- "Required fields check completed. Missing: NRC or passport."
- "Provider claim was submitted to IAS successfully."

### 4) Guardrails
- Do not log full raw LLM responses in normal mode.
- Do not log full member NRC/passport values; mask sensitive fields.
- Keep business logs concise; keep raw/diagnostic logs behind debug mode.

## Implementation Plan
1. Add a small logging helper (`logEvent`) with consistent schema.
2. Add `request_id` at email start and pass through service calls.
3. Instrument `emailService` major stages:
   - IMAP fetch
   - parsed email summary
   - attachment persistence summary
   - decision and branch entry
4. Instrument `claimService` stages for:
   - `processPreAssessmentForm`
   - `submitProviderClaimFromPaths`
5. Replace high-noise raw logs in `llmService` with summarized logs (and debug-only raw output).
6. Verify by running one sample for each flow and confirming readable chronological logs.

## Acceptance Criteria
1. For one email, logs clearly show: intake -> decision -> selected flow -> major processing steps -> reply outcome.
2. Non-IT stakeholders can understand flow without reading code.
3. Sensitive fields are masked in logs.
4. Each major step includes success/failure and timing.
