const fs = require('fs');
const path = require('path');
const {
  requestVisionSchemaCompletion,
  requestAssistantJsonCompletion,
  extractStructuredJson,
} = require('./llmService');
const { convertFilesToJpeg300ppi, convertFilesToPng300dpi } = require('./imageService');
const { postMemberInfoByPolicy, postClaimSubmission, postClaimStatus, downloadClaimFile } = require('./iasService');

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

async function processProviderClaim(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('paths must be a non-empty array of file paths');
  }

  const systemPromptPath = path.join(
    __dirname,
    '..',
    'prompts',
    'claims',
    'claim-provider-claim-system.md'
  );
  const validatePromptPath = path.join(
    __dirname,
    '..',
    'prompts',
    'claims',
    'claim-provider-claim-validate-system.md'
  );
  const jsonSchemaPath = path.join(
    __dirname,
    '..',
    'prompts',
    'claims',
    'claim-provider-claim-json-schema.json'
  );

  const systemPrompt = await fs.promises.readFile(systemPromptPath, 'utf8');
  const validatePrompt = await fs.promises.readFile(validatePromptPath, 'utf8');
  const jsonSchemaRaw = await fs.promises.readFile(jsonSchemaPath, 'utf8');
  const jsonSchema = JSON.parse(jsonSchemaRaw);

  const conversions = await convertFilesToJpeg300ppi(paths);

  console.log('Image Conversion Results:', conversions);

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

  console.log(`First Prompt LLM Structured Output: ${JSON.stringify(structured, null, 2)}`);

  console.log('Begin run Assistant validation prompt...');
  const validateResponse = await requestAssistantJsonCompletion({
    systemPrompt: validatePrompt,
    inputJson: structured,
  });
  console.log('Finish run Assistant validation prompt...');

  console.log('Begin extract structured from validation response...');
  const secondStructured = extractStructuredJson(validateResponse);
  console.log('Finish extract structured from validation response...');

  console.log(`Second Prompt LLM Structured Output: ${JSON.stringify(secondStructured, null, 2)}`);

  return secondStructured;
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

async function processPreAssessmentForm(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('paths must be a non-empty array of file paths');
  }

  const systemPromptPath = path.join(
    __dirname,
    '..',
    'prompts',
    'claims',
    'pre-assessment-form-system.md'
  );
  const jsonSchemaPath = path.join(
    __dirname,
    '..',
    'prompts',
    'claims',
    'pre-assestment-form-json-schema.json'
  );
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

async function submitProviderClaimFromPaths(paths) {
  console.log('Submitting provider claim for paths:', paths);
  const providerClaimResult = await processProviderClaim(paths);

  console.log('Provider Claim OCR Result:', providerClaimResult);
  const documentSourceSummary = providerClaimResult?.document_source_summary || {};
  const documentStatus = String(documentSourceSummary.status || '').trim().toLowerCase();
  const isCompleted =
    /\bcomplete\b/.test(documentStatus) && !/\bincomplete\b/.test(documentStatus);

  console.log('Document Status:', documentStatus, 'Is Completed:', isCompleted);
  
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

  if (!memberInfoData || !Array.isArray(memberInfoData?.payload?.memberPlans) || memberInfoData.payload.memberPlans.length === 0) {
    const error = new Error('Member plan record not found');
    error.code = 'MEMBER_PLAN_NOT_FOUND';
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

  mainSheet.benefit_type = benefitSet?.benefit_type_code || mainSheet.benefit_type;
  mainSheet.benefit_head = benefitSet?.benefit_head_code || mainSheet.benefit_head;

  const providerClaimPayload = buildIasProviderClaimPayload(mainSheet, memberInfoData);
  const iasResponse = await postClaimSubmission(providerClaimPayload);

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
