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
  postClaimSubmission,
  postClaimStatus,
};

async function postClaimSubmission(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload is required');
  }

  const url = buildIasUrl(process.env.CL_CLAIM_API);
  console.log('IAS Claim Submission URL:', url);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });
  console.log('IAS Claim Submission Payload:', JSON.stringify(payload));

  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      data = { raw: text };
    }
  }
  console.log('IAS Claim Submission Response:', data);

  if (!response.ok) {
    const detail = data || { raw: text };
    debug('IAS claim submission request failed (%s): %o', response.status, detail);
    const err = new Error(`IAS claim submission request failed with status ${response.status}`);
    err.status = response.status;
    err.detail = detail;
    throw err;
  }

  return data;
}

async function postClaimStatus(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload is required');
  }

  const url = buildIasUrl(process.env.CL_CLAIM_STATUS_API);
  console.log('IAS Claim Status URL:', url);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });
  console.log('IAS Claim Status Payload:', JSON.stringify(payload));

  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      data = { raw: text };
    }
  }
  console.log('IAS Claim Status Response:', data);

  if (!response.ok) {
    const detail = data || { raw: text };
    debug('IAS claim status request failed (%s): %o', response.status, detail);
    const err = new Error(`IAS claim status request failed with status ${response.status}`);
    err.status = response.status;
    err.detail = detail;
    throw err;
  }

  return data;
}
