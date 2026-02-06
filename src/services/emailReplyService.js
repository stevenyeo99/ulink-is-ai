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

function buildGreeting(senderName) {
  const name = String(senderName || '').trim();
  return `Dear ${name || 'Customer'},`;
}

function buildFooter() {
  return ['Kind regards,', 'Ulink Assist'].join('\n');
}

function shouldUseNewTemplateReply() {
  return String(process.env.PROVIDER_CLAIM_USE_NEW_TEMPLATE || '').trim().toLowerCase() === 'true';
}

function applyFooter(body) {
  const footer = buildFooter();
  const text = String(body || '').trim();
  if (!text) {
    return footer;
  }
  const lower = text.toLowerCase();
  if (lower.includes('kind regards,') || lower.includes('best regards,')) {
    const lines = text.split('\n');
    const cutIndex = lines.findIndex((line) => {
      const trimmed = line.trim().toLowerCase();
      return trimmed.startsWith('kind regards,') || trimmed.startsWith('best regards,');
    });
    if (cutIndex !== -1) {
      return [...lines.slice(0, cutIndex), footer].join('\n').trim();
    }
  }
  return [text, '', footer].join('\n');
}

async function buildMissingDocsTemplateBody({ senderName, missingDocs, type }) {
  const templatePath = path.join(
    __dirname,
    '..',
    '..',
    'docs',
    'samples',
    'Provider',
    'missing-docs-email-temp.md'
  );
  let template = null;
  try {
    template = await fs.promises.readFile(templatePath, 'utf8');
  } catch (error) {
    template = null;
  }

  const name = senderName || 'Customer';
  const rawDocs = Array.isArray(missingDocs)
    ? missingDocs.filter(Boolean)
    : String(missingDocs || '').split(/,|\n/).map((item) => item.trim()).filter(Boolean);
  const cleanedDocs = rawDocs.map((doc) => doc.replace(/^missing\s+/i, '').trim()).filter(Boolean);
  const docLines =
    cleanedDocs.length > 0
      ? cleanedDocs.map((doc) => `• ${doc}`)
      : ['• Required document'];

  const providerNote =
    type === 'provider_claim'
      ? 'Note: We only process attachments from the most recent email in the thread. Please re-attach all required documents in a single reply.'
      : null;

  if (!template) {
    const fallback = [
      buildGreeting(name),
      '',
      'Thank you for submitting the documents for the above-mentioned case.',
      '',
      'We have reviewed the submission and noted that the documents received are currently incomplete. To proceed with the insurance approval, we kindly request your assistance to provide the following outstanding documents:',
      ...docLines,
      '',
      'Once we have received the complete set of required documents, we will proceed accordingly with the insurer.',
      providerNote,
      '',
      'Should you have any questions, please feel free to contact us or update the documents directly via the provider portal.',
      '',
      buildFooter(),
    ]
      .filter(Boolean)
      .join('\n');
    return fallback;
  }

  const docs = cleanedDocs.length > 0 ? cleanedDocs : ['Required document'];
  const baseLines = template.replace(/\[Sender Name\]/g, name).split('\n');
  const replaced = [];
  let docIndex = 0;
  for (const line of baseLines) {
    if (line.includes('[Document 1]') || line.includes('[Document 2]') || line.includes('[Document 3]')) {
      if (docIndex < docs.length) {
        replaced.push(line.replace(/\[Document \d\]/g, docs[docIndex]));
        docIndex += 1;
      }
      continue;
    }
    replaced.push(line);
  }
  if (docIndex < docs.length) {
    const extra = docs.slice(docIndex).map((doc) => `• ${doc}`);
    const insertAt = replaced.findIndex((line) => line.trim().toLowerCase().startsWith('once we have received'));
    if (insertAt === -1) {
      replaced.push(...extra);
    } else {
      replaced.splice(insertAt, 0, ...extra, '');
    }
  }
  if (providerNote) {
    const insertAt = replaced.findIndex((line) =>
      line.trim().toLowerCase().startsWith('once we have received')
    );
    if (insertAt === -1) {
      if (replaced[replaced.length - 1]?.trim() !== '') {
        replaced.push('');
      }
      replaced.push(providerNote);
    } else {
      if (replaced[insertAt + 1]?.trim() !== '') {
        replaced.splice(insertAt + 1, 0, '');
      }
      replaced.splice(insertAt + 2, 0, providerNote);
    }
  }
  return replaced.join('\n').trim();
}

