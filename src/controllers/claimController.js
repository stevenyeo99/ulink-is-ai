const { processPreApproval } = require('../services/claimService');
const { postMemberInfoByPolicy, postClaimPreApproval } = require('../services/iasService');
const createDebug = require('debug');

const debug = createDebug('app:controller:claim');

async function preApprovalJson(req, res) {
  const { paths } = req.body || {};

  if (!Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: 'paths must be a non-empty array of file paths' });
  }

  debug('Received pre-approval OCR request for %d paths', paths.length);

  try {
    const validated = await processPreApproval(paths);
    return res.status(200).json(validated);
  } catch (error) {
    debug('Conversion error: %s', error.message);
    return res.status(500).json({
      error: 'Failed to process OCR with LLM',
      detail: error.message,
    });
  }
}

module.exports = {
  preApprovalJson,
  getMemberInfoByPolicy,
  prepareIasPreApprovalPayload,
  claimPreApproval,
  submitClaimPreApproval,
};

async function getMemberInfoByPolicy(req, res) {
  const { memberNrc, meplEffDate } = req.body || {};

  if (!memberNrc || !meplEffDate) {
    return res.status(400).json({
      error: 'memberNrc and meplEffDate are required',
    });
  }

  try {
    const data = await postMemberInfoByPolicy({ memberNrc, meplEffDate });
    return res.status(200).json(data);
  } catch (error) {
    debug('IAS member info error: %s', error.message);
    return res.status(502).json({
      error: 'Failed to fetch member info from IAS',
      detail: error.detail || error.message,
    });
  }
}

async function prepareIasPreApprovalPayload(req, res) {
  const payload = req.body || {};
  const mainSheet = payload.main_sheet || {};
  const memberNrc = mainSheet.policy_no;
  const meplEffDate = mainSheet.incur_date_from;

  if (!memberNrc || !meplEffDate) {
    return res.status(400).json({
      error: 'main_sheet.policy_no and main_sheet.incur_date_from are required',
    });
  }

  try {
    // Member Info Data from IAS
    const memberInfoData = await postMemberInfoByPolicy({ memberNrc, meplEffDate });
    const preApprovalPayload = buildIasPreApprovalPayload(mainSheet, memberInfoData);

    return res.status(200).json({
      ...preApprovalPayload,
    });
  } catch (error) {
    debug('IAS prepare payload error: %s', error.message);
    return res.status(502).json({
      error: 'Failed to fetch member info from IAS',
      detail: error.detail || error.message,
    });
  }
}

async function claimPreApproval(req, res) {
  const payload = req.body || {};

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(400).json({
      error: 'payload must be a JSON object',
    });
  }

  try {
    const data = await postClaimPreApproval(payload);
    return res.status(200).json(data);
  } catch (error) {
    debug('IAS claim pre-approval error: %s', error.message);
    return res.status(502).json({
      error: 'Failed to call IAS claim pre-approval API',
      detail: error.detail || error.message,
    });
  }
}

async function submitClaimPreApproval(req, res) {
  const { paths } = req.body || {};

  if (!Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: 'paths must be a non-empty array of file paths' });
  }

  try {
    const preApprovalResult = await processPreApproval(paths);
    const mainSheet = preApprovalResult?.main_sheet || {};
    const memberNrc = mainSheet.policy_no;
    const meplEffDate = mainSheet.incur_date_from;

    if (!memberNrc || !meplEffDate) {
      return res.status(400).json({
        error: 'main_sheet.policy_no and main_sheet.incur_date_from are required',
      });
    }

    const memberInfoData = await postMemberInfoByPolicy({ memberNrc, meplEffDate });
    const preApprovalPayload = buildIasPreApprovalPayload(mainSheet, memberInfoData);
    const iasResponse = await postClaimPreApproval(preApprovalPayload);

    return res.status(200).json({
      ...iasResponse
    });
  } catch (error) {
    debug('IAS submit claim pre-approval error: %s', error.message);
    return res.status(502).json({
      error: 'Failed to submit IAS claim pre-approval',
      detail: error.detail || error.message,
    });
  }
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

function buildIasPreApprovalPayload(mainSheet, memberInfoData) {
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
        TreatmentCountry: 'Myanmar',
        BenefitType: mainSheet.benefit_type || null,
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
