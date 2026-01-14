const {
  processPreApproval,
  buildIasPreApprovalPayload,
  submitClaimPreApprovalFromPaths,
} = require('../services/claimService');
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
    const { iasResponse } = await submitClaimPreApprovalFromPaths(paths);
    return res.status(200).json({
      ...iasResponse,
    });
  } catch (error) {
    debug('IAS submit claim pre-approval error: %s', error.message);
    if (error.status === 400) {
      return res.status(400).json({
        error: error.message,
      });
    }
    return res.status(502).json({
      error: 'Failed to submit IAS claim pre-approval',
      detail: error.detail || error.message,
    });
  }
}
