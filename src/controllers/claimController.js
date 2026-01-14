const { processPreApproval } = require('../services/claimService');
const { postMemberInfoByPolicy } = require('../services/iasService');
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
