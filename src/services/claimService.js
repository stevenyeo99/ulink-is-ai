const fs = require('fs');
const path = require('path');
const {
  requestVisionSchemaCompletion,
  requestAssistantJsonCompletion,
  extractStructuredJson,
} = require('./llmService');
const { convertFilesToJpeg300ppi, convertFilesToPng300dpi } = require('./imageService');
const { postMemberInfoByPolicy, postClaimSubmission, postClaimStatus, downloadClaimFile } = require('./iasService');
const { logEvent } = require('./logEventService');

function sanitizeDiagnosisCode(value) {
  if (typeof value !== 'string') {
    return value ?? null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const cleaned = trimmed.replace(/[?]+$/g, '').trim();
  return cleaned || null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isLikelyOccupationStatus(value) {
  if (!isNonEmptyString(value)) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return /\bon\s*duty\b/.test(normalized) || /\boccupation\b/.test(normalized);
}

const providerClaimBenefitSetSchema = {
  name: 'provider_claim_benefit_set',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      benefit_type_code: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      benefit_head_code: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      reason: { type: 'string' },
    },
    required: ['benefit_type_code', 'benefit_head_code', 'reason'],
  },
};

const providerClaimIcd10Schema = {
  name: 'provider_claim_icd10',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      diagnosis_code: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      reason: { type: 'string' },
    },
    required: ['diagnosis_code', 'reason'],
  },
};

async function processProviderClaim(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('paths must be a non-empty array of file paths');
  }
  const startedAt = Date.now();

  const systemPromptPath = path.join(
    __dirname,
    '..',
    'prompts',
    'claims',
    'claim-provider-claim-system.md'
  );
  const jsonSchemaPath = path.join(
    __dirname,
    '..',
    'prompts',
    'claims',
    'claim-provider-claim-json-schema.json'
  );

  const systemPrompt = await fs.promises.readFile(systemPromptPath, 'utf8');
  const jsonSchemaRaw = await fs.promises.readFile(jsonSchemaPath, 'utf8');
  const jsonSchema = JSON.parse(jsonSchemaRaw);

  const conversions = await convertFilesToJpeg300ppi(paths);

  logEvent({
    event: 'provider.ocr.image_conversion.completed',
    message: 'Provider claim pages were converted to images.',
    status: 'success',
    action: 'provider_claim',
    details: {
      total: conversions.length,
      success: conversions.filter((item) => item.status === 'success' && item.outputPath).length,
      failed: conversions.filter((item) => item.status !== 'success' || !item.outputPath).length,
    },
  });

  const successfulConversions = conversions.filter((item) => item.status === 'success' && item.outputPath);

  if (successfulConversions.length === 0) {
    const error = new Error('No successful image conversions available for LLM processing');
    error.detail = conversions;
    throw error;
  }

  const base64Images = [];
  for (const conversion of successfulConversions) {
    const imageBuffer = await fs.promises.readFile(conversion.outputPath);
    base64Images.push(imageBuffer.toString('base64'));
  }

  const llmResponse = await requestVisionSchemaCompletion({
    base64Images,
    systemPrompt,
    jsonSchema,
  });

  const structured = extractStructuredJson(llmResponse);

  logEvent({
    event: 'provider.ocr.first_pass.completed',
    message: 'Provider claim first OCR extraction completed.',
    status: 'success',
    action: 'provider_claim',
  });

  // COMMENT FOR DEMO PURPOSE:
  // Skip second validation LLM pass and use first-pass structured JSON directly.
  const secondStructured = structured;
  // logEvent({
  //   event: 'provider.ocr.validation.extract.completed',
  //   message: 'Provider claim uses first-pass structured output (validation pass skipped).',
  //   status: 'success',
  //   action: 'provider_claim',
  // });

  let diagnosisCodeResult = null;
  const diagnosisDescription = secondStructured?.main_sheet?.diagnosis_description || null;
  if (diagnosisDescription) {
    try {
      const icd10PromptPath = path.join(
        __dirname,
        '..',
        'prompts',
        'claims',
        'claim-provider-claim-icd10-system.md'
      );
      const icd10Prompt = await fs.promises.readFile(icd10PromptPath, 'utf8');
      const icd10Response = await requestAssistantJsonCompletion({
        systemPrompt: icd10Prompt,
        inputJson: { diagnosis_description: diagnosisDescription },
        jsonSchema: providerClaimIcd10Schema,
      });
      diagnosisCodeResult = extractStructuredJson(icd10Response);
    } catch (error) {
      logEvent({
        event: 'provider.icd10.lookup.failed',
        message: 'ICD10 lookup failed. Continuing with fallback behavior.',
        status: 'warning',
        action: 'provider_claim',
        details: {
          error: error.message,
        },
      });
    }
  }

  const normalizedDiagnosisCode = sanitizeDiagnosisCode(diagnosisCodeResult?.diagnosis_code);

  const result = {
    ...secondStructured,
    main_sheet: {
      ...(secondStructured?.main_sheet || {}),
      diagnosis_code: normalizedDiagnosisCode,
    },
    diagnosis_code: normalizedDiagnosisCode,
    diagnosis_code_reason: diagnosisCodeResult?.reason || null,
  };
  logEvent({
    event: 'provider.ocr.completed',
    message: 'Provider claim OCR processing completed.',
    status: 'success',
    action: 'provider_claim',
    durationMs: Date.now() - startedAt,
  });
  return result;
}

