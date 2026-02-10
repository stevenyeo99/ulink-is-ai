You are checking whether the document set includes these required fields and their values:
- Patient name (patient only; do NOT use representative/guardian/relative name)
- NRC or passport
- Diagnosis
- Hospital or clinic name (also accept facility name; handwritten short names are valid, e.g. "Ar Yu"). You MUST copy the value EXACTLY as written. Do NOT normalize, correct spelling, or guess missing letters. If a short handwritten value (1–2 words) appears in a patient-info table and does not match patient name, NRC/passport, diagnosis, date, or signature, treat it as the hospital/clinic name even if the label is unclear or non-English.
- Admission date or appointment date (do NOT use representative/guardian/relative signature date)
- Signature (patient only; do NOT use representative/guardian/relative signature)
- Amount (optional; depends on insurer form)

Return ONLY a JSON object matching the schema with:
- patient_name_detected: true if a patient name value is clearly present (patient only; do NOT use representative/guardian/relative name).
- nrc_or_passport_detected: true only if the NRC/passport value itself is readable and not masked.
  - If the field exists but value is redacted/covered/blackened/blurred/asterisk-masked (e.g., "XXXXXX"), set nrc_or_passport_detected to false.
  - Judge masking/redaction ONLY from the NRC/passport value cell itself. Do NOT treat black bars/marks in other rows as NRC redaction.
  - If NRC/passport contains a recognizable ID pattern and is readable (even with minor scan noise), set nrc_or_passport_detected to true.
    Examples: "11/ThaTaNa(N)082285", "12/ABC(N)123456", passport-like alphanumeric IDs.
  - Set nrc_or_passport_detected to false only when the NRC/passport value itself is actually hidden/replaced (e.g., blacked out in that same cell, "XXXXXX", "*****", or unreadable blob).
  - Label text alone (e.g., only "NRC/passport" with no readable value) is not enough.
  - If a readable value matches common NRC/passport patterns, set true even if patient_name is missing.
  - Do not require patient_name_detected to be true before setting nrc_or_passport_detected.
- diagnosis_detected: true ONLY when diagnosis evidence is explicit and medically meaningful. Use true only if at least one of these is present:
  1) a field/label such as "Diagnosis", "Provisional Diagnosis", "Dx", or "Impression" with a value, or
  2) a clearly medical condition phrase (disease/injury/symptom) written as the diagnosis value.
  Strict exclusions for diagnosis_detected (must be false for these alone):
  - hospital/clinic/facility names (including short handwritten names like "Ar Yu", "Aryu"),
  - patient/provider/person names,
  - dates, IDs, signatures, policy/member numbers,
  - isolated short non-medical text (1-2 words) without diagnosis label/context.
  If diagnosis is not explicit, set diagnosis_detected to false.
- admission_date_detected: true if an admission date or appointment date value is clearly present (do NOT use representative/guardian/relative signature date).
- hospital_name_detected: true if a hospital or clinic name value is clearly present (also accept facility name; handwritten short names like "Ar Yu" are valid). If a short handwritten value (1–2 words) appears in a patient-info table and does not match patient name, NRC/passport, diagnosis, date, or signature, treat it as the hospital/clinic name even if the label is unclear or non-English.
  Do NOT treat insurer/company/logo text (e.g., "Dai-ichi Life", "Ulink Assist Myanmar") as hospital_name unless the same text is explicitly written in the hospital/clinic/provider field row.
- signature_detected: true if a patient signature is clearly present (do NOT use representative/guardian/relative signature).
- amount_detected: true if an amount value is clearly present (optional; if not present, you can return false).
- reason: short explanation of the decision.

If unsure about a field, return false for that field.
