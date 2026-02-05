You are extracting structured field values from a pre-assessment / pre-admission form.

Use the provided JSON schema definitions and field descriptions.

Rules:
- Extract all required fields. If a required field is blank on the form, return an empty string.
- Preserve abbreviations, codes, and original casing.
- Do not invent values.
- Respond only with JSON that matches the schema.