async function processMemberClaim(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('paths must be a non-empty array of file paths');
  }

  const systemPromptPath = path.join(__dirname, '..', 'prompts', 'claims', 'member-claim-system.md');
  const jsonSchemaPath = path.join(__dirname, '..', 'prompts', 'claims', 'member-claim-json-schema.json');

  const systemPrompt = await fs.promises.readFile(systemPromptPath, 'utf8');
  const jsonSchemaRaw = await fs.promises.readFile(jsonSchemaPath, 'utf8');
  const jsonSchema = JSON.parse(jsonSchemaRaw);

  const conversions = await convertFilesToPng300dpi(paths);
  const successfulConversions = conversions.filter((item) => item.status === 'success' && item.outputPath);

  if (successfulConversions.length === 0) {
    const error = new Error('No successful image conversions available for LLM processing');
    error.detail = conversions;
    throw error;
  }

  const base64Images = [];
  for (const conversion of successfulConversions) {
    const imageBuffer = await fs.promises.readFile(conversion.outputPath);
    base64Images.push(imageBuffer.toString('base64'));
  }

  const llmResponse = await requestVisionSchemaCompletion({
    base64Images,
    systemPrompt,
    jsonSchema,
  });

  return extractStructuredJson(llmResponse);
}

async function processProviderClaimBenefitSet(paths, benefitList) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('paths must be a non-empty array of file paths');
  }
  if (!Array.isArray(benefitList) || benefitList.length === 0) {
    throw new Error('benefitList must be a non-empty array');
  }

  const systemPromptPath = path.join(
    __dirname,
    '..',
    'prompts',
    'claims',
    'claim-provider-claim-benefit-set-system.md'
  );
  const systemPromptBase = await fs.promises.readFile(systemPromptPath, 'utf8');
  const systemPrompt = `${systemPromptBase}\n\nAvailable benefit list:\n${JSON.stringify(benefitList, null, 2)}`;

  const conversions = await convertFilesToJpeg300ppi(paths);
  const successfulConversions = conversions.filter((item) => item.status === 'success' && item.outputPath);

  if (successfulConversions.length === 0) {
    const error = new Error('No successful image conversions available for LLM processing');
    error.detail = conversions;
    throw error;
  }

  const base64Images = [];
  for (const conversion of successfulConversions) {
    const imageBuffer = await fs.promises.readFile(conversion.outputPath);
    base64Images.push(imageBuffer.toString('base64'));
  }

  const llmResponse = await requestVisionSchemaCompletion({
    base64Images,
    systemPrompt,
    jsonSchema: providerClaimBenefitSetSchema,
  });

  return extractStructuredJson(llmResponse);
}

