const createDebug = require('debug');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { requestAssistantJsonCompletion } = require('./llmService');

const debug = createDebug('app:service:email-reply');

let cachedReplyPrompt;

async function loadReplyPrompt() {
  if (cachedReplyPrompt) {
    return cachedReplyPrompt;
  }
  const promptPath = path.join(
    __dirname,
    '..',
    'prompts',
    'llm-descision',
    'llm_reply_system_prompt.md'
  );
  const prompt = await fs.promises.readFile(promptPath, 'utf8');
  cachedReplyPrompt = prompt;
  return prompt;
}

function getSmtpConfig() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASSWORD;
  const from = process.env.SMTP_FROM;

  if (!host || !user || !password || !from) {
    throw new Error('SMTP_HOST, SMTP_USER, SMTP_PASSWORD, and SMTP_FROM must be configured');
  }

  const port = Number.parseInt(process.env.SMTP_PORT || '465', 10);
  const secureEnv = String(process.env.SMTP_SECURE || '').toLowerCase();
  const secure = secureEnv === 'true' || secureEnv === '1' || port === 465;

  return {
    host,
    port,
    secure,
    auth: {
      user,
      pass: password,
    },
    from,
  };
}

function extractLlmText(response) {
  const choice = response?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
  }
  return '';
}

async function buildReplyFromLlm(context) {
  const prompt = await loadReplyPrompt();
  const response = await requestAssistantJsonCompletion({
    systemPrompt: prompt,
    inputJson: context,
  });
  return {
    body: extractLlmText(response),
    rawResponse: response,
  };
}

function isLikelyGarbled(text) {
  if (!text || typeof text !== 'string') {
    return true;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }
  const maxLength = 2000;
  if (trimmed.length > maxLength) {
    return true;
  }

  let printableCount = 0;
  let oddCount = 0;
  for (const char of trimmed) {
    const code = char.charCodeAt(0);
    const isPrintable = (code >= 32 && code <= 126) || char === '\n';
    if (isPrintable) {
      printableCount += 1;
    } else {
      oddCount += 1;
    }
  }
  const total = printableCount + oddCount;
  if (!total) {
    return true;
  }
  const printableRatio = printableCount / total;
  return printableRatio < 0.9;
}

function buildFallbackReply({ type, subject }) {
  if (type === 'pre_approval') {
    return {
      subject: subject || 'Pre-approval request',
      body: [
        'Hello,',
        '',
        'Thanks for your request. The attached JSON is the request payload that will be used to call the IAS claim pre-approval API.',
        '',
        'Best Regards,',
        'ULINK Assistant',
      ].join('\n'),
    };
  }
  return {
    subject: subject || 'No action taken',
    body: [
      'Hello,',
      '',
      'Thanks for your request. Our AI assistant did not take action for this message yet.',
      '',
      'Best Regards,',
      'ULINK Assistant',
    ].join('\n'),
  };
}

async function sendEmail({ to, subject, body, attachments, inReplyTo, references }) {
  const smtpConfig = getSmtpConfig();
  const transporter = nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure,
    auth: smtpConfig.auth,
  });

  return transporter.sendMail({
    from: smtpConfig.from,
    to,
    subject,
    text: body,
    attachments,
    inReplyTo,
    references,
  });
}

async function replyNoAction({ subject, to, reason, inReplyTo, references }) {
  debug('No-action reply queued for %s (subject: %s, reason: %s)', to, subject, reason);
  const { body, rawResponse } = await buildReplyFromLlm({
    type: 'no_action',
    subject,
    reason,
  });

  const finalReply = isLikelyGarbled(body)
    ? buildFallbackReply({ type: 'no_action', subject })
    : { subject, body };

  const result = await sendEmail({
    to,
    subject: subject || 'No action taken',
    body: finalReply.body,
    inReplyTo,
    references,
  });

  return {
    status: 'sent',
    subject: subject || null,
    to,
    body: finalReply.body,
    reason,
    llm_raw_response: rawResponse,
    messageId: result.messageId || null,
    fallbackUsed: finalReply.body !== body,
  };
}

async function replyPreApproval({ subject, to, payloadPath, inReplyTo, references }) {
  debug('Pre-approval reply queued for %s (subject: %s, payload: %s)', to, subject, payloadPath);
  const { body, rawResponse } = await buildReplyFromLlm({
    type: 'pre_approval',
    subject,
    payloadPath,
  });

  const finalReply = isLikelyGarbled(body)
    ? buildFallbackReply({ type: 'pre_approval', subject })
    : { subject, body };

  const attachments = payloadPath
    ? [
        {
          filename: path.basename(payloadPath),
          path: payloadPath,
          contentType: 'application/json',
        },
      ]
    : [];

  const result = await sendEmail({
    to,
    subject: subject || 'Pre-approval payload prepared',
    body: finalReply.body,
    attachments,
    inReplyTo,
    references,
  });

  return {
    status: 'sent',
    subject: subject || null,
    to,
    body: finalReply.body,
    payloadPath,
    llm_raw_response: rawResponse,
    messageId: result.messageId || null,
    fallbackUsed: finalReply.body !== body,
  };
}

module.exports = {
  replyNoAction,
  replyPreApproval,
};
