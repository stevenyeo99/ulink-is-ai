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

function buildProviderClaimSummary(ocrData) {
  if (!ocrData || typeof ocrData !== 'object') {
    return null;
  }
  const main = ocrData.main_sheet || {};
  const docs = ocrData.document_source_summary || {};

  const dateFrom = main.incur_date_from || '';
  const dateTo = main.incur_date_to || '';
  const date =
    dateFrom && dateTo && dateFrom !== dateTo ? `${dateFrom} to ${dateTo}` : dateFrom || dateTo;

  const providerCode = main.provider_code || '';
  const providerName = main.provider_name || '';
  const provider =
    providerCode && providerName
      ? `${providerCode} - ${providerName}`
      : providerName || providerCode;

  const benefitParts = [main.benefit_type, main.benefit_head].filter(Boolean);
  const currency = main.presented_currency || '';
  const amount = main.presented_amount || '';
  const presentedAmount =
    currency && amount ? `${amount} ${currency}` : amount || currency;
  const docSummaryParts = [
    `LOG: ${docs.log_file ? 'Provided' : 'Not provided'}`,
    `Medical Record: ${docs.medical_record_file ? 'Provided' : 'Not provided'}`,
    `Invoice: ${docs.invoice_file ? 'Provided' : 'Not provided'}`,
    `Missing: ${docs.missing_docs || 'Not available'}`,
    `Overall: ${docs.status || 'Not available'}`,
  ].filter(Boolean);

  return {
    name: main.last_first_name || docs.patient || '',
    date,
    provider,
    presentedAmount,
    benefitClassification: benefitParts.join(' / '),
    documentSummary: docSummaryParts.join('\n'),
  };
}

async function loadProviderClaimSummary(ocrPath) {
  if (!ocrPath) {
    return null;
  }
  try {
    const raw = await fs.promises.readFile(ocrPath, 'utf8');
    const parsed = JSON.parse(raw);
    return buildProviderClaimSummary(parsed);
  } catch (error) {
    debug('Failed to read provider claim OCR JSON (%s): %s', ocrPath, error.message);
    return null;
  }
}

