const fs = require('fs');
const path = require('path');
const {
  requestVisionSchemaCompletion,
  requestAssistantJsonCompletion,
  extractStructuredJson,
} = require('./llmService');
const { convertFilesToJpeg300ppi } = require('./imageService');

async function processPreApproval(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('paths must be a non-empty array of file paths');
  }

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
  const successfulConversions = conversions.filter((item) => item.status === 'success' && item.outputPath);

  if (successfulConversions.length === 0) {
    const error = new Error('No successful image conversions available for LLM processing');
    error.detail = conversions;
    throw error;
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

  const structured = extractStructuredJson(llmResponse);

  const validateResponse = await requestAssistantJsonCompletion({
    systemPrompt: validatePrompt,
    inputJson: structured,
  });

  return extractStructuredJson(validateResponse);
}

module.exports = {
  processPreApproval,
};
