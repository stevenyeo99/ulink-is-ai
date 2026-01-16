const {
  processProviderClaim,
  processMemberClaim,
  buildIasProviderClaimPayload,
  submitProviderClaimFromPaths,
  prepareIasReimbursementBenefitSet,
} = require('../services/claimService');
const { saveProviderClaimWorkbook } = require('../services/excelService');
const { postMemberInfoByPolicy, postProviderClaim } = require('../services/iasService');
const createDebug = require('debug');
const os = require('os');
const path = require('path');

const debug = createDebug('app:controller:claim');

async function providerClaimJson(req, res) {
  const { paths } = req.body || {};

  if (!Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: 'paths must be a non-empty array of file paths' });
  }

  debug('Received provider-claim OCR request for %d paths', paths.length);

  try {
    const validated = await processProviderClaim(paths);
    return res.status(200).json(validated);
  } catch (error) {
    debug('Conversion error: %s', error.message);
    return res.status(500).json({
      error: 'Failed to process OCR with LLM',
      detail: error.message,
    });
  }
}

async function memberClaimJson(req, res) {
  const { paths } = req.body || {};

  if (!Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: 'paths must be a non-empty array of file paths' });
  }

  debug('Received member claim OCR request for %d paths', paths.length);

  try {
    const extracted = await processMemberClaim(paths);
    return res.status(200).json(extracted);
  } catch (error) {
    debug('Member claim OCR error: %s', error.message);
    return res.status(500).json({
      error: 'Failed to process member claim OCR with LLM',
      detail: error.message,
    });
  }
}

async function providerClaimJsonExcel(req, res) {
  const payload = req.body || {};

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(400).json({
      error: 'payload must be a JSON object',
    });
  }

  try {
    const outputDir = path.join(os.tmpdir(), 'claim-provider-claim', 'excel');
    const filePath = await saveProviderClaimWorkbook(payload, { dir: outputDir });
    return res.status(200).json({ path: filePath });
  } catch (error) {
    debug('Provider claim Excel error: %s', error.message);
    return res.status(500).json({
      error: 'Failed to build provider claim Excel',
      detail: error.message,
    });
  }
}

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

async function prepareIasProviderClaimPayload(req, res) {
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
    const providerClaimPayload = buildIasProviderClaimPayload(mainSheet, memberInfoData);

    return res.status(200).json({
      ...providerClaimPayload,
    });
  } catch (error) {
    debug('IAS prepare payload error: %s', error.message);
    return res.status(502).json({
      error: 'Failed to fetch member info from IAS',
      detail: error.detail || error.message,
    });
  }
}

async function claimProviderClaim(req, res) {
  const payload = req.body || {};

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(400).json({
      error: 'payload must be a JSON object',
    });
  }

  try {
    const data = await postProviderClaim(payload);
    return res.status(200).json(data);
  } catch (error) {
    debug('IAS provider claim error: %s', error.message);
    return res.status(502).json({
      error: 'Failed to call IAS provider claim API',
      detail: error.detail || error.message,
    });
  }
}

async function submitClaimProviderClaim(req, res) {
  const { paths } = req.body || {};

  if (!Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: 'paths must be a non-empty array of file paths' });
  }

  try {
    const { iasResponse } = await submitProviderClaimFromPaths(paths);
    return res.status(200).json({
      ...iasResponse,
    });
  } catch (error) {
    debug('IAS submit provider claim error: %s', error.message);
    if (error.status === 400) {
      return res.status(400).json({
        error: error.message,
      });
    }
    return res.status(502).json({
      error: 'Failed to submit IAS provider claim',
      detail: error.detail || error.message,
    });
  }
}

async function prepareIasReimbursementBenefitSetController(req, res) {
  const payload = req.body || {};
  const ocrItems = payload?.ocr?.items;
  const benefitList = payload?.ias?.benefitList;

  if (!Array.isArray(ocrItems) || ocrItems.length === 0) {
    return res.status(400).json({ error: 'ocr.items must be a non-empty array' });
  }

  if (!Array.isArray(benefitList) || benefitList.length === 0) {
    return res.status(400).json({ error: 'ias.benefitList must be a non-empty array' });
  }

  try {
    const items = await prepareIasReimbursementBenefitSet(payload);
    return res.status(200).json(items);
  } catch (error) {
    debug('IAS reimbursement benefit set error: %s', error.message);
    return res.status(500).json({
      error: 'Failed to prepare IAS reimbursement benefit set',
      detail: error.message,
    });
  }
}

module.exports = {
  providerClaimJson,
  memberClaimJson,
  providerClaimJsonExcel,
  getMemberInfoByPolicy,
  prepareIasProviderClaimPayload,
  claimProviderClaim,
  submitClaimProviderClaim,
  prepareIasReimbursementBenefitSetController,
};
