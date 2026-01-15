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
  buildIasProviderClaimPayload,
  submitProviderClaimFromPaths,
};