async function processPreAssessmentForm(paths, context = {}) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('paths must be a non-empty array of file paths');
  }

  const startedAt = Date.now();
  const requestId = context.requestId || null;
  const emailUid = context.emailUid || null;
  const action = context.action || 'pre_assestment_form';

  logEvent({
    event: 'preaf.processing.started',
    message: 'Pre-assessment document processing has started.',
    status: 'start',
    requestId,
    emailUid,
    action,
    details: {
      path_count: paths.length,
    },
  });

  const systemPromptPath = path.join(
    __dirname,
    '..',
    'prompts',
    'claims',
    'pre-assessment-form-system.md'
  );
  const classifyPromptPath = path.join(
    __dirname,
    '..',
    'prompts',
    'claims',
    'pre-assessment-form-classify-system.md'
  );
  const requiredFieldsPromptPath = path.join(
    __dirname,
    '..',
    'prompts',
    'claims',
    'pre-assessment-form-required-fields-system.md'
  );
  const jsonSchemaPath = path.join(
    __dirname,
    '..',
    'prompts',
    'claims',
    'pre-assestment-form-json-schema.json'
  );
  const systemPrompt = await fs.promises.readFile(systemPromptPath, 'utf8');
  const classifyPrompt = await fs.promises.readFile(classifyPromptPath, 'utf8');
  const requiredFieldsPrompt = await fs.promises.readFile(requiredFieldsPromptPath, 'utf8');
  const jsonSchemaRaw = await fs.promises.readFile(jsonSchemaPath, 'utf8');
  const jsonSchema = JSON.parse(jsonSchemaRaw);
  const preAssessmentModel = process.env.MODEL_2;

  const conversions = await convertFilesToPng300dpi(paths);
  const successfulConversions = conversions.filter((item) => item.status === 'success' && item.outputPath);
  logEvent({
    event: 'preaf.image_conversion.completed',
    message: 'Document pages were converted to images for OCR.',
    status: 'success',
    requestId,
    emailUid,
    action,
    details: {
      total: conversions.length,
      success: successfulConversions.length,
      failed: Math.max(conversions.length - successfulConversions.length, 0),
    },
  });

  if (successfulConversions.length === 0) {
    const error = new Error('No successful image conversions available for LLM processing');
    error.detail = conversions;
    logEvent({
      event: 'preaf.image_conversion.failed',
      message: 'Image conversion failed. OCR could not continue.',
      status: 'error',
      requestId,
      emailUid,
      action,
      details: {
        conversion_count: conversions.length,
      },
    });
    throw error;
  }

  const base64Images = [];
  for (const conversion of successfulConversions) {
    const imageBuffer = await fs.promises.readFile(conversion.outputPath);
    base64Images.push(imageBuffer.toString('base64'));
  }

  // COMMENT FOR FASTER, DUE DEMO PURPOSE
  // const classifyResponse = await requestVisionSchemaCompletion({
  //   base64Images,
  //   systemPrompt: classifyPrompt,
  //   jsonSchema: {
  //     name: 'pre_assessment_form_classify',
  //     schema: {
  //       type: 'object',
  //       additionalProperties: false,
  //       properties: {
  //         is_pre_admission_form: { type: 'boolean' },
  //         reason: { type: 'string' },
  //       },
  //       required: ['is_pre_admission_form', 'reason'],
  //     },
  //   },
  //   model: preAssessmentModel,
  // });
  // const classifyResult = extractStructuredJson(classifyResponse);
  // console.log('[pre_assestment_form] classify result', classifyResult);
  // if (!classifyResult?.is_pre_admission_form) {
  //   const error = new Error('Missing required document: Pre-Admission Form for LOG');
  //   error.status = 400;
  //   error.code = 'MISSING_DOCS';
  //   error.detail = {
  //     reason: classifyResult?.reason || null,
  //     missing_docs: 'Pre-Admission Form for LOG',
  //   };
  //   throw error;
  // }

  const requiredFieldsResponse = await requestVisionSchemaCompletion({
    base64Images,
    systemPrompt: requiredFieldsPrompt,
    jsonSchema: {
      name: 'pre_assessment_form_required_fields',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          patient_name_detected: { type: 'boolean' },
          nrc_or_passport_detected: { type: 'boolean' },
          diagnosis_detected: { type: 'boolean' },
          admission_date_detected: { type: 'boolean' },
          hospital_name_detected: { type: 'boolean' },
          signature_detected: { type: 'boolean' },
          amount_detected: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: [
          'patient_name_detected',
          'nrc_or_passport_detected',
          'diagnosis_detected',
          'admission_date_detected',
          'hospital_name_detected',
          'signature_detected',
          'amount_detected',
          'reason',
        ],
      },
    },
    model: preAssessmentModel,
  });
  const requiredFieldsResult = extractStructuredJson(requiredFieldsResponse);
  const missingFields = [];
  if (!requiredFieldsResult?.patient_name_detected) missingFields.push('patient_name');
  if (!requiredFieldsResult?.nrc_or_passport_detected) missingFields.push('nrc_or_passport');
  if (!requiredFieldsResult?.diagnosis_detected) missingFields.push('diagnosis');
  if (!requiredFieldsResult?.hospital_name_detected) missingFields.push('hospital_name');
  if (!requiredFieldsResult?.admission_date_detected) missingFields.push('admission_date');
  if (!requiredFieldsResult?.signature_detected) missingFields.push('signature');
  logEvent({
    event: 'preaf.required_fields.checked',
    message: 'Required fields check completed.',
    status: missingFields.length > 0 ? 'warning' : 'success',
    requestId,
    emailUid,
    action,
    details: {
      missing_fields: missingFields,
      reason: requiredFieldsResult?.reason || null,
    },
  });

  if (missingFields.length > 0) {
    const error = new Error('Missing required fields for pre-assessment form OCR');
    error.status = 400;
    error.code = 'MISSING_REQUIRED_FIELDS';
    error.detail = {
      reason: requiredFieldsResult?.reason || null,
      missing_fields: missingFields,
    };
    logEvent({
      event: 'preaf.required_fields.missing',
      message: 'Pre-assessment required fields are incomplete.',
      status: 'warning',
      requestId,
      emailUid,
      action,
      details: error.detail,
    });
    throw error;
  }

  const llmResponse = await requestVisionSchemaCompletion({
    base64Images,
    systemPrompt,
    jsonSchema,
    model: preAssessmentModel,
  });
  const extractedResult = extractStructuredJson(llmResponse);
  logEvent({
    event: 'preaf.ocr.completed',
    message: 'Pre-assessment OCR extraction completed.',
    status: 'success',
    requestId,
    emailUid,
    action,
  });

  const extractedHospitalName = extractedResult?.pre_admission_part_1?.hospital_name;
  const extractedDoctorName = extractedResult?.pre_admission_part_1?.doctor_name;
  const hospitalNameLooksWrong = isLikelyOccupationStatus(extractedHospitalName);
  const shouldRunHospitalFallback = requiredFieldsResult?.hospital_name_detected && (
    !isNonEmptyString(extractedHospitalName) || hospitalNameLooksWrong
  );

  if (
    shouldRunHospitalFallback
  ) {
    try {
      const hospitalFallbackPrompt = [
        'You are extracting one field from a pre-admission form image set.',
        'Return only JSON.',
        'Target field: pre_admission_part_1.hospital_name',
        'Rules:',
        '- Read only the Part (1) patient-info table row for hospital/clinic/provider.',
        '- If a short handwritten value appears there (e.g., "Ar Yu"), copy exactly as written.',
        '- Do NOT use insurer/logo text (e.g., "Dai-ichi Life", "Ulink Assist Myanmar").',
        '- Do NOT copy from occupation/ward rows (e.g., "On duty").',
        '- If truly unreadable, return empty string.',
      ].join('\n');

      const hospitalFallbackResponse = await requestVisionSchemaCompletion({
        base64Images,
        systemPrompt: hospitalFallbackPrompt,
        jsonSchema: {
          name: 'pre_assessment_hospital_name_fallback',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              hospital_name: { type: 'string' },
              reason: { type: 'string' },
            },
            required: ['hospital_name', 'reason'],
          },
        },
        model: preAssessmentModel,
      });

      const hospitalFallbackResult = extractStructuredJson(hospitalFallbackResponse);
      const fallbackHospitalName = hospitalFallbackResult?.hospital_name;
      if (fallbackHospitalName && String(fallbackHospitalName).trim()) {
        extractedResult.pre_admission_part_1 = {
          ...(extractedResult?.pre_admission_part_1 || {}),
          hospital_name: String(fallbackHospitalName).trim(),
        };
        logEvent({
          event: 'preaf.fallback.hospital_name.applied',
          message: 'Hospital name fallback extraction was applied.',
          status: 'success',
          requestId,
          emailUid,
          action,
          details: {
            reason: hospitalFallbackResult?.reason || null,
          },
        });
      }
    } catch (error) {
      logEvent({
        event: 'preaf.fallback.hospital_name.failed',
        message: 'Hospital name fallback extraction failed.',
        status: 'warning',
        requestId,
        emailUid,
        action,
        details: {
          error: error.message,
        },
      });
    }
  }

  const shouldRunDoctorFallback =
    !isNonEmptyString(extractedDoctorName) ||
    (hospitalNameLooksWrong && !isLikelyOccupationStatus(extractedDoctorName));

  if (shouldRunDoctorFallback) {
    try {
      const doctorFallbackPrompt = [
        'You are extracting one field from a pre-admission form image set.',
        'Return only JSON.',
        'Target field: pre_admission_part_1.doctor_name',
        'Rules:',
        '- Read only the Part (1) patient-info table row mapped to doctor_name.',
        '- In this form mapping, doctor_name is the occupation/duty style row and may contain values like "On duty".',
        '- Do NOT copy from hospital/clinic/provider row (e.g., "Ar Yu").',
        '- If truly unreadable, return empty string.',
      ].join('\n');

      const doctorFallbackResponse = await requestVisionSchemaCompletion({
        base64Images,
        systemPrompt: doctorFallbackPrompt,
        jsonSchema: {
          name: 'pre_assessment_doctor_name_fallback',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              doctor_name: { type: 'string' },
              reason: { type: 'string' },
            },
            required: ['doctor_name', 'reason'],
          },
        },
        model: preAssessmentModel,
      });

      const doctorFallbackResult = extractStructuredJson(doctorFallbackResponse);
      const fallbackDoctorName = doctorFallbackResult?.doctor_name;
      if (isNonEmptyString(fallbackDoctorName)) {
        extractedResult.pre_admission_part_1 = {
          ...(extractedResult?.pre_admission_part_1 || {}),
          doctor_name: String(fallbackDoctorName).trim(),
        };
        logEvent({
          event: 'preaf.fallback.doctor_name.applied',
          message: 'Doctor name fallback extraction was applied.',
          status: 'success',
          requestId,
          emailUid,
          action,
          details: {
            reason: doctorFallbackResult?.reason || null,
          },
        });
      }
    } catch (error) {
      logEvent({
        event: 'preaf.fallback.doctor_name.failed',
        message: 'Doctor name fallback extraction failed.',
        status: 'warning',
        requestId,
        emailUid,
        action,
        details: {
          error: error.message,
        },
      });
    }
  }

  logEvent({
    event: 'preaf.processing.completed',
    message: 'Pre-assessment processing completed successfully.',
    status: 'success',
    requestId,
    emailUid,
    action,
    durationMs: Date.now() - startedAt,
  });
  return extractedResult;
}

