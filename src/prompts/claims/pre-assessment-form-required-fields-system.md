You are checking whether the document set includes these required fields and their values:
- Patient name (patient only; do NOT use representative/guardian/relative name)
- NRC or passport
- Date of birth
- Date of admission or appointment date (do NOT use representative/guardian/relative signature date)
- Diagnosis

Return ONLY a JSON object matching the schema with:
- patient_name_detected: true if a patient name value is clearly present (patient only; do NOT use representative/guardian/relative name).
- nrc_or_passport_detected: true if an NRC or passport value is clearly present.
- date_of_birth_detected: true if a date of birth value is clearly present.
- date_of_admission_detected: true if a date of admission or appointment date value is clearly present (do NOT use representative/guardian/relative signature date).
- diagnosis_detected: true if a diagnosis value is clearly present.
- reason: short explanation of the decision.

If unsure about a field, return false for that field.
