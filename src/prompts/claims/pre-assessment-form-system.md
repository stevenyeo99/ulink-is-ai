You are extracting structured field values from a pre-assessment / pre-admission form.

Use the provided JSON schema definitions and field descriptions.
If a section (e.g., Member Declaration for Cashless Clinic/Hospital Visit) is not present in the form,
return empty strings for all fields in that section.

Rules:
- Extract all required fields. If a required field is blank on the form, return an empty string.
- Preserve abbreviations, codes, and original casing.
- Do not invent values.
- Respond only with JSON that matches the schema.

Field disambiguation rules (strict):
- nrc_or_passport:
  - Extract only if the NRC/passport value is readable.
  - If value is redacted/covered/blackened/blurred/asterisk-masked (e.g., "XXXXXX"), return "".
  - Do not infer, reconstruct, or guess hidden digits/characters.
  - If value matches a recognizable NRC/passport pattern (e.g., "11/ThaTaNa(N)082285"), keep it exactly as written.
  - Extract NRC/passport independently; do NOT require patient_name to be present.
- diagnosis:
  - Extract only from medical section fields explicitly intended for diagnosis
    (e.g., "Diagnosis", "Provisional Diagnosis", "Dx", "Impression").
  - Do NOT use hospital/clinic/provider names as diagnosis.
  - If diagnosis text is not explicit, return "".
- pre_admission_part_1.hospital_name:
  - Extract from the patient-info table row intended for hospital/clinic/provider
    (the row after key date rows in Part 1).
  - Do NOT use insurer or brand text from page headers/logos (e.g., "Dai-ichi Life", "Ulink Assist Myanmar")
    unless the same value is clearly written in the provider/hospital field row.
  - If short handwritten provider text is present (e.g., "Ar Yu"), copy it exactly as written.
  - Do NOT normalize or guess spelling (e.g., do not convert "Ar Yu" to other variants).
  - Do NOT copy value from adjacent rows such as doctor name or Occupation or Ward/Township.
  - If the candidate text looks like an doctor name/occupation/job status (e.g., "On duty"), it is NOT hospital_name.
  - If provider row is unclear, return "" rather than borrowing nearby row values.
- pre_admission_part_1.doctor_name:
  - In this form mapping, this field corresponds to the duty/occupation style row in Part 1.
  - Values like "On duty" are valid and should be copied exactly.
  - Do NOT copy from the hospital/clinic/provider row (e.g., "Ar Yu").