function reimbursementBenefitSchema(n) {
  return {
    name: 'ias_reimbursement_benefit_items',
    schema: {
      type: 'array',
      minItems: n,
      maxItems: n,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'integer', minimum: 0, maximum: Math.max(0, n - 1) },
          benefit_type_code: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          benefit_head_code: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          match_reason: { type: 'string', enum: ['match', 'no_match'] },
        },
        required: ['index', 'benefit_type_code', 'benefit_head_code', 'match_reason'],
      },
    }
  }
};

async function prepareIasReimbursementBenefitSet(payload) {
  const systemPromptPath = path.join(
    __dirname,
    '..',
    'prompts',
    'reimbursement',
    'benefit-set-system.md'
  );
  const systemPrompt = await fs.promises.readFile(systemPromptPath, 'utf8');

  const expectedCount = Array.isArray(payload?.ocr?.items) ? payload.ocr.items.length : 0;
  console.log(`LLM Request Payload: ${JSON.stringify(payload, null, 2)}`);
  let response = await requestAssistantJsonCompletion({
    systemPrompt,
    inputJson: payload,
    jsonSchema: reimbursementBenefitSchema(expectedCount),
    model: process.env.MODEL || null
  });
  console.log(`LLM Response: ${JSON.stringify(response, null, 2)}`);

  let result;
  try {
    result = parseAssistantJsonArray(response);
  } catch (error) {
    const strictPrompt = `${systemPrompt}\n\nSTRICT OUTPUT: Use match_reason only \"match\" or \"no_match\". Return valid JSON array only.`;
    response = await requestAssistantJsonCompletion({
      systemPrompt: strictPrompt,
      inputJson: payload,
      jsonSchema: reimbursementBenefitSchema(expectedCount),
    });
    try {
      result = parseAssistantJsonArray(response);
    } catch (retryError) {
      const sourceItems = Array.isArray(payload?.ocr?.items) ? payload.ocr.items : [];
      return normalizeBenefitSetOutput([], sourceItems, {
        allowedPairs,
        allowedBenefitTypes,
        allowedBenefitHeads,
      });
    }
  }
  console.log(`LLM Result: ${JSON.stringify(result, null, 2)}`);
  const allowedPairs = new Set();
  const allowedBenefitTypes = new Set();
  const allowedBenefitHeads = new Set();

  if (Array.isArray(payload?.ias?.benefitList)) {
    for (const benefit of payload.ias.benefitList) {
      const typeCode = benefit?.benefit_type_code;
      const headCode = benefit?.benefit_head_code;
      if (typeCode || headCode) {
        allowedPairs.add(`${typeCode ?? ''}::${headCode ?? ''}`);
      }
      if (typeCode) allowedBenefitTypes.add(typeCode);
      if (headCode) allowedBenefitHeads.add(headCode);
    }
  }

  if (!Array.isArray(result)) {
    throw new Error('LLM response is not an array');
  }

  if (expectedCount > 0 && result.length !== expectedCount) {
    const strictPrompt = `${systemPrompt}\n\nIMPORTANT: Return exactly ${expectedCount} items in the same order as input. Do not drop any items. If unsure, set codes to null but keep every item.`;
    const retryResponse = await requestAssistantJsonCompletion({
      systemPrompt: strictPrompt,
      inputJson: payload,
      jsonSchema: reimbursementBenefitSchema(expectedCount),
    });
    result = parseAssistantJsonArray(retryResponse);

    if (!Array.isArray(result)) {
      throw new Error('LLM response is not an array');
    }

    if (result.length !== expectedCount) {
      const sourceItems = Array.isArray(payload?.ocr?.items) ? payload.ocr.items : [];
      return normalizeBenefitSetOutput(result, sourceItems, payload?.ocr?.benefit_type, {
        allowedPairs,
        allowedBenefitTypes,
        allowedBenefitHeads,
      });
    }
  }

  const sourceItems = Array.isArray(payload?.ocr?.items) ? payload.ocr.items : [];
  return normalizeBenefitSetOutput(result, sourceItems, payload?.ocr?.benefit_type, {
    allowedPairs,
    allowedBenefitTypes,
    allowedBenefitHeads,
  });
}

