const createDebug = require('debug');

const debug = createDebug('app:controller:health');

function healthCheck(req, res) {
  debug('Health check pinged');
  res.status(200).json({ status: 'ok' });
}

module.exports = {
  healthCheck,
};
