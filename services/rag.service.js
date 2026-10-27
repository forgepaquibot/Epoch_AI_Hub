const { sqlAll } = require('../db/database');

const {
  getEmbeddings,
  cosineSimilarity,
  EMBEDDING_MODEL
} = require('./embeddings.service');

// ============================================================
// RESOURCE RETRIEVAL
// ============================================================

async function retrieveRelevantItems({
  agentId,
  aiId,
  userId,
  prompt,
  limit = 5
}) {
  // aiId is temporarily supported for compatibility with older callers.
  const selectedAgentId = agentId ?? aiId;

  if (!selectedAgentId || !userId) {
    return [];
  }

  if (typeof prompt !== 'string' || !prompt.trim()) {
    return [];
  }

  // Restrict the requested result count to a sensible range.
  const resultLimit = Math.max(
    1,
    Math.min(Number.parseInt(limit, 10) || 5, 20)
  );

  // Find resources explicitly linked to this agent for this user.
  // Resource ownership/public access is checked separately.
  const candidates = await sqlAll(
    `SELECT DISTINCT
        ri.item_id,
        ri.content_text,
        re.embedding_json,
        re.dimensions,
        dr.title AS resource_title,
        re.embedding_model

     FROM agent_resource_links arl

     JOIN data_resources dr
       ON dr.resource_id = arl.resource_id

     JOIN resource_items ri
       ON ri.resource_id = dr.resource_id

     JOIN resource_embeddings re
       ON re.item_id = ri.item_id

     WHERE arl.agent_id = ?
       AND arl.user_id = ?
       AND arl.is_enabled = 1

       AND dr.processing_status = 'ready'
       AND ri.content_text IS NOT NULL
       AND LENGTH(TRIM(ri.content_text)) > 0

       AND re.embedding_model = ?

       AND (dr.user_id = ? OR dr.is_public = 1)

     ORDER BY ri.item_id`,
    [
      selectedAgentId,
      userId,
      EMBEDDING_MODEL,
      userId
    ]
  );

  if (candidates.length === 0) {
    return [];
  }

  // Embed the user's question using the configured embedding provider.
  const [questionVector] = await getEmbeddings([
    prompt.trim()
  ]);

  if (
    !Array.isArray(questionVector) ||
    questionVector.length === 0
  ) {
    throw new Error(
      'The embedding provider returned an invalid question embedding.'
    );
  }

  // Score every candidate against the question.
  const rankedItems = candidates
    .map(row => {
      let vector;

      try {
        vector = JSON.parse(row.embedding_json);
      } catch {
        return null;
      }

      if (
        !Array.isArray(vector) ||
        vector.length === 0 ||
        vector.length !== questionVector.length
      ) {
        return null;
      }

      if (
        row.dimensions !== vector.length ||
        vector.some(value => !Number.isFinite(value))
      ) {
        return null;
      }

      const score = cosineSimilarity(
        questionVector,
        vector
      );

      if (!Number.isFinite(score)) {
        return null;
      }

      return {
        item_id: row.item_id,
        content_text: row.content_text,
        resource_title: row.resource_title,
        embedding_model: row.embedding_model,
        score
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return rankedItems.slice(0, resultLimit);
}


// ============================================================
// BUILD THE CONTEXT INCLUDED IN THE MODEL PROMPT
// ============================================================

function buildResourceContext(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return '';
  }

  return items
    .map((item, index) => {
      return [
        `[Source ${index + 1}: ${item.resource_title}]`,
        item.content_text
      ].join('\n');
    })
    .join('\n\n');
}


// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  retrieveRelevantItems,
  buildResourceContext
};