function normalizeBenefitSetOutput(items, sourceItems, benefitTypeLabel, allowed) {
  const mapping = new Map();
  for (const entry of items) {
    if (!entry || typeof entry !== 'object') continue;
    const index = Number.isInteger(entry.index) ? entry.index : null;
    if (index === null) continue;
    mapping.set(index, entry);
  }

  return sourceItems.map((source, index) => {
    const safeItem = mapping.get(index) || {};
    const benefit = source?.benefit ?? null;
    const amount = source?.amount ?? null;
    let benefitTypeCode = safeItem?.benefit_type_code ?? null;
    let benefitHeadCode = safeItem?.benefit_head_code ?? null;
    let matchReason = typeof safeItem?.match_reason === 'string' ? safeItem.match_reason : '';

  matchReason = matchReason.replace(/[^\x20-\x7E]/g, '').trim();
  if (matchReason !== 'match' && matchReason !== 'no_match') {
    matchReason = 'no_match';
  }

    if (
      typeof benefit === 'string' &&
      typeof benefitTypeLabel === 'string' &&
      benefitTypeLabel.toLowerCase() === 'outpatient' &&
      benefit.toLowerCase().includes('service fee') &&
      allowed.allowedPairs.has('OP::OV')
    ) {
      benefitTypeCode = 'OP';
      benefitHeadCode = 'OV';
      matchReason = 'match';
    }
    if (
      typeof benefit === 'string' &&
      typeof benefitTypeLabel === 'string' &&
      benefitTypeLabel.toLowerCase() === 'outpatient' &&
      (benefit.toLowerCase().includes('consultant') || benefit.toLowerCase().includes('consultation')) &&
      allowed.allowedPairs.has('OP::SP')
    ) {
      benefitTypeCode = 'OP';
      benefitHeadCode = 'SP';
      matchReason = 'match';
    }

    let normalizedType = benefitTypeCode;
    let normalizedHead = benefitHeadCode;
    const pairKey = `${benefitTypeCode ?? ''}::${benefitHeadCode ?? ''}`;
    if (!allowed.allowedPairs.has(pairKey)) {
      normalizedType = allowed.allowedBenefitTypes.has(benefitTypeCode) ? benefitTypeCode : null;
      normalizedHead = allowed.allowedBenefitHeads.has(benefitHeadCode) ? benefitHeadCode : null;
      if (!normalizedType || !normalizedHead) {
        normalizedType = null;
        normalizedHead = null;
        matchReason = 'no_match';
      }
    }
    if (normalizedType && normalizedHead && allowed.allowedPairs.has(`${normalizedType}::${normalizedHead}`)) {
      matchReason = 'match';
    }

    return {
      benefit,
      amount,
      benefit_type_code: normalizedType,
      benefit_head_code: normalizedHead,
      match_reason: matchReason,
    };
  });
}

function parseAssistantJsonArray(response) {
  try {
    return extractStructuredJson(response);
  } catch (error) {
    const content = response?.choices?.[0]?.message?.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('');
    }
    if (!text) {
      throw error;
    }
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) {
      throw error;
    }
    const rawJson = text.slice(start, end + 1);
    const sanitized = sanitizeJsonString(rawJson);
    return JSON.parse(sanitized);
  }
}

function sanitizeJsonString(input) {
  let output = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (escaped) {
      output += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      output += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      output += ch;
      inString = !inString;
      continue;
    }

    if (inString) {
      if (ch === '\n' || ch === '\r' || ch === '\t') {
        output += ' ';
        continue;
      }
      if (ch < ' ') {
        output += ' ';
        continue;
      }
    }

    output += ch;
  }

  return output;
}

