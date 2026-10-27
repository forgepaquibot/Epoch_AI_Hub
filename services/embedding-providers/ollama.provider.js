'use strict';

const {
  ensureEmbeddingModel,
  EMBEDDING_MODEL,
  OLLAMA_BASE_URL
} = require('../ollama.service');

async function embedTexts(texts, model = EMBEDDING_MODEL) {
  if (model !== EMBEDDING_MODEL) {
    throw new Error(
      `This Ollama adapter is configured for "${EMBEDDING_MODEL}".`
    );
  }

  await ensureEmbeddingModel();

  const baseUrl = OLLAMA_BASE_URL.replace(/\/+$/, '');

  const response = await fetch(
    `${baseUrl}/api/embed`,
    {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        input: texts
      })
    }
  );

  if (!response.ok) {
    const details = await response.text();

    throw new Error(
      `Ollama embeddings failed: HTTP ${response.status}. ` +
      details.slice(0, 400)
    );
  }

  const data = await response.json();

  if (
    !Array.isArray(data.embeddings) ||
    data.embeddings.length !== texts.length
  ) {
    throw new Error(
      'Ollama returned an unexpected embedding response.'
    );
  }

  return data.embeddings;
}

module.exports = {
  embedTexts
};