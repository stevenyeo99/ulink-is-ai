const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const createDebug = require('debug');
const {
  requestAssistantJsonCompletion,
  extractStructuredJson,
} = require('./llmService');
const { submitProviderClaimFromPaths } = require('./claimService');
const { saveProviderClaimWorkbook } = require('./excelService');
const { replyNoAction, replyProviderClaim } = require('./emailReplyService');

const debug = createDebug('app:service:email');

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
      action: { type: 'string', enum: ['provider_claim', 'no_action'] },
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
  });

  let connected = false;
  let lock;

  try {
    await client.connect();
    connected = true;

    lock = await client.getMailboxLock(mailbox);
    const unseenUids = await client.search({ seen: false });

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

      const parsed = await simpleParser(message.source);
      const storage = await saveParsedMessage(config.importBaseDir, message, parsed);
      const envelope = message.envelope || {};

      try {
        const decisionInput = {
          subject: parsed.subject || envelope.subject || null,
          from: formatAddressOnlyList(parsed.from?.value),
          cc: formatAddressOnlyList(parsed.cc?.value),
          date: message.internalDate ? new Date(message.internalDate).toISOString() : null,
          body: parsed.text || parsed.html || '',
          attachments: storage.attachments,
        };

        const { decision, rawResponse } = await decideEmailAction(decisionInput);
        decisionSummary = decision;

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

        if (decision.action === 'provider_claim') {
          if (!storage.supportedAttachmentPaths.length) {
            throw new Error('No supported PDF/image attachments for provider claim');
          }
          const { providerClaimResult, providerClaimPayload, iasResponse } =
            await submitProviderClaimFromPaths(storage.supportedAttachmentPaths);
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
        } else {
          const replyResult = await replyNoAction({
            subject: parsed.subject || envelope.subject || null,
            to: formatAddressOnlyList(parsed.from?.value),
            reason: decision.reason || null,
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

        processed = true;
      } catch (error) {
        debug('Email processing failed for uid %s: %s', message.uid, error.message);
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
