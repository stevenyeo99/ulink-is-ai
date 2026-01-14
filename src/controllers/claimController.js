const { processPreApproval } = require('../services/claimService');
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
};