function formatKeyDetails(ocrSummary) {
  if (!ocrSummary || typeof ocrSummary !== 'object') {
    return '';
  }

  const normalize = (value) => {
    const text = String(value || '').trim();
    return text ? text : 'Not available';
  };

  const documentSummary = normalize(ocrSummary.documentSummary);
  const formattedSummary = documentSummary
    ? [
        'Document Summary check:',
        documentSummary
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n'),
      ].join('\n')
    : 'Document Summary check: Not available';

  return [
    'Key Details:',
    `Name: ${normalize(ocrSummary.name)}`,
    `Date: ${normalize(ocrSummary.date)}`,
    `Provider Code & Name: ${normalize(ocrSummary.provider)}`,
    `Presented Amount: ${normalize(ocrSummary.presentedAmount)}`,
    `Benefit Classification: ${normalize(ocrSummary.benefitClassification)}`,
    formattedSummary,
  ].join('\n');
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

function formatIasResponseBlock(iasResponse) {
  if (!iasResponse) {
    return 'IAS provider claim response: (no response data available).';
  }
  if (typeof iasResponse === 'string') {
    return `IAS provider claim response: ${iasResponse}`;
  }
  const claimNo = iasResponse?.payload?.claimNo;
  if (iasResponse?.success === true && claimNo) {
    return [
      `Provider Claim No ${claimNo} is successfully created on IAS.`,
      'You may review this claim on IAS.',
    ].join(' ');
  }
  return ['IAS provider claim response:', JSON.stringify(iasResponse, null, 2)].join('\n');
}

function buildProviderClaimTemplate(claimNo, ocrSummary) {
  const keyDetails = formatKeyDetails(ocrSummary);
  return [
    'Thank you for submitting the provider claim request.',
    '',
    `Provider Claim No ${claimNo} is successfully created on IAS. You may review this claim record on IAS.`,
    '',
    ...(keyDetails ? [keyDetails, ''] : []),
    'Also attached the request payload that being used by AI to trigger into IAS provider claim API = provider-claim-request-payload.json',
    'For more details on each prompt result was generated, please refer to the attached Excel file = llm_prompt_document_result.xlsx',
    '',
    'Best Regards,',
    'ULINK AI Assistant',
  ].join('\n');
}

function buildFallbackReply({ type, subject, iasResponse, ocrSummary }) {
  if (type === 'provider_claim') {
    const keyDetails = formatKeyDetails(ocrSummary);
    const claimNo = iasResponse?.payload?.claimNo;
    if (iasResponse?.success === true && claimNo) {
      return {
        subject: subject || 'Provider claim request',
        body: buildProviderClaimTemplate(claimNo, ocrSummary),
      };
    }
    const responseBlock = formatIasResponseBlock(iasResponse);
    return {
      subject: subject || 'Provider claim request',
      body: [
        'Hello,',
        '',
        'Thanks for your request. The attached JSON is the request payload that will be used to call the IAS provider claim API = provider-claim-request-payload.json.',
        'For more details on each prompt result was generated, please refer to the attached Excel file = llm_prompt_document_result.xlsx.',
        '',
        ...(keyDetails ? [keyDetails, ''] : []),
        responseBlock,
        '',
        'Best Regards,',
        'ULINK AI Assistant',
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
      'ULINK AI Assistant',
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

function appendIasResponseIfMissing(body, iasResponse) {
  if (!iasResponse) {
    return body;
  }
  const marker = 'IAS provider claim response';
  if (body.toLowerCase().includes(marker.toLowerCase())) {
    return body;
  }
  const responseBlock = formatIasResponseBlock(iasResponse);
  const lines = body.trim().split('\n');
  const signatureIndex = lines.findIndex((line) => line.trim() === 'Best Regards,');
  if (signatureIndex !== -1) {
    const beforeSignature = lines.slice(0, signatureIndex).join('\n');
    const signature = lines.slice(signatureIndex).join('\n');
    return [beforeSignature.trim(), '', responseBlock, '', signature].join('\n');
  }
  return [body.trim(), '', responseBlock].join('\n');
}

async function replyProviderClaim({
  subject,
  to,
  payloadPath,
  ocrPath,
  excelPath,
  iasResponse,
  inReplyTo,
  references,
}) {
  debug('Provider claim reply queued for %s (subject: %s, payload: %s)', to, subject, payloadPath);
  const claimNo = iasResponse?.payload?.claimNo;
  const ocrSummary = await loadProviderClaimSummary(ocrPath);
  const { body, rawResponse } = await buildReplyFromLlm({
    type: 'provider_claim',
    subject,
    payloadPath,
    ocr_summary: ocrSummary,
    iasResponse,
  });

  const finalReply = isLikelyGarbled(body)
    ? buildFallbackReply({ type: 'provider_claim', subject, iasResponse, ocrSummary })
    : { subject, body: appendIasResponseIfMissing(body, iasResponse) };
  const finalBody =
    iasResponse?.success === true && claimNo
      ? buildProviderClaimTemplate(claimNo, ocrSummary)
      : finalReply.body;

  const attachments = [];
  if (payloadPath) {
    attachments.push({
      filename: path.basename(payloadPath),
      path: payloadPath,
      contentType: 'application/json',
    });
  }
  if (excelPath) {
    attachments.push({
      filename: path.basename(excelPath),
      path: excelPath,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  }

  const result = await sendEmail({
    to,
    subject: subject || 'Provider claim payload prepared',
    body: finalBody,
    attachments,
    inReplyTo,
    references,
  });

  return {
    status: 'sent',
    subject: subject || null,
    to,
    body: finalBody,
    payloadPath,
    iasResponse,
    llm_raw_response: rawResponse,
    messageId: result.messageId || null,
    fallbackUsed: finalReply.body !== body,
  };
}

module.exports = {
  replyNoAction,
  replyProviderClaim,
};