function formatDateToMMddyyyy(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    const year = String(value.getFullYear());
    return `${month}${day}${year}`;
  }

  const parts = String(value).trim().split(/[\/-]/);
  if (parts.length === 3) {
    const [part1, part2, part3] = parts;
    let year = null;
    let month = null;
    let day = null;

    if (part1.length === 4) {
      year = part1;
      month = part2;
      day = part3;
    } else if (part3.length === 4) {
      year = part3;
      month = part2;
      day = part1;
    }

    if (year && month && day) {
      return `${month.padStart(2, '0')}${day.padStart(2, '0')}${year}`;
    }
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const day = String(parsed.getDate()).padStart(2, '0');
    const year = String(parsed.getFullYear());
    return `${month}${day}${year}`;
  }

  return null;
}

function buildIasProviderClaimPayload(mainSheet, memberInfoData) {
  const memberRecord = memberInfoData?.payload?.member;
  const memberPlans = memberInfoData?.payload?.memberPlans;
  if (!memberRecord || !Array.isArray(memberPlans) || memberPlans.length === 0) {
    const error = new Error('Member plan record not found');
    error.code = 'MEMBER_PLAN_NOT_FOUND';
    throw error;
  }
  const memberRefNo = memberInfoData?.payload?.member?.MBR_REF_NO || null;
  const memberPlan = memberPlans[0] || {};
  const planCurrency = memberPlan?.plan?.SCMA_OID_CCY || '';
  const normalizedCurrency = planCurrency.replace(/^CCY_/, '');

  const receivedDate = formatDateToMMddyyyy(new Date());
  const incurDateFrom = formatDateToMMddyyyy(mainSheet.incur_date_from);
  const incurDateTo = formatDateToMMddyyyy(mainSheet.incur_date_to);

  return {
    MemberRefNo: memberRefNo,
    isValidation: 'N',
    Items: [
      {
        DiagnosisCode: mainSheet.diagnosis_code || null,
        DiagnosisDescription: mainSheet.diagnosis_description || null,
        InvoiceID: 'NIL',
        ReceivedDate: receivedDate,
        SymptomDate: null,
        ClaimType: 'P',
        TreatmentCountry: 'MYANMAR',
        BenefitType: mainSheet.benefit_type || null,
        ProviderCode: mainSheet.provider_code || null,
        ProviderName: mainSheet.provider_name || null,
        IncurDateFrom: incurDateFrom,
        IncurDateTo: incurDateTo,
        PresentedCurrency: normalizedCurrency || null,
        PresentedAmt: mainSheet.final_payable_amount ?? null,
        ExchangeRate: 1,
        BenefitHead: mainSheet.benefit_head || null,
        PaymentCurrency: normalizedCurrency || null,
        PaymentExchangeRate: 1,
        PaymentMethod: '',
        PlanId: memberPlan?.plan?.PLAN_ID || '',
        MeplOid: memberPlan?.MEPL_OID || null,
        BankName: '',
        BankAcctNo: '',
        BankAcctName: '',
        PayeeEmail: '',
      },
    ],
  };
}