async function buildCompleteDocsTemplateBody({ senderName }) {
  const templatePath = path.join(
    __dirname,
    '..',
    '..',
    'docs',
    'samples',
    'Provider',
    'complete-docs-email-temp.md'
  );
  let template = null;
  try {
    template = await fs.promises.readFile(templatePath, 'utf8');
  } catch (error) {
    template = null;
  }

  const name = senderName || 'Customer';
  if (!template) {
    return [
      buildGreeting(name),
      '',
      'Thank you for submitting the complete set of documents for the above-mentioned case.',
      '',
      'We confirm that all required documents have been received, and Ulink will proceed to submit them to the insurer for approval review.',
      '',
      'You may monitor the status via the provider portal or contact Ulink should you require any updates or clarification. We will also inform you should the insurer require any additional documents.',
      '',
      buildFooter(),
    ].join('\n');
  }

  return template.replace(/\[Sender Name\]/g, name).trim();
}

function applyGreeting(body, senderName) {
  const greeting = buildGreeting(senderName);
  const normalized = String(body || '').trim();
  if (!normalized) {
    return `${greeting}\n`;
  }
  if (normalized.toLowerCase().startsWith('dear ')) {
    return normalized;
  }
  return [greeting, '', normalized].join('\n');
}

function buildProviderClaimSummary(ocrData, benefitSet) {
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
    benefitReason: benefitSet?.reason || ocrData?.benefit_set?.reason || '',
    documentSummary: docSummaryParts.join('\n'),
  };
}

