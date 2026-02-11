const createDebug = require('debug');
const fs = require('fs');
const path = require('path');
const { logEvent } = require('./logEventService');

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
  logEvent({
    event: 'ias.member_info.request.started',
    message: 'Calling IAS member information API using memberNrc and meplEffDate.',
    status: 'info',
    action: 'ias_member_info',
    details: {
      memberNrc,
      meplEffDate,
      endpoint: url,
    },
  });
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
  downloadClaimFile,
};

async function postClaimSubmission(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload is required');
  }

  const url = buildIasUrl(process.env.CL_CLAIM_API);
  logEvent({
    event: 'ias.provider_claim.submission.started',
    message: 'Submitting IAS Provider New Claim API request.',
    status: 'info',
    action: 'ias_provider_new_claim',
    details: {
      endpoint: url,
      item_count: Array.isArray(payload?.Items) ? payload.Items.length : 0,
    },
  });
  // console.log('IAS Claim Submission URL:', url);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });
  // console.log('IAS Claim Submission Payload:', JSON.stringify(payload));

  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      data = { raw: text };
    }
  }
  // console.log('IAS Claim Submission Response:', data);

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

async function downloadClaimFile({ filepath, filename, downloadPath }) {
  if (!filepath || !filename) {
    throw new Error('filepath and filename are required');
  }
  if (!downloadPath) {
    const now = new Date();
    const year = String(now.getFullYear());
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    downloadPath = path.join('/mnt/c/github/ulink/download', year, month, day);
  }

  const url = buildIasUrl(process.env.CL_DOWNLOAD_FILE_API);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/octet-stream',
    },
    body: JSON.stringify({ filepath, filename }),
  });
  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`IAS download request failed with status ${response.status}`);
    err.status = response.status;
    err.detail = text;
    throw err;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.promises.mkdir(downloadPath, { recursive: true });
  const outputPath = path.join(downloadPath, filename);
  await fs.promises.writeFile(outputPath, buffer);

  return {
    path: outputPath,
    size: buffer.length,
  };
}
