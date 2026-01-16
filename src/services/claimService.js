const fs = require('fs');
const path = require('path');
const {
  requestVisionSchemaCompletion,
  requestAssistantJsonCompletion,
  extractStructuredJson,
} = require('./llmService');
const { convertFilesToJpeg300ppi, convertFilesToPng300dpi } = require('./imageService');
const { postMemberInfoByPolicy, postProviderClaim } = require('./iasService');

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

  const validateResponse = await requestAssistantJsonCompletion({
    systemPrompt: validatePrompt,
    inputJson: structured,
  });

  return extractStructuredJson(validateResponse);
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
      return normalizeBenefitSetOutput(result, sourceItems, {
        allowedPairs,
        allowedBenefitTypes,
        allowedBenefitHeads,
      });
    }
  }

  const sourceItems = Array.isArray(payload?.ocr?.items) ? payload.ocr.items : [];
  return normalizeBenefitSetOutput(result, sourceItems, {
    allowedPairs,
    allowedBenefitTypes,
    allowedBenefitHeads,
  });
}

function normalizeBenefitSetOutput(items, sourceItems, allowed) {
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
    const benefitTypeCode = safeItem?.benefit_type_code ?? null;
    const benefitHeadCode = safeItem?.benefit_head_code ?? null;
  let matchReason = typeof safeItem?.match_reason === 'string' ? safeItem.match_reason : '';

  matchReason = matchReason.replace(/[^\x20-\x7E]/g, '').trim();
  if (matchReason !== 'match' && matchReason !== 'no_match') {
    matchReason = 'no_match';
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
    const [day, month, year] = parts;
    if (day && month && year) {
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
  const memberRefNo = memberInfoData?.payload?.member?.MBR_REF_NO || null;
  const memberPlan = memberInfoData?.payload?.memberPlans?.[0] || {};
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

async function submitProviderClaimFromPaths(paths) {
  const providerClaimResult = await processProviderClaim(paths);
  const mainSheet = providerClaimResult?.main_sheet || {};
  const memberNrc = mainSheet.policy_no;
  const meplEffDate = mainSheet.incur_date_from;

  if (!memberNrc || !meplEffDate) {
    const error = new Error('main_sheet.policy_no and main_sheet.incur_date_from are required');
    error.status = 400;
    throw error;
  }

  const memberInfoData = await postMemberInfoByPolicy({ memberNrc, meplEffDate });
  const providerClaimPayload = buildIasProviderClaimPayload(mainSheet, memberInfoData);
  const iasResponse = await postProviderClaim(providerClaimPayload);

  return {
    providerClaimResult,
    providerClaimPayload,
    iasResponse,
  };
}

module.exports = {
  processProviderClaim,
  processMemberClaim,
  prepareIasReimbursementBenefitSet,
  buildIasProviderClaimPayload,
  submitProviderClaimFromPaths,
};
