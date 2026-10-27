const {
  OLLAMA_BASE_URL,
  EMBEDDING_MODEL
} = require('../config/app-config');

// ============================================================
// URL HANDLING
// ============================================================

/**
 * Normalize and validate an Ollama API base URL.
 *
 * Only use URLs from trusted server configuration or validated
 * server-managed connections. URL validation alone does not
 * prevent server-side request forgery (SSRF).
 */
function normalizeBaseUrl(baseUrl = OLLAMA_BASE_URL) {
  let url;

  try {
    url = new URL(String(baseUrl).trim());
  } catch {
    throw new Error('Invalid Ollama base URL.');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Ollama URLs must use HTTP or HTTPS.');
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'Ollama base URLs must not contain credentials, queries or fragments.'
    );
  }

  return url.toString().replace(/\/+$/, '');
}


// ============================================================
// CANCELLATION HELPERS
// ============================================================

/**
 * Throw an AbortError if the caller has cancelled generation.
 *
 * This allows cancellation to propagate through the chat service
 * without treating it as an ordinary Ollama failure.
 */
function throwIfAborted(signal) {
  if (!signal?.aborted) {
    return;
  }

  if (signal.reason instanceof Error) {
    throw signal.reason;
  }

  const error = new Error('Chat generation was cancelled.');
  error.name = 'AbortError';

  throw error;
}


// ============================================================
// LIST MODELS INSTALLED ON AN OLLAMA SERVER
// ============================================================

async function getOllamaModels(baseUrl = OLLAMA_BASE_URL) {
  const endpoint = normalizeBaseUrl(baseUrl);

  const response = await fetch(
    `${endpoint}/api/tags`,
    {
      redirect: 'error'
    }
  );

  if (!response.ok) {
    throw new Error(
      `Ollama returned HTTP ${response.status} while listing models.`
    );
  }

  const data = await response.json();

  return Array.isArray(data.models) ? data.models : [];
}


// ============================================================
// EMBEDDING MODEL SETUP
//
// Embeddings currently use the application's configured Ollama
// server. Chat deployments can use a different base URL.
// ============================================================

let embeddingModelReady = false;
let embeddingModelSetupPromise = null;

async function ensureEmbeddingModel() {
  if (embeddingModelReady) {
    return;
  }

  if (!embeddingModelSetupPromise) {
    embeddingModelSetupPromise = (async () => {
      let models = await getOllamaModels();

      const isInstalled = () =>
        models.some(model =>
          [model.name, model.model]
            .filter(Boolean)
            .includes(EMBEDDING_MODEL)
        );

      if (!isInstalled()) {
        console.log(
          `Installing app-managed embedding model: ${EMBEDDING_MODEL}`
        );

        const response = await fetch(
          `${normalizeBaseUrl(OLLAMA_BASE_URL)}/api/pull`,
          {
            method: 'POST',
            redirect: 'error',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: EMBEDDING_MODEL,
              stream: false
            })
          }
        );

        if (!response.ok) {
          const details = await response.text();

          throw new Error(
            `Could not install embedding model: HTTP ${response.status}. ` +
            details.slice(0, 400)
          );
        }

        const result = await response.json();

        if (result.status && result.status !== 'success') {
          throw new Error(
            `Embedding model installation did not complete: ${result.status}`
          );
        }

        models = await getOllamaModels();

        if (!isInstalled()) {
          throw new Error(
            'Embedding model installation could not be verified.'
          );
        }

        console.log(
          `Embedding model ready: ${EMBEDDING_MODEL}`
        );
      }

      embeddingModelReady = true;
    })();
  }

  try {
    await embeddingModelSetupPromise;
  } finally {
    embeddingModelSetupPromise = null;
  }
}


// ============================================================
// STREAM CHAT COMPLETIONS
// ============================================================

async function createChatCompletion({
  model,
  messages,
  options,
  onToken,
  signal,
  baseUrl = OLLAMA_BASE_URL
}) {
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error('A model identifier is required.');
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('At least one chat message is required.');
  }

  // Do not start a request that has already been cancelled.
  throwIfAborted(signal);

  const endpoint = normalizeBaseUrl(baseUrl);

  const response = await fetch(
    `${endpoint}/api/chat`,
    {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model.trim(),
        stream: true,
        messages,
        ...(options ? { options } : {})
      }),

      // NEW: abort the Ollama HTTP request when generation is stopped.
      signal
    }
  );

  // Handle cancellation before processing the response.
  throwIfAborted(signal);

  if (!response.ok) {
    const details = await response.text();

    throw new Error(
      `Ollama chat request failed: HTTP ${response.status}. ` +
      details.slice(0, 400)
    );
  }

  if (!response.body) {
    throw new Error('Ollama returned no response stream.');
  }

  const decoder = new TextDecoder();

  let buffer = '';
  let fullContent = '';
  let generationFinished = false;
  let finalStats = null;

  async function processLine(line) {
    // Stop processing immediately if cancellation was requested.
    throwIfAborted(signal);

    const trimmedLine = line.trim();

    if (!trimmedLine) {
      return;
    }

    let data;

    try {
      data = JSON.parse(trimmedLine);
    } catch {
      throw new Error(
        'Could not parse an Ollama streaming response.'
      );
    }

    if (data.error) {
      throw new Error(
        `Ollama streaming error: ${String(data.error).slice(0, 400)}`
      );
    }

    // Forward generated response text as it arrives.
    const token = String(data.message?.content || '');

    if (token) {
      fullContent += token;

      if (typeof onToken === 'function') {
        await onToken(token);
      }

      // Check again after forwarding the token.
      throwIfAborted(signal);
    }

    if (data.done === true) {
      generationFinished = true;

      finalStats = {
        done_reason: data.done_reason ?? 'not provided',
        prompt_eval_count: data.prompt_eval_count ?? null,
        eval_count: data.eval_count ?? null
      };
    }
  }

  // Network chunks may contain partial JSON records or multiple
  // records. Process complete newline-delimited records only.
  //
  // Passing the AbortSignal to fetch also makes the streamed response
  // cancellable while this loop is waiting for more data.
  for await (const chunk of response.body) {
    throwIfAborted(signal);

    buffer += decoder.decode(chunk, { stream: true });

    let newlineIndex;

    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      throwIfAborted(signal);

      const line = buffer.slice(0, newlineIndex);

      buffer = buffer.slice(newlineIndex + 1);

      await processLine(line);
    }
  }

  // Do not process leftover data as a completed response after cancellation.
  throwIfAborted(signal);

  // Flush any buffered decoder characters.
  buffer += decoder.decode();

  // Handle a final record without a trailing newline.
  if (buffer.trim()) {
    await processLine(buffer);
  }

  // A cancelled or prematurely closed stream must not be treated as
  // a successful completion.
  throwIfAborted(signal);

  if (!generationFinished) {
    throw new Error(
      'Ollama stream ended before generation completed.'
    );
  }

  console.log('[Ollama completion stats]', finalStats);

  return fullContent;
}


// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  getOllamaModels,
  ensureEmbeddingModel,
  createChatCompletion,
  OLLAMA_BASE_URL,
  EMBEDDING_MODEL
};