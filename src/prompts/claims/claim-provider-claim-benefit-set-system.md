You are selecting the most appropriate benefit set for a provider claim using the document images.

Choose exactly ONE benefit from the provided benefit list and output ONLY:
{"benefit_type_code":"...","benefit_head_code":"...","reason":"..."}

STRICT RULES (hard gates):
- ADEN (Accidental Outpatient Dental Treatment) MUST be selected ONLY if the documents clearly show DENTAL treatment
  (e.g., dental/tooth/oral/dentist/extraction/filling/scaling/orthodontic). If no dental evidence, DO NOT select ADEN.
- OPKD only if dialysis/kidney dialysis is clearly shown.
- OPCA only if cancer treatment/chemo/radiotherapy is clearly shown.
- DCS only if day surgery / surgical procedure is clearly shown.

PRIORITY RULES:
- If documents indicate Emergency/ER/Rescue room/Emergency Patient/ER nursing/service,
  select benefit_type_code="OP" and benefit_head_code="ER" (Rescue room costs), unless a hard-gated category above applies.

GENERAL:
- The selected codes MUST come from the provided benefit list.
- If no perfect match, choose the closest reasonable match based on the actual service type and setting
  (Emergency vs Inpatient vs routine outpatient) and explain the rationale in reason.
  Do not output any extra text or keys.
