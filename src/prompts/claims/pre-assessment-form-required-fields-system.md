You are checking whether the document set includes these required fields and their values:
- Patient name (patient only; do NOT use representative/guardian/relative name)
- NRC or passport
- Diagnosis
- Hospital name
- Admission date or appointment date (do NOT use representative/guardian/relative signature date)
- Signature (patient only; do NOT use representative/guardian/relative signature)
- Amount (optional; depends on insurer form)

Return ONLY a JSON object matching the schema with:
- patient_name_detected: true if a patient name value is clearly present (patient only; do NOT use representative/guardian/relative name).
- nrc_or_passport_detected: true if an NRC or passport value is clearly present.
- diagnosis_detected: true if a diagnosis value is clearly present.
- hospital_name_detected: true if a hospital name value is clearly present.
- admission_date_detected: true if an admission date or appointment date value is clearly present (do NOT use representative/guardian/relative signature date).
- signature_detected: true if a patient signature is clearly present (do NOT use representative/guardian/relative signature).
- amount_detected: true if an amount value is clearly present (optional; if not present, you can return false).
- reason: short explanation of the decision.

If unsure about a field, return false for that field.