async function loadProviderClaimSummary(ocrPath, benefitSet) {
  if (!ocrPath) {
    return null;
  }
  try {
    const raw = await fs.promises.readFile(ocrPath, 'utf8');
    const parsed = JSON.parse(raw);
    return buildProviderClaimSummary(parsed, benefitSet);
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
    `Benefit Reason: ${normalize(ocrSummary.benefitReason)}`,
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

function buildProviderClaimTemplate(claimNo, ocrSummary, senderName) {
  const keyDetails = formatKeyDetails(ocrSummary);
  return [
    buildGreeting(senderName),
    '',
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

function buildFallbackReply({ type, subject, iasResponse, ocrSummary, senderName }) {
  if (type === 'provider_claim') {
    const keyDetails = formatKeyDetails(ocrSummary);
    const claimNo = iasResponse?.payload?.claimNo;
    if (iasResponse?.success === true && claimNo) {
      return {
        subject: subject || 'Provider claim request',
        body: buildProviderClaimTemplate(claimNo, ocrSummary, senderName),
      };
    }
    const responseBlock = formatIasResponseBlock(iasResponse);
    return {
      subject: subject || 'Provider claim request',
      body: [
        buildGreeting(senderName),
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
  if (type === 'reimbursement_claim') {
    return {
      subject: subject || 'Reimbursement claim processed',
      body: buildReimbursementClaimTemplate({
        claimNo: iasResponse?.claimNo,
        status: iasResponse?.status,
        approvedAmount: iasResponse?.approvedAmount,
        processedOn: iasResponse?.processedOn,
        senderName,
      }),
    };
  }
  return {
    subject: subject || 'No action taken',
    body: [
      buildGreeting(senderName),
      '',
      'Thanks for your request. Our AI assistant did not take action for this message yet.',
      '',
      'Best Regards,',
      'ULINK AI Assistant',
    ].join('\n'),
  };
}

function buildReimbursementClaimTemplate({
  claimNo,
  status,
  statusLines,
  approvedAmount,
  processedOn,
  senderName,
}) {
  const safeClaimNo = claimNo || 'Not available';
  const safeStatus = status || 'Not available';
  const safeApprovedAmount = approvedAmount || 'Not available';
  const safeProcessedOn = processedOn || 'Not available';
  const statusBlock =
    Array.isArray(statusLines) && statusLines.length > 0
      ? ['Status:', ...statusLines.map((line) => `${line.label}: ${line.status}`)]
      : [`Status: ${safeStatus}`];
  return [
    buildGreeting(senderName),
    '',
    'Your claim has been successfully processed by our system.',
    'Please find the claim result below, and the CSR document is attached for your reference.',
    'OCR extracted in JSON format can refer to ocr-json-extract.json.',
    'Request payload being used to submit reimbursement API can refer to reimbursement-claim-request-payload.json.',
    '',
    'Claim Summary',
    '',
    `Claim Number: ${safeClaimNo}`,
    ...statusBlock,
    `Approved Amount: ${safeApprovedAmount}`,
    `Processed On: ${safeProcessedOn}`,
    '',
    'Best Regards,',
    'ULINK AI Assistant',
  ].join('\n');
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

async function replyNoAction({ subject, to, reason, senderName, inReplyTo, references }) {
  debug('No-action reply queued for %s (subject: %s, reason: %s)', to, subject, reason);
  const { body, rawResponse } = await buildReplyFromLlm({
    type: 'no_action',
    subject,
    reason,
  });

  const finalReply = isLikelyGarbled(body)
    ? buildFallbackReply({ type: 'no_action', subject, senderName })
    : { subject, body: applyGreeting(body, senderName) };

  const finalBody = applyFooter(applyGreeting(finalReply.body, senderName));
  const result = await sendEmail({
    to,
    subject: subject || 'No action taken',
    body: finalBody,
    inReplyTo,
    references,
  });

  return {
    status: 'sent',
    subject: subject || null,
    to,
    body: finalBody,
    reason,
    llm_raw_response: rawResponse,
    messageId: result.messageId || null,
    fallbackUsed: finalReply.body !== body,
  };
}

function buildMissingAttachmentsBody(type, senderName) {
  const labelMap = {
    provider_claim: 'provider claim',
    reimbursement_claim: 'reimbursement claim',
    pre_assestment_form: 'pre-assessment form',
  };
  const label = labelMap[type] || 'request';
  const providerNote =
    type === 'provider_claim'
      ? 'Note: We only process attachments from the most recent email in the thread. Please re-attach all required documents in a single reply.'
      : null;
  return [
    buildGreeting(senderName),
    '',
    `Thanks for your request. We could not find any supported PDF or image attachments to process this ${label}.`,
    'Please reply with the claim documents as PDF or image attachments so we can continue.',
    providerNote,
    '',
    'Best Regards,',
    'ULINK AI Assistant',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildMissingDocumentsBody({ type, missingDocs, senderName }) {
  const label = type === 'provider_claim' ? 'provider claim' : 'claim';
  const missingText = missingDocs || 'Not available';
  return [
    buildGreeting(senderName),
    '',
    `Thanks for your request. We could not complete this ${label} because some required documents are missing.`,
    `System Validation: ${missingText}`,
    'Please re-upload all documents again (LOG, Medical Record, and Invoice/Bill) so we can continue.',
    '',
    'Best Regards,',
    'ULINK AI Assistant',
  ].join('\n');
}

async function replyMissingAttachments({ subject, to, type, senderName, inReplyTo, references }) {
  const labelMap = {
    provider_claim: 'Provider claim',
    reimbursement_claim: 'Reimbursement claim',
    pre_assestment_form: 'Pre-assessment form',
  };
  const label = labelMap[type] || 'Request';
  debug('Missing-attachments reply queued for %s (subject: %s, type: %s)', to, subject, type);

  const body = buildMissingAttachmentsBody(type, senderName);
  const finalBody = applyFooter(body);
  const result = await sendEmail({
    to,
    subject: subject || `${label} request missing attachments`,
    body: finalBody,
    inReplyTo,
    references,
  });

  return {
    status: 'sent',
    subject: subject || null,
    to,
    body: finalBody,
    type,
    messageId: result.messageId || null,
  };
}

async function replyPreAssessmentForm({ subject, to, pafPath, senderName, inReplyTo, references }) {
  debug('Pre-assessment form reply queued for %s (subject: %s, payload: %s)', to, subject, pafPath);
  const body = await buildCompleteDocsTemplateBody({ senderName });

  const finalBody = applyFooter(body);
  const attachments = [];
  if (pafPath) {
    attachments.push({
      filename: path.basename(pafPath),
      path: pafPath,
      contentType: 'application/json',
    });
  }

  const result = await sendEmail({
    to,
    subject: subject || 'Pre-assessment form JSON',
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
    pafPath,
    messageId: result.messageId || null,
  };
}

async function replyMissingDocuments({
  subject,
  to,
  type,
  missingDocs,
  senderName,
  inReplyTo,
  references,
}) {
  const label = type === 'provider_claim' ? 'Provider claim' : 'Claim';
  debug('Missing-documents reply queued for %s (subject: %s, type: %s)', to, subject, type);

  let body =
    type === 'pre_assestment_form' || type === 'provider_claim'
      ? await buildMissingDocsTemplateBody({ senderName, missingDocs, type })
      : buildMissingDocumentsBody({ type, missingDocs, senderName });
  const finalBody = applyFooter(body);
  const result = await sendEmail({
    to,
    subject: subject || `${label} request missing documents`,
    body: finalBody,
    inReplyTo,
    references,
  });

  return {
    status: 'sent',
    subject: subject || null,
    to,
    body: finalBody,
    type,
    missingDocs: missingDocs || null,
    messageId: result.messageId || null,
  };
}

function buildMemberPlanMissingBody(senderName) {
  return [
    buildGreeting(senderName),
    '',
    'Thanks for your request. The related member plan record on IAS for this claim does not exist.',
    'Please verify the member details and resend the claim documents.',
    '',
    'Best Regards,',
    'ULINK AI Assistant',
  ].join('\n');
}

function buildSystemErrorBody(type, senderName) {
  const labelMap = {
    provider_claim: 'provider claim',
    reimbursement_claim: 'reimbursement claim',
    pre_assestment_form: 'pre-assessment form',
  };
  const label = labelMap[type] || 'claim';
  return [
    buildGreeting(senderName),
    '',
    `Thanks for your request. We hit a system error while processing this ${label}.`,
    'Please contact the IT team to check this case.',
    '',
    'Best Regards,',
    'ULINK AI Assistant',
  ].join('\n');
}

async function replyMemberPlanMissing({ subject, to, type, senderName, inReplyTo, references }) {
  const label =
    type === 'provider_claim'
      ? 'Provider claim'
      : type === 'reimbursement_claim'
        ? 'Reimbursement claim'
        : 'Claim';
  debug('Member-plan-missing reply queued for %s (subject: %s, type: %s)', to, subject, type);
  const body = buildMemberPlanMissingBody(senderName);
  const finalBody = applyFooter(body);
  const result = await sendEmail({
    to,
    subject: subject || `${label} missing member plan`,
    body: finalBody,
    inReplyTo,
    references,
  });

  return {
    status: 'sent',
    subject: subject || null,
    to,
    body: finalBody,
    messageId: result.messageId || null,
  };
}

async function replySystemError({ subject, to, type, senderName, inReplyTo, references }) {
  const labelMap = {
    provider_claim: 'Provider claim',
    reimbursement_claim: 'Reimbursement claim',
    pre_assestment_form: 'Pre-assessment form',
  };
  const label = labelMap[type] || 'Claim';
  debug('System-error reply queued for %s (subject: %s, type: %s)', to, subject, type);
  const body = buildSystemErrorBody(type, senderName);
  const finalBody = applyFooter(body);
  const result = await sendEmail({
    to,
    subject: subject || `${label} system error`,
    body: finalBody,
    inReplyTo,
    references,
  });

  return {
    status: 'sent',
    subject: subject || null,
    to,
    body: finalBody,
    messageId: result.messageId || null,
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
  const signatureIndex = lines.findIndex((line) => {
    const trimmed = line.trim().toLowerCase();
    return trimmed === 'best regards,' || trimmed === 'kind regards,';
  });
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
  benefitSet,
  senderName,
  inReplyTo,
  references,
}) {
  debug('Provider claim reply queued for %s (subject: %s, payload: %s)', to, subject, payloadPath);
  const claimNo = iasResponse?.payload?.claimNo;
  const ocrSummary = await loadProviderClaimSummary(ocrPath, benefitSet);
  const { body, rawResponse } = await buildReplyFromLlm({
    type: 'provider_claim',
    subject,
    payloadPath,
    ocr_summary: ocrSummary,
    iasResponse,
  });

  const finalReply = isLikelyGarbled(body)
    ? buildFallbackReply({ type: 'provider_claim', subject, iasResponse, ocrSummary, senderName })
    : { subject, body: appendIasResponseIfMissing(body, iasResponse) };
  const baseSuccessBody = buildProviderClaimTemplate(claimNo, ocrSummary, senderName);
  const useNewTemplate = shouldUseNewTemplateReply();
  const finalBody = applyFooter(
    iasResponse?.success === true && claimNo
      ? (useNewTemplate
          ? await buildCompleteDocsTemplateBody({ senderName })
          : baseSuccessBody)
      : applyGreeting(finalReply.body, senderName)
  );

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
  if (useNewTemplate && iasResponse?.success === true && claimNo) {
    attachments.push({
      filename: 'provider-claim-original-reply.txt',
      content: baseSuccessBody,
      contentType: 'text/plain',
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
    isNewTempEmailReply: useNewTemplate,
  };
}

function buildReimbursementSummary(claimStatusResponse) {
  const latest = claimStatusResponse?.payload?.results?.[0] || {};
  return {
    status: latest.SCMA_OID_CL_STATUS || null,
    processedOn: latest.CRT_DATETIME || null,
  };
}

function buildReimbursementLineStatus(submissionResponse, fallbackStatus) {
  const lineResults = submissionResponse?.payload?.lineResults;
  if (!Array.isArray(lineResults) || lineResults.length === 0) {
    return { statusText: fallbackStatus || null, statusLines: null };
  }

  const statusLines = lineResults.map((lineResult, index) => {
    const lineNo = lineResult?.lineNo ?? lineResult?.line_no ?? index + 1;
    const status =
      lineResult?.status ?? lineResult?.lineStatus ?? lineResult?.line_status ?? 'Not available';
    return {
      label: `Line ${lineNo ?? index + 1}`,
      status,
    };
  });

  const allApproved = statusLines.every((line) => line.status === 'Approved');
  if (allApproved) {
    return { statusText: 'Approved', statusLines: null };
  }

  return {
    statusText: statusLines.map((line) => `${line.label}: ${line.status}`).join('\n'),
    statusLines,
  };
}

function formatApprovedAmount(approvedAmount) {
  if (approvedAmount === null || approvedAmount === undefined || approvedAmount === '') {
    return null;
  }
  const numeric = typeof approvedAmount === 'number' ? approvedAmount : Number(approvedAmount);
  if (!Number.isFinite(numeric)) {
    return String(approvedAmount);
  }
  return numeric.toLocaleString('en-US');
}

function formatProcessedOn(processedOn) {
  if (!processedOn) {
    return null;
  }
  const raw = String(processedOn).trim();
  const match = raw.match(/^(\d{2})(\d{2})(\d{4})_/);
  if (!match) {
    return raw;
  }
  const monthIndex = Number(match[1]) - 1;
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!Number.isFinite(monthIndex) || !Number.isFinite(day) || !Number.isFinite(year)) {
    return raw;
  }
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthLabel = months[monthIndex];
  if (!monthLabel) {
    return raw;
  }
  return `${String(day).padStart(2, '0')}-${monthLabel}-${year}`;
}

async function replyReimbursementClaim({
  subject,
  to,
  claimNo,
  claimStatusResponse,
  submissionResponse,
  downloadedFilePath,
  ocrPayloadPath,
  claimPayloadPath,
  senderName,
  inReplyTo,
  references,
}) {
  debug('Reimbursement claim reply queued for %s (subject: %s, claim: %s)', to, subject, claimNo);
  const summary = buildReimbursementSummary(claimStatusResponse);
  const statusDetails = buildReimbursementLineStatus(submissionResponse, summary.status);
  const approvedAmount = formatApprovedAmount(submissionResponse?.payload?.totalApprovedAmt ?? null);
  const { body, rawResponse } = await buildReplyFromLlm({
    type: 'reimbursement_claim',
    subject,
    claimNo,
    status: statusDetails.statusText,
    approvedAmount,
    processedOn: summary.processedOn,
  });

  const finalReply = isLikelyGarbled(body)
    ? buildFallbackReply({
        type: 'reimbursement_claim',
        subject,
        iasResponse: { claimNo, status: summary.status, processedOn: summary.processedOn },
        senderName,
      })
    : { subject, body: applyGreeting(body, senderName) };

  const finalBody = applyFooter(buildReimbursementClaimTemplate({
    claimNo,
    status: statusDetails.statusText,
    statusLines: statusDetails.statusLines,
    approvedAmount,
    processedOn: formatProcessedOn(summary.processedOn),
    senderName,
  }));

  const attachments = [];
  if (downloadedFilePath) {
    attachments.push({
      filename: path.basename(downloadedFilePath),
      path: downloadedFilePath,
    });
  }
  if (ocrPayloadPath) {
    attachments.push({
      filename: path.basename(ocrPayloadPath),
      path: ocrPayloadPath,
    });
  }
  if (claimPayloadPath) {
    attachments.push({
      filename: path.basename(claimPayloadPath),
      path: claimPayloadPath,
    });
  }

  const result = await sendEmail({
    to,
    subject: subject || 'Reimbursement claim processed',
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
    claimNo,
    downloadedFilePath,
    llm_raw_response: rawResponse,
    messageId: result.messageId || null,
    fallbackUsed: finalReply.body !== body,
  };
}

module.exports = {
  replyMissingAttachments,
  replyMissingDocuments,
  replyMemberPlanMissing,
  replyNoAction,
  replyPreAssessmentForm,
  replyProviderClaim,
  replyReimbursementClaim,
  replySystemError,
};
