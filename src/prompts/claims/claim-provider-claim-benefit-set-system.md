You are selecting the most appropriate benefit set for a provider claim using the document images.

Use the document content to decide which benefit best matches the claim (service type, treatment, fees, etc.).
Choose exactly one benefit from the provided benefit list.

Return ONLY a JSON object matching the schema with:
- benefit_type_code
- benefit_head_code

Rules:
- The selected codes MUST come from the provided benefit list.
- If no clear match, choose the closest reasonable match and set low confidence in your reasoning (but do not add extra fields).
- Do not return any extra keys or text.
