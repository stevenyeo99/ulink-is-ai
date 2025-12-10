const fs = require('fs');
const path = require('path');
const {
  requestVisionSchemaCompletion,
  requestAssistantJsonCompletion,
  extractStructuredJson,
} = require('../services/llmService');
const { convertFilesToJpeg300ppi } = require('../services/imageService');
const { correctInsurerName } = require('../services/insurerService');
const createDebug = require('debug');

const debug = createDebug('app:controller:claim');

async function preApprovalJson(req, res) {
  const { paths } = req.body || {};

  if (!Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: 'paths must be a non-empty array of file paths' });
  }

  debug('Received pre-approval OCR request for %d paths', paths.length);

  try {
    const systemPromptPath = path.join(__dirname, '..', 'prompts', 'claims', 'claim-preapproval-system.md');
    const validatePromptPath = path.join(
      __dirname,
      '..',
      'prompts',
      'claims',
      'claim-preapproval-validate-system.md'
    );
    const jsonSchemaPath = path.join(
      __dirname,
      '..',
      'prompts',
      'claims',
      'claim-preapproval-json-schema.json'
    );

    const systemPrompt = await fs.promises.readFile(systemPromptPath, 'utf8');
    const validatePrompt = await fs.promises.readFile(validatePromptPath, 'utf8');
    const jsonSchemaRaw = await fs.promises.readFile(jsonSchemaPath, 'utf8');
    const jsonSchema = JSON.parse(jsonSchemaRaw);

    const conversions = await convertFilesToJpeg300ppi(paths);

    const successfulConversions = conversions.filter(
      (item) => item.status === 'success' && item.outputPath
    );

    if (successfulConversions.length === 0) {
      return res.status(500).json({
        error: 'No successful image conversions available for LLM processing',
        conversions,
      });
    }

    const base64Images = [];

    for (const conversion of successfulConversions) {
      const imageBuffer = await fs.promises.readFile(conversion.outputPath);
      base64Images.push(imageBuffer.toString('base64'));
    }

    const llmResponse = await requestVisionSchemaCompletion({
      base64Images,
      systemPrompt,
      jsonSchema,
    });

    // OCR LLM JSON Response
    const structured = extractStructuredJson(llmResponse);

    // Call OpenAI LLM to make descision on validity
    const validateResponse = await requestAssistantJsonCompletion({
      systemPrompt: validatePrompt,
      inputJson: structured,
    });

    // Final Json Response from LLM (OpenAI)
    const validated = extractStructuredJson(validateResponse);

    return res.status(200).json(validated);
  } catch (error) {
    debug('Conversion error: %s', error.message);
    return res.status(500).json({
      error: 'Failed to process OCR with LLM',
      detail: error.message,
    });
  }
}

module.exports = {
  preApprovalJson,
};

async function applyInsurerCorrection(structured) {
  if (!structured || typeof structured !== 'object') {
    return;
  }

  const mainSheet = structured.main_sheet;
  if (!mainSheet || typeof mainSheet !== 'object') {
    return;
  }

  const rawInsurer = mainSheet.insurer;
  delete mainSheet.insurer_raw;
  delete mainSheet.insurer_match_score;
  delete mainSheet.insurer_best_match;

  if (!rawInsurer) {
    return;
  }

  const { correctedName, score, bestMatch } = await correctInsurerName(rawInsurer);

  if (correctedName && correctedName !== rawInsurer) {
    debug(
      'Corrected insurer name from "%s" to "%s" (score: %s, bestMatch: %s)',
      rawInsurer,
      correctedName,
      score,
      bestMatch
    );
    mainSheet.insurer = correctedName;
  }
}