function formatDateToYYYYMMDD(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    const year = String(value.getFullYear());
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
  }

  const parts = String(value).trim().split(/[\/-]/);
  if (parts.length === 3) {
    const [year, month, day] = parts;
    if (year.length === 4) {
      return `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
    }
    if (day.length === 4) {
      return `${day}${String(month).padStart(2, '0')}${String(year).padStart(2, '0')}`;
    }
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    const year = String(parsed.getFullYear());
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const day = String(parsed.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
  }

  return null;
}

function buildIasReimbursementBenefitSetPayload(ocrPayload, memberInfoData) {
  const benefitType = ocrPayload?.claim_info?.benefit_type ?? null;
  const items = Array.isArray(ocrPayload?.items) ? ocrPayload.items : [];
  const memberPlans = memberInfoData?.payload?.memberPlans;
  const latestPlan = Array.isArray(memberPlans) ? memberPlans[memberPlans.length - 1] : memberPlans;
  const coverageLimits = Array.isArray(latestPlan?.coverageLimits) ? latestPlan.coverageLimits : [];
  const benefitList = coverageLimits
    .flatMap((limit) => (limit.limit_type_code === 'H' && Array.isArray(limit?.benefits) ? limit.benefits : []))
    .filter(Boolean);

  return {
    ocr: {
      benefit_type: benefitType,
      items,
    },
    ias: {
      benefitList,
    },
  };
}

function buildIasBenefitListFromCoverageLimits(coverageLimits) {
  const limits = Array.isArray(coverageLimits) ? coverageLimits : [];
  return limits
    .flatMap((limit) => (limit?.limit_type_code === 'H' && Array.isArray(limit?.benefits) ? limit.benefits : []))
    .filter(Boolean);
}

function normalizeCurrency(value) {
  if (!value) {
    return null;
  }
  return String(value).replace(/^CCY_/, '');
}

function normalizeAmount(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return value;
  }
  const normalized = String(value).replace(/,/g, '').trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isNaN(parsed) ? normalized : parsed;
}

function buildIasReimbursementClaimPayload(prepareClaimApiPayload) {
  const memberRecord = prepareClaimApiPayload?.memberInfoData?.payload?.member;
  const memberPlans = prepareClaimApiPayload?.memberInfoData?.payload?.memberPlans;
  if (!memberRecord || !Array.isArray(memberPlans) || memberPlans.length === 0) {
    const error = new Error('Member plan record not found');
    error.code = 'MEMBER_PLAN_NOT_FOUND';
    throw error;
  }
  const memberRefNo = prepareClaimApiPayload?.memberInfoData?.payload?.member?.MBR_REF_NO ?? null;
  const claimInfo = prepareClaimApiPayload?.ocrPayload?.claim_info || {};
  const bankInfo = prepareClaimApiPayload?.ocrPayload?.bank_info || {};
  const policyInfo = prepareClaimApiPayload?.ocrPayload?.policy_info || {};
  const benefitResults = Array.isArray(prepareClaimApiPayload?.prepareBenefitSetResult)
    ? prepareClaimApiPayload.prepareBenefitSetResult
    : [];
  const plan = Array.isArray(memberPlans) ? memberPlans[0]?.plan : memberPlans?.plan;
  const meplOid = Array.isArray(memberPlans) ? memberPlans[0]?.MEPL_OID : memberPlans?.MEPL_OID;
  const currency = normalizeCurrency(plan?.SCMA_OID_CCY);
  let paymentMethod =
    prepareClaimApiPayload?.memberInfoData?.payload?.member?.SCMA_OID_CL_PAY_METHOD ||
    'AT';
  paymentMethod = paymentMethod.replace(/^CL_PAYMENT_METHOD/, '');

  const incurDate = claimInfo?.incur_date;
  const formattedIncurDate = formatDateToMMddyyyy(incurDate);
  const formattedReceivedDate = formatDateToMMddyyyy(claimInfo?.received_date);

  const items = benefitResults.map((item) => ({
    DiagnosisCode: claimInfo?.diagnosis_code ?? null,
    DiagnosisCodeDesc: claimInfo?.diagnosis ?? null,
    DiagnosisDescription: claimInfo?.diagnosis_remark ?? null,
    InvoiceID: 'NIL',
    ReceivedDate: formattedReceivedDate,
    SymptomDate: null,
    ClaimType: 'M',
    TreatmentCountry: 'MYANMAR',
    BenefitType: item?.benefit_type_code ?? null,
    BenefitHead: item?.benefit_head_code ?? null,
    ProviderName: claimInfo?.provider_name ?? null,
    IncurDateFrom: formattedIncurDate,
    IncurDateTo: formattedIncurDate,
    PresentedCurrency: currency,
    PresentedAmt: normalizeAmount(item?.amount),
    ExchangeRate: 1,
    PaymentCurrency: currency,
    PaymentExchangeRate: 1,
    PaymentMethod: paymentMethod,
    PlanId: plan?.PLAN_ID ?? null,
    MeplOid: meplOid ?? null,
    BankName: bankInfo?.bank_name ?? null,
    BankAcctNo: bankInfo?.account_no ?? null,
    BankAcctName: bankInfo?.account_name ?? null,
    PayeeEmail: policyInfo?.member_email ?? null,
    ContactNumber: policyInfo?.member_phone_number ?? null,
  }));

  return {
    MemberRefNo: memberRefNo,
    isValidation: 'Y',
    isCSR: 'Y',
    Items: items,
  };
}

function findLatestFileEntry(claimStatusResponse) {
  const results = claimStatusResponse?.payload?.results;
  if (!Array.isArray(results)) {
    return null;
  }
  for (const entry of results) {
    const filename = entry?.FILENAME || entry?.filename || '';
    const filepath = entry?.PATH || entry?.path || '';
    if (filename && filepath) {
      return { filename, filepath };
    }
  }
  return null;
}

async function processReimbursementClaimFromPaths(paths, options = {}) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('paths must be a non-empty array of file paths');
  }

  const llmOcrPayload = await processMemberClaim(paths);
  const memberNrc = llmOcrPayload?.policy_info?.member_nrc;
  const incurDate = llmOcrPayload?.claim_info?.incur_date;

  if (!memberNrc || !incurDate) {
    const error = new Error('policy_info.member_nrc and claim_info.incur_date are required');
    error.status = 400;
    throw error;
  }

  const meplEffDate = formatDateToYYYYMMDD(incurDate);
  if (!meplEffDate) {
    const error = new Error('claim_info.incur_date must be a valid date');
    error.status = 400;
    throw error;
  }

  const memberInfoData = await postMemberInfoByPolicy({ memberNrc, meplEffDate });
  const prepareBenefitSetPayload = buildIasReimbursementBenefitSetPayload(
    llmOcrPayload,
    memberInfoData
  );
  const prepareBenefitSetResult = await prepareIasReimbursementBenefitSet(prepareBenefitSetPayload);
  const claimSubmissionPayload = buildIasReimbursementClaimPayload({
    ocrPayload: llmOcrPayload,
    memberInfoData,
    prepareBenefitSetResult,
  });
  const submissionResponse = await postClaimSubmission(claimSubmissionPayload);
  const claimNo =
    submissionResponse?.payload?.claimNo ??
    submissionResponse?.claimNo ??
    submissionResponse?.payload?.claim_no ??
    submissionResponse?.claim_no ??
    null;

  if (!claimNo) {
    const error = new Error('Claim submission response missing claimNo');
    error.status = 502;
    error.detail = submissionResponse;
    throw error;
  }

  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const year = String(now.getFullYear());
  const fromDatetime = `${month}${day}${year}_00:00`;
  const claimStatusResponse = await postClaimStatus({ claimNo, fromDatetime });
  const fileEntry = findLatestFileEntry(claimStatusResponse);

  if (!fileEntry || !fileEntry.filename || !fileEntry.filepath) {
    const error = new Error('Claim status response missing filename/path');
    error.status = 502;
    error.detail = claimStatusResponse;
    throw error;
  }

  const downloadResult = await downloadClaimFile({
    filepath: fileEntry.filepath,
    filename: fileEntry.filename,
    downloadPath: options.downloadPath,
  });

  return {
    claimNo,
    downloadedFilePath: downloadResult.path,
    llmOcrPayload,
    claimSubmissionPayload,
    claimStatusResponse,
    submissionResponse,
  };
}

async function submitProviderClaimFromPaths(paths, context = {}) {
  const startedAt = Date.now();
  const requestId = context.requestId || null;
  const emailUid = context.emailUid || null;
  const action = context.action || 'provider_claim';

  logEvent({
    event: 'provider.processing.started',
    message: 'Provider claim processing has started.',
    status: 'start',
    requestId,
    emailUid,
    action,
    details: {
      path_count: Array.isArray(paths) ? paths.length : 0,
    },
  });
  console.log('Submitting provider claim for paths:', paths);
  const providerClaimResult = await processProviderClaim(paths);

  console.log('Provider Claim OCR Result:', providerClaimResult);
  const documentSourceSummary = providerClaimResult?.document_source_summary || {};
  const documentStatus = String(documentSourceSummary.status || '').trim().toLowerCase();
  const isCompleted =
    /\bcomplete\b/.test(documentStatus) && !/\bincomplete\b/.test(documentStatus);

  // console.log('Document Status:', documentStatus, 'Is Completed:', isCompleted);
  logEvent({
    event: 'provider.document_check.completed',
    message: isCompleted
      ? 'Required provider claim documents are complete.'
      : 'Provider claim documents are incomplete.',
    status: isCompleted ? 'success' : 'warning',
    requestId,
    emailUid,
    action,
    details: {
      status: documentSourceSummary.status || null,
      missing_docs: documentSourceSummary.missing_docs || null,
    },
  });
  
  if (!isCompleted) {
    const missingDocs = documentSourceSummary.missing_docs || 'Not available';
    const error = new Error(
      `Provider claim documents incomplete. Missing docs: ${missingDocs}`
    );
    error.status = 400;
    error.detail = {
      status: documentSourceSummary.status || null,
      missing_docs: documentSourceSummary.missing_docs || null,
    };
    error.code = 'MISSING_DOCUMENTS';
    logEvent({
      event: 'provider.document_check.failed',
      message: 'Provider claim cannot continue because required documents are missing.',
      status: 'warning',
      requestId,
      emailUid,
      action,
      details: error.detail,
    });
    throw error;
  }
  const mainSheet = providerClaimResult?.main_sheet || {};
  const memberNrc = mainSheet.policy_no;
  const meplEffDate = mainSheet.incur_date_from;

  if (!memberNrc || !meplEffDate) {
    const error = new Error('main_sheet.policy_no and main_sheet.incur_date_from are required');
    error.status = 400;
    throw error;
  }

  const formattedMeplEffDate = formatDateToYYYYMMDD(meplEffDate);
  if (!formattedMeplEffDate) {
    const error = new Error('main_sheet.incur_date_from must be a valid date');
    error.status = 400;
    throw error;
  }

  const memberInfoData = await postMemberInfoByPolicy({
    memberNrc,
    meplEffDate: formattedMeplEffDate,
  });
  logEvent({
    event: 'provider.member_lookup.completed',
    message: 'Member plan lookup completed.',
    status: 'success',
    requestId,
    emailUid,
    action,
  });

  if (!memberInfoData || !Array.isArray(memberInfoData?.payload?.memberPlans) || memberInfoData.payload.memberPlans.length === 0) {
    const error = new Error('Member plan record not found');
    error.code = 'MEMBER_PLAN_NOT_FOUND';
    logEvent({
      event: 'provider.member_lookup.failed',
      message: 'Member plan record was not found.',
      status: 'warning',
      requestId,
      emailUid,
      action,
    });
    throw error;
  }

  const coverageLimits = memberInfoData?.payload?.memberPlans?.[0]?.coverageLimits
    || memberInfoData?.memberPlans?.[0]?.coverageLimits
    || [];
  const memberPlanGetBenefitList = {
    ias: {
      benefitList: buildIasBenefitListFromCoverageLimits(coverageLimits),
    },
  };

  const benefitSet = await processProviderClaimBenefitSet(
    paths,
    memberPlanGetBenefitList.ias.benefitList
  );
  logEvent({
    event: 'provider.benefit_set.completed',
    message: 'Benefit type and head mapping completed.',
    status: 'success',
    requestId,
    emailUid,
    action,
    details: {
      benefit_type_code: benefitSet?.benefit_type_code || null,
      benefit_head_code: benefitSet?.benefit_head_code || null,
    },
  });

  mainSheet.benefit_type = benefitSet?.benefit_type_code || mainSheet.benefit_type;
  mainSheet.benefit_head = benefitSet?.benefit_head_code || mainSheet.benefit_head;

  const providerClaimPayload = buildIasProviderClaimPayload(mainSheet, memberInfoData);
  const iasResponse = await postClaimSubmission(providerClaimPayload);
  logEvent({
    event: 'provider.submission.completed',
    message: 'Provider claim was submitted to IAS.',
    status: 'success',
    requestId,
    emailUid,
    action,
    durationMs: Date.now() - startedAt,
  });

  return {
    providerClaimResult,
    providerClaimPayload,
    memberPlanGetBenefitList,
    benefitSet,
    iasResponse,
  };
}

module.exports = {
  processProviderClaim,
  processMemberClaim,
  processProviderClaimBenefitSet,
  processPreAssessmentForm,
  prepareIasReimbursementBenefitSet,
  formatDateToYYYYMMDD,
  buildIasProviderClaimPayload,
  buildIasBenefitListFromCoverageLimits,
  buildIasReimbursementBenefitSetPayload,
  buildIasReimbursementClaimPayload,
  findLatestFileEntry,
  processReimbursementClaimFromPaths,
  submitProviderClaimFromPaths,
};
