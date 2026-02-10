function maskSensitiveValue(value) {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.length <= 4) {
    return '*'.repeat(trimmed.length);
  }
  return `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`;
}

function sanitizeDetails(value, key = '') {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeDetails(entry, key));
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > 240) {
      return `${value.slice(0, 237)}...`;
    }
    return value;
  }

  const sensitiveKeys = new Set([
    'nrc',
    'membernrc',
    'member_nrc',
    'nrc_or_passport',
    'passport',
    'policy_no',
  ]);

  const output = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    const normalized = String(entryKey || '').toLowerCase();
    if (sensitiveKeys.has(normalized)) {
      output[entryKey] = maskSensitiveValue(entryValue);
      continue;
    }
    output[entryKey] = sanitizeDetails(entryValue, entryKey);
  }
  return output;
}

function logEvent({
  event,
  message,
  status = 'info',
  requestId = null,
  emailUid = null,
  action = null,
  durationMs = null,
  details = null,
} = {}) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const formattedTs = [
    pad(now.getDate()),
    pad(now.getMonth() + 1),
    now.getFullYear(),
  ].join('-') + ` ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const payload = {
    ts: formattedTs,
    event: event || 'app.event',
    status,
    message: message || '',
  };

  if (requestId) payload.request_id = requestId;
  if (emailUid !== null && emailUid !== undefined) payload.email_uid = emailUid;
  if (action) payload.action = action;
  if (typeof durationMs === 'number') payload.duration_ms = durationMs;
  if (details && typeof details === 'object') payload.details = sanitizeDetails(details);

  const tsText = payload.ts || '-';
  const emailUidText =
    payload.email_uid !== null && payload.email_uid !== undefined ? String(payload.email_uid) : '-';
  const actionText = payload.action ? String(payload.action) : '-';
  const messageText = payload.message || '';

  let detailsText = '';
  if (payload.details && typeof payload.details === 'object') {
    detailsText = Object.entries(payload.details)
      .map(([key, value]) => {
        if (key === 'reason') {
          if (typeof value === 'string') {
            const trimmed = value.trim();
            if (
              (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
              (trimmed.startsWith('[') && trimmed.endsWith(']'))
            ) {
              try {
                return `${key}=${JSON.stringify(JSON.parse(trimmed))}`;
              } catch (error) {
                return `${key}=${trimmed}`;
              }
            }
            return `${key}=${value}`;
          }
          if (value && typeof value === 'object') {
            return `${key}=${JSON.stringify(value)}`;
          }
        }
        if (Array.isArray(value)) {
          return `${key}=${JSON.stringify(value)}`;
        }
        if (value && typeof value === 'object') {
          return `${key}=${JSON.stringify(value)}`;
        }
        return `${key}=${value}`;
      })
      .join(', ');
  }

  const line = detailsText
    ? `[${tsText} - ${emailUidText} - ${actionText}] - ${messageText} | details: ${detailsText}`
    : `[${tsText} - ${emailUidText} - ${actionText}] - ${messageText}`;

  console.log(line);
}

module.exports = {
  logEvent,
};
