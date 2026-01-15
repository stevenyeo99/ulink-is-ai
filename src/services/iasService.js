const createDebug = require('debug');

const debug = createDebug('app:service:ias');

function buildIasUrl(endpoint) {
  if (!endpoint) {
    throw new Error('GET_MEMBER_INFO_API must be configured');
  }
  if (/^https?:\/\//i.test(endpoint)) {
    return endpoint;
  }
  const baseUrl = process.env.IAS_URL;
  if (!baseUrl) {
    throw new Error('IAS_URL must be configured');
  }
  return new URL(endpoint, baseUrl).toString();
}

async function postMemberInfoByPolicy({ memberNrc, meplEffDate }) {
  if (!memberNrc || !meplEffDate) {
    throw new Error('memberNrc and meplEffDate are required');
  }

  const url = buildIasUrl(process.env.GET_MEMBER_INFO_API);
  console.log('IAS URL:', url);
  console.log('IAS Payload:', JSON.stringify({ memberNrc, meplEffDate }));
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ memberNrc, meplEffDate }),
  });

  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    const detail = data || { raw: text };
    debug('IAS request failed (%s): %o', response.status, detail);
    const err = new Error(`IAS request failed with status ${response.status}`);
    err.status = response.status;
    err.detail = detail;
    throw err;
  }

  return data;
}

module.exports = {
  postMemberInfoByPolicy,
  postProviderClaim,
};

async function postProviderClaim(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload is required');
  }

  const url = buildIasUrl(process.env.CL_CLAIM_API);
  console.log('IAS Provider Claim URL:', url);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });
  console.log('IAS Provider Claim Payload:', JSON.stringify(payload));

  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      data = { raw: text };
    }
  }
  console.log('IAS Provider Claim Response:', data);

  if (!response.ok) {
    const detail = data || { raw: text };
    debug('IAS provider claim request failed (%s): %o', response.status, detail);
    const err = new Error(`IAS provider claim request failed with status ${response.status}`);
    err.status = response.status;
    err.detail = detail;
    throw err;
  }

  return data;
}
