'use strict';

const {
  EMBEDDING_MODEL: OLLAMA_EMBEDDING_MODEL
} = require('./ollama.service');

const ollamaProvider = require('./embedding-providers/ollama.provider');

const openAICompatibleProvider = require(
  './embedding-providers/openai-compatible.provider'
);

const EMBEDDING_PROVIDER = String(
  process.env.EMBEDDING_PROVIDER || 'ollama'
)
  .trim()
  .toLowerCase();

const ACTIVE_EMBEDDING_MODEL =
  EMBEDDING_PROVIDER === 'ollama'
    ? OLLAMA_EMBEDDING_MODEL
    : String(process.env.EMBEDDING_MODEL || '').trim();

// Preserve the old embedding identity for the default Ollama setup.
// Other providers get distinct identities so their vectors aren't
// mistakenly compared against vectors from a different model.
const EMBEDDING_MODEL =
  EMBEDDING_PROVIDER === 'ollama'
    ? OLLAMA_EMBEDDING_MODEL
    : `${EMBEDDING_PROVIDER}:${ACTIVE_EMBEDDING_MODEL || 'unconfigured'}`;

const providers = {
  ollama: ollamaProvider,
  'openai-compatible': openAICompatibleProvider
};

async function getEmbeddings(texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return [];
  }

  if (
    texts.some(
      text => typeof text !== 'string' || !text.trim()
    )
  ) {
    throw new Error(
      'Embedding inputs must be non-empty strings.'
    );
  }

  const provider = providers[EMBEDDING_PROVIDER];

  if (!provider) {
    throw new Error(
      `Unsupported embedding provider: "${EMBEDDING_PROVIDER}".`
    );
  }

  if (!ACTIVE_EMBEDDING_MODEL) {
    throw new Error(
      'Set EMBEDDING_MODEL for the selected embedding provider.'
    );
  }

  const vectors = await provider.embedTexts(
    texts,
    ACTIVE_EMBEDDING_MODEL
  );

  if (
    !Array.isArray(vectors) ||
    vectors.length !== texts.length
  ) {
    throw new Error(
      'The embedding provider returned an unexpected number of vectors.'
    );
  }

  let expectedDimensions = null;

  for (const vector of vectors) {
    if (
      !Array.isArray(vector) ||
      vector.length === 0 ||
      vector.some(value => !Number.isFinite(value))
    ) {
      throw new Error(
        'The embedding provider returned an invalid vector.'
      );
    }

    if (expectedDimensions === null) {
      expectedDimensions = vector.length;
    } else if (vector.length !== expectedDimensions) {
      throw new Error(
        'The embedding provider returned inconsistent vector dimensions.'
      );
    }
  }

  return vectors;
}

function cosineSimilarity(a, b) {
  if (
    !Array.isArray(a) ||
    !Array.isArray(b) ||
    !a.length ||
    a.length !== b.length
  ) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    if (
      !Number.isFinite(a[i]) ||
      !Number.isFinite(b[i])
    ) {
      return 0;
    }

    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (!normA || !normB) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

module.exports = {
  getEmbeddings,
  cosineSimilarity,
  EMBEDDING_PROVIDER,
  EMBEDDING_MODEL,
  ACTIVE_EMBEDDING_MODEL
};