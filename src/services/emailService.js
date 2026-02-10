const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const createDebug = require('debug');
const {
  requestAssistantJsonCompletion,
  extractStructuredJson,
} = require('./llmService');
const {
  submitProviderClaimFromPaths,
  processPreAssessmentForm,
  processReimbursementClaimFromPaths,
} = require('./claimService');
const { saveProviderClaimWorkbook } = require('./excelService');
const {
  replyMissingAttachments,
  replyMissingDocuments,
  replyMemberPlanMissing,
  replyNoAction,
  replyPreAssessmentForm,
  replyProviderClaim,
  replyReimbursementClaim,
  replySystemError,
} = require('./emailReplyService');
const { logEvent } = require('./logEventService');

const debug = createDebug('app:service:email');

function createRequestId(message) {
  const uid = message?.uid || 'unknown';
  const token = Math.random().toString(36).slice(2, 8);
  return `email-${uid}-${Date.now().toString(36)}-${token}`;
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'n'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function withTimeout(promise, timeoutMs, label) {
  if (!timeoutMs) {
    return promise;
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const suffix = label ? ` (${label})` : '';
      const error = new Error(`Timed out after ${timeoutMs}ms${suffix}`);
      error.code = 'ETIMEDOUT';
      reject(error);
    }, timeoutMs);
    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function getImapConfig() {
  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const password = process.env.IMAP_PASSWORD;

  if (!host || !user || !password) {
    throw new Error('IMAP_HOST, IMAP_USER, and IMAP_PASSWORD must be configured');
  }

  return {
    host,
    port: parseInteger(process.env.IMAP_PORT, 993),
    secure: parseBoolean(process.env.IMAP_TLS, true),
    user,
    password,
    importBaseDir: process.env.IMAP_IMPORT_BASE_DIR || null,
    importLimit: parseInteger(process.env.IMAP_IMPORT_LIMIT, undefined),
    messageTimeoutMs: parseInteger(process.env.IMAP_MESSAGE_TIMEOUT_MS, undefined),
  };
}

function formatAddressList(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .map((address) => {
      if (!address) {
        return null;
      }
      if (address.name) {
        return `${address.name} <${address.address}>`;
      }
      return address.address;
    })
    .filter(Boolean);
}

function formatAddressOnlyList(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .map((address) => (address ? address.address : null))
    .filter(Boolean);
}

function stripHtmlToText(html) {
  if (!html) {
    return '';
  }
  return String(html)
    .replace(/<\s*script[^>]*>[\s\S]*?<\s*\/\s*script>/gi, ' ')
    .replace(/<\s*style[^>]*>[\s\S]*?<\s*\/\s*style>/gi, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*p\s*>/gi, '\n')
    .replace(/<\s*p\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildDecisionBody(parsed) {
  const text = String(parsed?.text || '').trim();
  const htmlText = stripHtmlToText(parsed?.html || '');
  if (text && htmlText && text !== htmlText) {
    return [text, '', '---', htmlText].join('\n').trim();
  }
  return (text || htmlText || '').trim();
}

function getSenderName(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return null;
  }
  const first = list.find((entry) => entry && (entry.name || entry.address)) || list[0];
  if (!first) {
    return null;
  }
  if (first.name) {
    return String(first.name).trim() || null;
  }
  const address = String(first.address || '').trim();
  if (!address) {
    return null;
  }
  const local = address.split('@')[0];
  return local || address;
}

function sanitizeFilename(value) {
  return String(value || '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

function isSupportedClaimAttachment(attachment) {
  if (!attachment) {
    return false;
  }
  if (attachment.contentType === 'application/pdf') {
    return true;
  }
  if (typeof attachment.contentType === 'string' && attachment.contentType.startsWith('image/')) {
    return true;
  }
  const ext = path.extname(attachment.filename || '').toLowerCase();
  return ['.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.gif', '.webp'].includes(ext);
}

function buildAttachmentMeta(attachment, filePath) {
  return {
    filename: attachment.filename || null,
    contentType: attachment.contentType || null,
    size: attachment.size || null,
    path: filePath || null,
  };
}

function formatDateParts(date) {
  const value = date instanceof Date ? date : new Date();
  if (Number.isNaN(value.getTime())) {
    const fallback = new Date();
    return {
      year: String(fallback.getFullYear()),
      month: String(fallback.getMonth() + 1).padStart(2, '0'),
      day: String(fallback.getDate()).padStart(2, '0'),
    };
  }

  return {
    year: String(value.getFullYear()),
    month: String(value.getMonth() + 1).padStart(2, '0'),
    day: String(value.getDate()).padStart(2, '0'),
  };
}

async function saveParsedMessage(importBaseDir, message, parsed) {
  if (!importBaseDir) {
    return {
      outputDir: null,
      contentPath: null,
      metadataPath: null,
      attachments: [],
      supportedAttachmentPaths: [],
    };
  }

  const { year, month, day } = formatDateParts(message.internalDate);
  const rawMessageId = parsed.messageId || (message.envelope && message.envelope.messageId) || '';
  const messageId = sanitizeFilename(rawMessageId);
  const folderName = messageId || `email-${message.uid}`;
  const outputDir = path.join(importBaseDir, year, month, day, folderName);

  await fs.promises.mkdir(outputDir, { recursive: true });

  const subjectLine = parsed.subject ? `# ${parsed.subject}\n\n` : '';
  const content = parsed.text || parsed.html || '';
  const contentPath = path.join(outputDir, 'content.md');
  await fs.promises.writeFile(contentPath, `${subjectLine}${content}`);

  const metadataPath = path.join(outputDir, 'metadata.json');
  const metadata = {
    subject: parsed.subject || null,
    from: formatAddressOnlyList(parsed.from?.value),
    cc: formatAddressOnlyList(parsed.cc?.value),
  };
  await fs.promises.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

  const attachments = [];
  const supportedAttachmentPaths = [];
  if (Array.isArray(parsed.attachments)) {
    for (const attachment of parsed.attachments) {
      if (!attachment || !attachment.content) {
        continue;
      }
      const safeName = sanitizeFilename(attachment.filename || attachment.checksum || 'attachment');
      const attachmentPath = path.join(outputDir, safeName);
      await fs.promises.writeFile(attachmentPath, attachment.content);
      attachments.push(buildAttachmentMeta(attachment, attachmentPath));
      if (isSupportedClaimAttachment(attachment)) {
        supportedAttachmentPaths.push(attachmentPath);
      }
    }
  }

  return {
    outputDir,
    contentPath,
    metadataPath,
    attachments,
    supportedAttachmentPaths,
  };
}

const decisionSchema = {
  name: 'llm_email_decision',
  schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['provider_claim', 'reimbursement_claim', 'pre_assestment_form', 'no_action'],
      },
      reason: { type: 'string' },
      confidence: { type: 'number' },
    },
    required: ['action'],
  },
};

let cachedDecisionPrompts;

async function loadDecisionPrompts() {
  if (cachedDecisionPrompts) {
    return cachedDecisionPrompts;
  }
  const baseDir = path.join(__dirname, '..', 'prompts', 'llm-descision');
  const systemPromptPath = path.join(baseDir, 'llm_descision_system_prompt.md');
  const functionCatalogPath = path.join(baseDir, 'llm_descision_function_catalog.md');
  const [systemPrompt, functionCatalog] = await Promise.all([
    fs.promises.readFile(systemPromptPath, 'utf8'),
    fs.promises.readFile(functionCatalogPath, 'utf8'),
  ]);

  cachedDecisionPrompts = {
    systemPrompt,
    functionCatalog,
  };
  return cachedDecisionPrompts;
}

async function decideEmailAction(decisionInput) {
  const subject = String(decisionInput?.subject || '');
  const body = String(decisionInput?.body || '');
  const combined = `${subject}\n${body}`.toLowerCase();
  const hasPaf =
    /(^|[^a-z0-9])paf([^a-z0-9]|$)/i.test(subject) ||
    /(^|[^a-z0-9])paf([^a-z0-9]|$)/i.test(body);
  const hasPreApproval =
    combined.includes('pre approval') ||
    combined.includes('pre-approval') ||
    combined.includes('preapproval') ||
    combined.includes('pre approval of treatment') ||
    combined.includes('pre-approval of treatment');
  const hasPreAdmission =
    combined.includes('pre admission') ||
    combined.includes('pre-admission') ||
    combined.includes('pre assessment') ||
    combined.includes('pre-assessment');

  if (hasPaf || hasPreApproval || hasPreAdmission) {
    return {
      decision: {
        action: 'pre_assestment_form',
        reason: 'Matched pre-assessment/pre-admission/PAF/pre-approval keywords',
        confidence: 0.95,
      },
      rawResponse: null,
    };
  }

  const prompts = await loadDecisionPrompts();
  const systemPrompt = `${prompts.systemPrompt}\n\n${prompts.functionCatalog}`;
  const response = await requestAssistantJsonCompletion({
    systemPrompt,
    inputJson: decisionInput,
    jsonSchema: decisionSchema,
  });

  return {
    decision: extractStructuredJson(response),
    rawResponse: response,
  };
}

async function fetchUnseenEmails({ mailbox = 'INBOX', limit } = {}) {
  const config = getImapConfig();
  const effectiveLimit =
    Number.isInteger(limit) && limit > 0 ? limit : config.importLimit;

  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.password,
    },
    logger: false,
  });

  let connected = false;
  let lock;

  try {
    await client.connect();
    connected = true;

    lock = await client.getMailboxLock(mailbox);
    const unseenUids = await client.search({ seen: false });
    logEvent({
      event: 'email.poll.complete',
      message: 'Checked inbox for unseen emails.',
      status: 'success',
      details: {
        mailbox,
        unseen_count: unseenUids.length,
      },
    });

    if (!unseenUids.length) {
      return [];
    }

    const fetched = [];
    for await (const message of client.fetch(unseenUids, {
      uid: true,
      envelope: true,
      internalDate: true,
      source: true,
    })) {
      fetched.push(message);
    }

    fetched.sort((a, b) => {
      const left = a.internalDate ? new Date(a.internalDate).getTime() : 0;
      const right = b.internalDate ? new Date(b.internalDate).getTime() : 0;
      return left - right;
    });

    const limited = effectiveLimit ? fetched.slice(0, effectiveLimit) : fetched;
    const results = [];

    for (const message of limited) {
      let processed = false;
      let decisionSummary = null;
      const requestId = createRequestId(message);
      const messageStartedAt = Date.now();

      const processMessage = async () => {
        let localProcessed = false;
        const parsed = await simpleParser(message.source);
        logEvent({
          event: 'email.message.parsed',
          message: 'We received a new email and started processing it.',
          status: 'start',
          requestId,
          emailUid: message.uid,
          details: {
            subject: parsed.subject || message?.envelope?.subject || null,
            from: formatAddressOnlyList(parsed.from?.value),
            has_attachments: Array.isArray(parsed.attachments) && parsed.attachments.length > 0,
          },
        });
        const storage = await saveParsedMessage(config.importBaseDir, message, parsed);
        const attachmentCount = Array.isArray(storage.attachments) ? storage.attachments.length : 0;
        const supportedCount = Array.isArray(storage.supportedAttachmentPaths)
          ? storage.supportedAttachmentPaths.length
          : 0;
        logEvent({
          event: 'email.attachments.saved',
          message: `${attachmentCount} attachment(s) were downloaded and stored.`,
          status: 'success',
          requestId,
          emailUid: message.uid,
          details: {
            output_dir: storage.outputDir,
            attachment_count: attachmentCount,
            supported_attachment_count: supportedCount,
            attachments: (storage.attachments || []).map((item) => ({
              filename: item.filename || null,
              contentType: item.contentType || null,
              size: item.size || null,
            })),
          },
        });
        const envelope = message.envelope || {};

        try {
          const decisionInput = {
            subject: parsed.subject || envelope.subject || null,
            from: formatAddressOnlyList(parsed.from?.value),
            cc: formatAddressOnlyList(parsed.cc?.value),
            date: message.internalDate ? new Date(message.internalDate).toISOString() : null,
            body: buildDecisionBody(parsed),
            attachments: storage.attachments,
          };

          logEvent({
            event: 'flow.decision.started',
            message: 'System is identifying which processing flow applies to this email.',
            status: 'start',
            requestId,
            emailUid: message.uid,
            details: {
              subject: decisionInput.subject,
            },
          });
          const { decision, rawResponse } = await decideEmailAction(decisionInput);
          console.log('[email-decision]', {
            subject: decisionInput.subject,
            action: decision?.action || null,
            reason: decision?.reason || null,
            confidence: decision?.confidence || null,
          });
          logEvent({
            event: 'flow.decision.completed',
            message: `This email was identified as ${decision?.action || 'no_action'}.`,
            status: 'success',
            requestId,
            emailUid: message.uid,
            action: decision?.action || null,
            details: {
              reason: decision?.reason || null,
              confidence: decision?.confidence || null,
            },
          });
          decisionSummary = decision;
          const senderName = getSenderName(parsed.from?.value);

          if (storage.metadataPath) {
            const updatedMetadata = {
              subject: parsed.subject || null,
              from: formatAddressOnlyList(parsed.from?.value),
              cc: formatAddressOnlyList(parsed.cc?.value),
              llm_decision: {
                ...decision,
                raw_response: rawResponse,
                decided_at: new Date().toISOString(),
              },
            };
            await fs.promises.writeFile(
              storage.metadataPath,
              `${JSON.stringify(updatedMetadata, null, 2)}\n`
            );
          }

          if (decision.action === 'pre_assestment_form') {
            logEvent({
              event: 'flow.pre_assessment.started',
              message: 'Starting pre-assessment form processing.',
              status: 'start',
              requestId,
              emailUid: message.uid,
              action: decision.action,
              details: {
                supported_attachment_count: storage.supportedAttachmentPaths.length,
              },
            });
            if (!storage.supportedAttachmentPaths.length) {
              const replyResult = await replyMissingAttachments({
                subject: parsed.subject || envelope.subject || null,
                to: formatAddressOnlyList(parsed.from?.value),
                type: 'pre_assestment_form',
                senderName,
                inReplyTo: parsed.messageId || envelope.messageId || null,
                references: parsed.messageId || envelope.messageId || null,
              });
              if (storage.outputDir) {
                const replyPath = path.join(storage.outputDir, 'reply.json');
                await fs.promises.writeFile(
                  replyPath,
                  `${JSON.stringify({ type: 'pre_assestment_form_missing_attachments', ...replyResult }, null, 2)}\n`
                );
              }
              logEvent({
                event: 'flow.pre_assessment.missing_attachments',
                message: 'No supported attachments were found for pre-assessment processing.',
                status: 'warning',
                requestId,
                emailUid: message.uid,
                action: decision.action,
              });
              localProcessed = true;
              return { storage, envelope, processed: localProcessed };
            }

            try {
              const preAssessmentResult = await processPreAssessmentForm(
                storage.supportedAttachmentPaths,
                { requestId, emailUid: message.uid, action: decision.action }
              );
              let pafPath = null;

              if (storage.outputDir) {
                pafPath = path.join(storage.outputDir, 'PAF.json');
                await fs.promises.writeFile(
                  pafPath,
                  `${JSON.stringify(preAssessmentResult, null, 2)}\n`
                );
              }

              const replyResult = await replyPreAssessmentForm({
                subject: parsed.subject || envelope.subject || null,
                to: formatAddressOnlyList(parsed.from?.value),
                pafPath,
                senderName,
                inReplyTo: parsed.messageId || envelope.messageId || null,
                references: parsed.messageId || envelope.messageId || null,
              });

              if (storage.outputDir) {
                const replyPath = path.join(storage.outputDir, 'reply.json');
                await fs.promises.writeFile(
                  replyPath,
                  `${JSON.stringify({ type: 'pre_assestment_form', ...replyResult }, null, 2)}\n`
                );
              }
              logEvent({
                event: 'flow.pre_assessment.completed',
                message: 'Pre-assessment form processing completed and reply was prepared.',
                status: 'success',
                requestId,
                emailUid: message.uid,
                action: decision.action,
              });
            } catch (error) {
              const isMissingDocs = error?.code === 'MISSING_DOCS';
              const isMissingRequiredFields = error?.code === 'MISSING_REQUIRED_FIELDS';
              let missingDocs = null;
              if (isMissingDocs) {
                missingDocs = error?.detail?.missing_docs || null;
              } else if (isMissingRequiredFields) {
                const fieldLabels = {
                  patient_name: 'Patient name',
                  nrc_or_passport: 'NRC or passport',
                  diagnosis: 'Diagnosis',
                  hospital_name: 'Hospital name',
                  admission_date: 'Admission date',
                  signature: 'Signature',
                };
                const missingFields = Array.isArray(error?.detail?.missing_fields)
                  ? error.detail.missing_fields
                  : [];
                missingDocs = missingFields
                  .map((field) => fieldLabels[field] || field)
                  .filter(Boolean);
              }

              const replyResult = isMissingDocs || isMissingRequiredFields
                ? await replyMissingDocuments({
                    subject: parsed.subject || envelope.subject || null,
                    to: formatAddressOnlyList(parsed.from?.value),
                    type: 'pre_assestment_form',
                    missingDocs,
                    senderName,
                    inReplyTo: parsed.messageId || envelope.messageId || null,
                    references: parsed.messageId || envelope.messageId || null,
                  })
                : await replySystemError({
                    subject: parsed.subject || envelope.subject || null,
                    to: formatAddressOnlyList(parsed.from?.value),
                    type: 'pre_assestment_form',
                    senderName,
                    inReplyTo: parsed.messageId || envelope.messageId || null,
                    references: parsed.messageId || envelope.messageId || null,
                  });
              if (storage.outputDir) {
                const replyPath = path.join(storage.outputDir, 'reply.json');
                const replyType = isMissingDocs
                  ? 'pre_assestment_form_missing_docs'
                  : isMissingRequiredFields
                    ? 'pre_assestment_form_missing_required_fields'
                    : 'pre_assestment_form_system_error';
                await fs.promises.writeFile(
                  replyPath,
                  `${JSON.stringify({ type: replyType, ...replyResult }, null, 2)}\n`
                );
              }
              logEvent({
                event: 'flow.pre_assessment.failed',
                message: 'Pre-assessment flow finished with missing items or system error.',
                status: isMissingDocs || isMissingRequiredFields ? 'warning' : 'error',
                requestId,
                emailUid: message.uid,
                action: decision.action,
                details: {
                  error_code: error?.code || null,
                  missing_docs: missingDocs,
                  reason: error?.detail?.reason || null,
                },
              });
              localProcessed = true;
              return { storage, envelope, processed: localProcessed };
            }
          } else if (decision.action === 'provider_claim') {
            logEvent({
              event: 'flow.provider_claim.started',
              message: 'Starting provider claim processing.',
              status: 'start',
              requestId,
              emailUid: message.uid,
              action: decision.action,
              details: {
                supported_attachment_count: storage.supportedAttachmentPaths.length,
              },
            });
            if (!storage.supportedAttachmentPaths.length) {
              const replyResult = await replyMissingAttachments({
                subject: parsed.subject || envelope.subject || null,
                to: formatAddressOnlyList(parsed.from?.value),
                type: 'provider_claim',
                senderName,
                inReplyTo: parsed.messageId || envelope.messageId || null,
                references: parsed.messageId || envelope.messageId || null,
              });
              if (storage.outputDir) {
                const replyPath = path.join(storage.outputDir, 'reply.json');
                await fs.promises.writeFile(
                  replyPath,
                  `${JSON.stringify({ type: 'provider_claim_missing_attachments', ...replyResult }, null, 2)}\n`
                );
              }
              logEvent({
                event: 'flow.provider_claim.missing_attachments',
                message: 'No supported attachments were found for provider claim processing.',
                status: 'warning',
                requestId,
                emailUid: message.uid,
                action: decision.action,
              });
              localProcessed = true;
              return { storage, envelope, processed: localProcessed };
            }
            try {
              const { providerClaimResult, providerClaimPayload, iasResponse, benefitSet } =
                await submitProviderClaimFromPaths(storage.supportedAttachmentPaths, {
                  requestId,
                  emailUid: message.uid,
                  action: decision.action,
                });
              let payloadPath = null;
              let ocrPath = null;
              let excelPath = null;

              if (storage.outputDir) {
                ocrPath = path.join(storage.outputDir, 'provider-claim-ocr.json');
                await fs.promises.writeFile(
                  ocrPath,
                  `${JSON.stringify(providerClaimResult, null, 2)}\n`
                );
                payloadPath = path.join(storage.outputDir, 'provider-claim-request-payload.json');
                await fs.promises.writeFile(
                  payloadPath,
                  `${JSON.stringify(providerClaimPayload, null, 2)}\n`
                );
                excelPath = await saveProviderClaimWorkbook(providerClaimResult, {
                  dir: storage.outputDir,
                  filename: 'llm_prompt_document_result.xlsx',
                });
              }

              const replyResult = await replyProviderClaim({
                subject: parsed.subject || envelope.subject || null,
                to: formatAddressOnlyList(parsed.from?.value),
                payloadPath,
                ocrPath,
                excelPath,
                iasResponse,
                benefitSet,
                senderName,
                inReplyTo: parsed.messageId || envelope.messageId || null,
                references: parsed.messageId || envelope.messageId || null,
              });

              if (storage.outputDir) {
                const replyPath = path.join(storage.outputDir, 'reply.json');
                await fs.promises.writeFile(
                  replyPath,
                  `${JSON.stringify({ type: 'provider_claim', ...replyResult }, null, 2)}\n`
                );
              }
              logEvent({
                event: 'flow.provider_claim.completed',
                message: 'Provider claim processing completed and reply was prepared.',
                status: 'success',
                requestId,
                emailUid: message.uid,
                action: decision.action,
              });
            } catch (error) {
              let replyFn = replySystemError;
              let replyType = 'provider_claim_system_error';
              const missingDocs = error?.detail?.missing_docs || null;

              if (error?.code === 'MEMBER_PLAN_NOT_FOUND') {
                replyFn = replyMemberPlanMissing;
                replyType = 'provider_claim_member_plan_missing';
              } else if (error?.code === 'MISSING_DOCUMENTS') {
                replyFn = replyMissingDocuments;
                replyType = 'provider_claim_missing_documents';
              }
              const replyResult = await replyFn({
                subject: parsed.subject || envelope.subject || null,
                to: formatAddressOnlyList(parsed.from?.value),
                type: 'provider_claim',
                missingDocs,
                senderName,
                inReplyTo: parsed.messageId || envelope.messageId || null,
                references: parsed.messageId || envelope.messageId || null,
              });
              if (storage.outputDir) {
                const replyPath = path.join(storage.outputDir, 'reply.json');
                await fs.promises.writeFile(
                  replyPath,
                  `${JSON.stringify({ type: replyType, ...replyResult }, null, 2)}\n`
                );
              }
              logEvent({
                event: 'flow.provider_claim.failed',
                message: 'Provider claim flow finished with missing items or system error.',
                status: error?.code === 'MISSING_DOCUMENTS' || error?.code === 'MEMBER_PLAN_NOT_FOUND'
                  ? 'warning'
                  : 'error',
                requestId,
                emailUid: message.uid,
                action: decision.action,
                details: {
                  error_code: error?.code || null,
                  missing_docs: missingDocs,
                },
              });
              localProcessed = true;
              return { storage, envelope, processed: localProcessed };
            }
          } else if (decision.action === 'reimbursement_claim') {
            if (!storage.supportedAttachmentPaths.length) {
              const replyResult = await replyMissingAttachments({
                subject: parsed.subject || envelope.subject || null,
                to: formatAddressOnlyList(parsed.from?.value),
                type: 'reimbursement_claim',
                senderName,
                inReplyTo: parsed.messageId || envelope.messageId || null,
                references: parsed.messageId || envelope.messageId || null,
              });
              if (storage.outputDir) {
                const replyPath = path.join(storage.outputDir, 'reply.json');
                await fs.promises.writeFile(
                  replyPath,
                  `${JSON.stringify({ type: 'reimbursement_claim_missing_attachments', ...replyResult }, null, 2)}\n`
                );
              }
              localProcessed = true;
              return { storage, envelope, processed: localProcessed };
            }
            try {
              const result = await processReimbursementClaimFromPaths(
                storage.supportedAttachmentPaths
              );
              let downloadedFilePath = result.downloadedFilePath;
              let ocrPayloadPath = null;
              let claimPayloadPath = null;
              if (storage.outputDir && downloadedFilePath) {
                const targetPath = path.join(storage.outputDir, path.basename(downloadedFilePath));
                if (targetPath !== downloadedFilePath) {
                  try {
                    await fs.promises.copyFile(downloadedFilePath, targetPath);
                    downloadedFilePath = targetPath;
                  } catch (error) {
                    debug(
                      'Failed to copy reimbursement download to email folder (%s): %s',
                      targetPath,
                      error.message
                    );
                  }
                }
              }
              if (storage.outputDir) {
                if (result.llmOcrPayload) {
                  ocrPayloadPath = path.join(storage.outputDir, 'ocr-json-extract.json');
                  await fs.promises.writeFile(
                    ocrPayloadPath,
                    `${JSON.stringify(result.llmOcrPayload, null, 2)}\n`
                  );
                }
                if (result.claimSubmissionPayload) {
                  claimPayloadPath = path.join(
                    storage.outputDir,
                    'reimbursement-claim-request-payload.json'
                  );
                  await fs.promises.writeFile(
                    claimPayloadPath,
                    `${JSON.stringify(result.claimSubmissionPayload, null, 2)}\n`
                  );
                }
              }

              const replyResult = await replyReimbursementClaim({
                subject: parsed.subject || envelope.subject || null,
                to: formatAddressOnlyList(parsed.from?.value),
                claimNo: result.claimNo,
                claimStatusResponse: result.claimStatusResponse,
                submissionResponse: result.submissionResponse,
                downloadedFilePath,
                ocrPayloadPath,
                claimPayloadPath,
                senderName,
                inReplyTo: parsed.messageId || envelope.messageId || null,
                references: parsed.messageId || envelope.messageId || null,
              });

              if (storage.outputDir) {
                const replyPath = path.join(storage.outputDir, 'reply.json');
                await fs.promises.writeFile(
                  replyPath,
                  `${JSON.stringify({ type: 'reimbursement_claim', ...replyResult }, null, 2)}\n`
                );
              }
            } catch (error) {
              const replyFn =
                error?.code === 'MEMBER_PLAN_NOT_FOUND' ? replyMemberPlanMissing : replySystemError;
              const replyType =
                error?.code === 'MEMBER_PLAN_NOT_FOUND'
                  ? 'reimbursement_claim_member_plan_missing'
                  : 'reimbursement_claim_system_error';
              const replyResult = await replyFn({
                subject: parsed.subject || envelope.subject || null,
                to: formatAddressOnlyList(parsed.from?.value),
                type: 'reimbursement_claim',
                senderName,
                inReplyTo: parsed.messageId || envelope.messageId || null,
                references: parsed.messageId || envelope.messageId || null,
              });
              if (storage.outputDir) {
                const replyPath = path.join(storage.outputDir, 'reply.json');
                await fs.promises.writeFile(
                  replyPath,
                  `${JSON.stringify({ type: replyType, ...replyResult }, null, 2)}\n`
                );
              }
              localProcessed = true;
              return { storage, envelope, processed: localProcessed };
            }
          } else {
            const replyResult = await replyNoAction({
              subject: parsed.subject || envelope.subject || null,
              to: formatAddressOnlyList(parsed.from?.value),
              reason: decision.reason || null,
              senderName,
              inReplyTo: parsed.messageId || envelope.messageId || null,
              references: parsed.messageId || envelope.messageId || null,
            });

            if (storage.outputDir) {
              const replyPath = path.join(storage.outputDir, 'reply.json');
              await fs.promises.writeFile(
                replyPath,
                `${JSON.stringify({ type: 'no_action', ...replyResult }, null, 2)}\n`
              );
            }
          }

          localProcessed = true;
        } catch (error) {
          debug('Email processing failed for uid %s: %s', message.uid, error.message);
          logEvent({
            event: 'email.processing.failed',
            message: 'Email processing failed unexpectedly.',
            status: 'error',
            requestId,
            emailUid: message.uid,
            details: {
              error: error.message,
            },
          });
        }

        return { storage, envelope, processed: localProcessed };
      };

      let envelope = message.envelope || {};
      let storage = {
        outputDir: null,
      };

      try {
        const result = config.messageTimeoutMs
          ? await withTimeout(
              processMessage(),
              config.messageTimeoutMs,
              `uid ${message.uid}`
            )
          : await processMessage();
        envelope = result.envelope || envelope;
        storage = result.storage || storage;
        processed = Boolean(result.processed);
      } catch (error) {
        debug('Email processing timeout for uid %s: %s', message.uid, error.message);
      }

      results.push({
        uid: message.uid,
        messageId: envelope.messageId || null,
        subject: envelope.subject || null,
        date: message.internalDate ? new Date(message.internalDate).toISOString() : null,
        from: formatAddressList(envelope.from),
        to: formatAddressList(envelope.to),
        cc: formatAddressList(envelope.cc),
        bcc: formatAddressList(envelope.bcc),
        storedPath: storage.outputDir,
        decision: decisionSummary,
        processed,
      });
      logEvent({
        event: 'email.processing.completed',
        message: processed
          ? 'Email processing completed successfully.'
          : 'Email was reviewed but not fully processed.',
        status: processed ? 'success' : 'warning',
        requestId,
        emailUid: message.uid,
        action: decisionSummary?.action || null,
        durationMs: Date.now() - messageStartedAt,
        details: {
          stored_path: storage.outputDir,
          decision: decisionSummary?.action || null,
        },
      });

      if (processed) {
        await client.messageFlagsAdd(message.uid, ['\\Seen'], { uid: true });
      }
    }

    return results;
  } catch (error) {
    debug('Failed to fetch unseen emails: %s', error.message);
    throw error;
  } finally {
    if (lock) {
      lock.release();
    }
    if (connected) {
      await client.logout().catch(() => undefined);
    }
  }
}

module.exports = {
  fetchUnseenEmails,
};
