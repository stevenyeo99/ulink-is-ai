const createDebug = require('debug');
const { fetchUnseenEmails } = require('../services/emailService');

const debug = createDebug('app:controller:email');

async function importEmails(req, res) {
  const { mailbox } = req.query;
  const limit = req.query.limit ? Number.parseInt(req.query.limit, 10) : undefined;

  try {
    const messages = await fetchUnseenEmails({ mailbox, limit });
    return res.status(200).json({
      count: messages.length,
      messages,
    });
  } catch (error) {
    debug('IMAP fetch error: %s', error.message);
    return res.status(500).json({
      error: 'Failed to fetch unseen emails',
      detail: error.message,
    });
  }
}

module.exports = {
  importEmails,
};
