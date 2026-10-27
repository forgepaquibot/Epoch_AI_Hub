'use strict';

function getEmbeddingEndpoint() {
  const baseUrl = String(
    process.env.EMBEDDING_BASE_URL ||
    'https://api.openai.com/v1'
  )
    .trim()
    .replace(/\/+$/, '');

  let parsed;

  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(
      'EMBEDDING_BASE_URL is not a valid URL.'
    );
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(
      'EMBEDDING_BASE_URL must use HTTP or HTTPS.'
    );
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      'EMBEDDING_BASE_URL must not contain credentials, query parameters, or fragments.'
    );
  }

  const normalized = parsed.toString().replace(/\/+$/, '');

  return normalized.endsWith('/embeddings')
    ? normalized
    : `${normalized}/embeddings`;
}

async function embedTexts(texts, model) {
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error(
      'Set EMBEDDING_MODEL when using the OpenAI-compatible embedding provider.'
    );
  }

  const endpoint = getEmbeddingEndpoint();

  // Keep API keys on the server, in environment variables.
  // Compatible local servers may not require a key.
  const apiKey =
    process.env.EMBEDDING_API_KEY ||
    (
      new URL(endpoint).hostname === 'api.openai.com'
        ? process.env.OPENAI_API_KEY
        : ''
    ) ||
    '';

  const headers = {
    'Content-Type': 'application/json'
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(
    endpoint,
    {
      method: 'POST',
      redirect: 'error',
      headers,
      body: JSON.stringify({
        model: model.trim(),
        input: texts,
        encoding_format: 'float'
      })
    }
  );

  if (!response.ok) {
    const details = await response.text();

    throw new Error(
      `OpenAI-compatible embeddings failed: HTTP ${response.status}. ` +
      details.slice(0, 400)
    );
  }

  const data = await response.json();

  if (
    !Array.isArray(data.data) ||
    data.data.length !== texts.length
  ) {
    throw new Error(
      'The embedding provider returned an unexpected response.'
    );
  }

  // The API response includes an index for each embedding.
  // Restore the original input order before returning the vectors.
  const ordered = new Array(texts.length);

  for (let position = 0; position < data.data.length; position++) {
    const entry = data.data[position];

    const index = Number.isInteger(entry.index)
      ? entry.index
      : position;

    if (
      index < 0 ||
      index >= texts.length ||
      !Array.isArray(entry.embedding) ||
      ordered[index]
    ) {
      throw new Error(
        'The embedding provider returned invalid embedding entries.'
      );
    }

    ordered[index] = entry.embedding;
  }

  for (let i = 0; i < ordered.length; i++) {
    if (!Array.isArray(ordered[i])) {
      throw new Error(
        'The embedding provider returned incomplete embeddings.'
      );
    }
  }

  return ordered;
}

module.exports = {
  embedTexts
};