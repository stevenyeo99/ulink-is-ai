const createDebug = require('debug');

const debug = createDebug('app:service:llm');
const DEFAULT_ENDPOINT = '/v1/chat/completions';
const BASE_URL = process.env.LM_URL || process.env.LLM_URL;
const DEFAULT_MODEL = process.env.MODEL;
const DEFAULT_ASSISTANT_MODEL = process.env.MODEL_ASSISTANT;

function buildImageDataUrl(base64Image) {
  if (!base64Image || typeof base64Image !== 'string') {
    throw new Error('base64Image must be a non-empty base64 string');
  }
  if (base64Image.startsWith('data:')) {
    return base64Image;
  }
  return `data:image/jpeg;base64,${base64Image}`;
}

function buildResponseFormat(jsonSchema) {
  if (!jsonSchema) {
    return { type: 'json_object' };
  }

  // Allow callers to pass either the full json_schema payload or just the schema object.
  if (jsonSchema.type === 'json_schema' && jsonSchema.json_schema) {
    return jsonSchema;
  }

  return {
    type: 'json_schema',
    json_schema: {
      name: jsonSchema.name || 'structured_output',
      schema: jsonSchema.schema || jsonSchema,
      strict: true,
    },
  };
}

function buildAssistantResponseFormat(jsonSchema) {
  const responseFormat = buildResponseFormat(jsonSchema);

  // Some providers disallow json_object; fall back to a permissive json_schema.
  if (!responseFormat || responseFormat.type === 'json_object') {
    return {
      type: 'json_schema',
      json_schema: {
        name: 'structured_output',
        schema: { type: 'object' },
        strict: true,
      },
    };
  }

  return responseFormat;
}

async function requestVisionSchemaCompletion({
  base64Image,
  base64Images,
  systemPrompt,
  jsonSchema,
  model = DEFAULT_MODEL,
}) {
  if (!BASE_URL) {
    throw new Error('LM_URL/LLM_URL environment variable is required');
  }
  if (!model) {
    throw new Error('MODEL environment variable is required');
  }
  if (!systemPrompt) {
    throw new Error('systemPrompt is required');
  }

  const images = normalizeImages(base64Image, base64Images);
  if (images.length === 0) {
    throw new Error('At least one base64Image is required');
  }

  const url = new URL(DEFAULT_ENDPOINT, BASE_URL).toString();
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `JSON schema to follow:\n${JSON.stringify(buildResponseFormat(jsonSchema), null, 2)}`,
          },
          ...images.map(({ dataUrl }) => ({
            type: 'image_url',
            image_url: { url: dataUrl },
          })),
        ],
      },
    ],
    response_format: buildResponseFormat(jsonSchema),
    temperature: 0,
    top_p: 0.5,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM request failed (${response.status} ${response.statusText}): ${text}`);
  }

  const data = await response.json();
  debug('LLM responded with %d choice(s)', Array.isArray(data?.choices) ? data.choices.length : 0);
  return data;
}

module.exports = {
  requestVisionSchemaCompletion,
  requestAssistantJsonCompletion,
  extractStructuredJson,
};

async function requestAssistantJsonCompletion({
  systemPrompt,
  inputJson,
  jsonSchema,           // now optional
  model = DEFAULT_ASSISTANT_MODEL,
}) {
  if (!BASE_URL) {
    throw new Error('LM_URL/LLM_URL environment variable is required');
  }
  if (!model) {
    throw new Error('MODEL_ASSISTANT environment variable is required for assistant LLM requests');
  }
  if (!systemPrompt) {
    throw new Error('systemPrompt is required');
  }
  if (inputJson === undefined || inputJson === null) {
    throw new Error('inputJson is required');
  }

  const url = new URL(DEFAULT_ENDPOINT, BASE_URL).toString();

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: typeof inputJson === 'string'
        ? inputJson
        : JSON.stringify(inputJson),
    },
  ];

  const body = {
    model,
    messages,
    temperature: 0,
    top_p: 0.5,
  };

  // ❗ Only use response_format when a schema is provided (e.g. Pass 1)
  if (jsonSchema) {
    body.response_format = buildAssistantResponseFormat(jsonSchema);
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Assistant LLM request failed (${response.status} ${response.statusText}): ${text}`);
  }

  const data = await response.json();
  debug(
    'Assistant LLM responded with %d choice(s)',
    Array.isArray(data?.choices) ? data.choices.length : 0
  );

  console.log('Assistant LLM Response:', JSON.stringify(data, null, 2));

  return data;
}

function normalizeImages(base64Image, base64Images) {
  const images = [];

  if (Array.isArray(base64Images) && base64Images.length > 0) {
    for (const entry of base64Images) {
      if (!entry) continue;
      if (typeof entry === 'string') {
        images.push({ dataUrl: buildImageDataUrl(entry) });
      } else if (typeof entry === 'object' && entry.data) {
        images.push({ dataUrl: buildImageDataUrl(entry.data) });
      }
    }
  } else if (base64Image) {
    images.push({ dataUrl: buildImageDataUrl(base64Image) });
  }

  return images;
}

function extractStructuredJson(llmResponse) {
  const choice = llmResponse?.choices?.[0];
  if (!choice) {
    throw new Error('LLM response contained no choices');
  }

  const parseJsonWithRepair = (value) => {
    try {
      return JSON.parse(value);
    } catch (error) {
      const repaired = repairUnescapedQuotes(value);
      return JSON.parse(repaired);
    }
  };

  const content = choice.message?.content;
  console.log('LLM message', choice.message)
  console.log('LLM Response Content:', content);

  if (typeof content === 'string') {
    console.log('Json String Content Return');
    const jsonResult = parseJsonWithRepair(content);
    console.log('Parsed JSON Result:', jsonResult);
    return jsonResult;
  }

  if (Array.isArray(content)) {
    const text = content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');

    if (!text) {
      throw new Error('LLM response content is empty');
    }

    return parseJsonWithRepair(text);
  }

  throw new Error('Unsupported LLM content format');
}

function repairUnescapedQuotes(text) {
  if (typeof text !== 'string' || !text.includes('"')) {
    return text;
  }
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        result += char;
        escaped = false;
        continue;
      }
      if (char === '\\') {
        result += char;
        escaped = true;
        continue;
      }
      if (char === '"') {
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) {
          j += 1;
        }
        const next = j < text.length ? text[j] : '';
        if (!next || next === ',' || next === '}' || next === ']' || next === ':') {
          inString = false;
          result += char;
        } else {
          result += '\\"';
        }
        continue;
      }
      result += char;
      continue;
    }

    if (char === '"') {
      inString = true;
    }
    result += char;
  }

  return result;
}
