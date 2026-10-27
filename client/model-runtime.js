const WEBLLM_MODULE_URL =
  'https://esm.run/@mlc-ai/web-llm@0.2.85';

let webllmPromise = null;
let engine = null;
let engineModelId = '';
let worker = null;
let activeProgressCallback = null;
let loadPromise = null;

// ============================================================
// CANCELLATION HELPERS
// ============================================================

function createAbortError() {
  const error = new Error('WebLLM generation was cancelled.');
  error.name = 'AbortError';
  error.code = 'CHAT_CANCELLED';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

// ============================================================
// LOAD WEBLLM
// ============================================================

async function loadWebLLM() {
  if (!webllmPromise) {
    webllmPromise = import(WEBLLM_MODULE_URL).catch(error => {
      webllmPromise = null;

      throw new Error(
        `Could not load WebLLM from its CDN: ${error.message}`
      );
    });
  }

  return webllmPromise;
}

// ============================================================
// WEBGPU SUPPORT
// ============================================================

export function supportsWebGPU() {
  return (
    typeof navigator !== 'undefined' &&
    'gpu' in navigator &&
    Boolean(navigator.gpu)
  );
}

// ============================================================
// MODEL ID RESOLUTION
// ============================================================

/**
 * Read the WebLLM model ID from the selected agent's option.
 *
 * Expected ai_models.metadata_json example:
 * {
 *   "runtimes": {
 *     "webllm": {
 *       "modelId": "Llama-3.2-1B-Instruct-q4f16_1-MLC"
 *     }
 *   }
 * }
 *
 * A model key that is itself a WebLLM-style model ID is also
 * accepted, but it is checked against the installed WebLLM
 * catalog before use.
 */
export function getWebLLMModelId(option) {
  if (!option) return '';

  let metadata = {};

  try {
    metadata = JSON.parse(
      option.dataset.modelMetadata || '{}'
    );
  } catch {
    return '';
  }

  const configuredId =
    metadata?.runtimes?.webllm?.modelId ||
    metadata?.webllm?.modelId;

  if (
    typeof configuredId === 'string' &&
    configuredId.trim()
  ) {
    return configuredId.trim();
  }

  const modelKey = String(
    option.dataset.modelKey || ''
  ).trim();

  if (/^[A-Za-z0-9._-]+-MLC$/.test(modelKey)) {
    return modelKey;
  }

  return '';
}

// ============================================================
// CHECK MODEL CATALOG
// ============================================================

export async function isPrebuiltWebLLMModel(modelId) {
  if (!modelId) return false;

  const webllm = await loadWebLLM();
  const modelList =
    webllm.prebuiltAppConfig?.model_list || [];

  return modelList.some(
    model => model.model_id === modelId
  );
}

// ============================================================
// MODEL LOADING PROGRESS
// ============================================================

function reportProgress(progress) {
  if (typeof activeProgressCallback !== 'function') {
    return;
  }

  if (typeof progress === 'string') {
    activeProgressCallback(progress);
    return;
  }

  const text = [
    progress?.text,
    Number.isFinite(progress?.progress)
      ? `${Math.round(progress.progress * 100)}%`
      : ''
  ]
    .filter(Boolean)
    .join(' ');

  activeProgressCallback(
    text || 'Loading the model on your device…'
  );
}

// ============================================================
// GET OR INITIALIZE THE WEBLLM ENGINE
// ============================================================

async function getEngine(modelId, onProgress, signal) {
  throwIfAborted(signal);

  const webllm = await loadWebLLM();

  throwIfAborted(signal);

  const isAvailable = (
    webllm.prebuiltAppConfig?.model_list || []
  ).some(model => model.model_id === modelId);

  if (!isAvailable) {
    throw new Error(
      `WebLLM does not include the model "${modelId}". ` +
      'Choose a supported browser model or select server execution.'
    );
  }

  // Ignore progress updates after cancellation.
  activeProgressCallback =
    typeof onProgress === 'function'
      ? progress => {
          if (!signal?.aborted) {
            onProgress(progress);
          }
        }
      : null;

  if (engine && engineModelId === modelId) {
    throwIfAborted(signal);
    return engine;
  }

  // Prevent duplicate initialization.
  if (loadPromise) {
    await loadPromise;

    throwIfAborted(signal);

    if (engine && engineModelId === modelId) {
      return engine;
    }
  }

  loadPromise = (async () => {
    if (!engine) {
      worker = new Worker(
        new URL('./webllm.worker.js', import.meta.url),
        { type: 'module' }
      );

      try {
        engine = await webllm.CreateWebWorkerMLCEngine(
          worker,
          modelId,
          {
            initProgressCallback: reportProgress
          }
        );

        engineModelId = modelId;
      } catch (error) {
        worker?.terminate();
        worker = null;
        engine = null;
        engineModelId = '';

        throw error;
      }
    } else {
      await engine.reload(modelId);
      engineModelId = modelId;
    }
  })();

  try {
    await loadPromise;
  } finally {
    loadPromise = null;
  }

  throwIfAborted(signal);

  return engine;
}

// ============================================================
// GENERATE A RESPONSE WITH WEBLLM
// ============================================================

export async function generateWithWebLLM({
  modelId,
  messages,
  onProgress,
  onToken,
  signal
}) {
  throwIfAborted(signal);

  if (!supportsWebGPU()) {
    throw new Error(
      'This browser does not expose WebGPU. ' +
      'Use a compatible browser/device or select server execution.'
    );
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('No conversation messages were provided.');
  }

  if (
    typeof modelId !== 'string' ||
    !modelId.trim()
  ) {
    throw new Error('A valid WebLLM model ID is required.');
  }

  const progressCallback =
    typeof onProgress === 'function'
      ? progress => {
          if (!signal?.aborted) {
            onProgress(progress);
          }
        }
      : null;

  let activeEngine = null;
  let iterator = null;
  let generationStarted = false;
  let generationFinished = false;

  let fullAnswer = '';

  // Interrupt active inference when the caller aborts.
  // If generation has not started, the checks below prevent it
  // from starting after cancellation.
  const interruptGeneration = () => {
    if (!generationStarted || generationFinished) {
      return;
    }

    try {
      activeEngine?.interruptGenerate();
    } catch (error) {
      console.error(
        'Could not interrupt WebLLM generation:',
        error
      );
    }
  };

  try {
    const modelIsAvailable =
      await isPrebuiltWebLLMModel(modelId);

    throwIfAborted(signal);

    if (!modelIsAvailable) {
      throw new Error(
        `The WebLLM model "${modelId}" is not in the supported model catalog.`
      );
    }

    activeEngine = await getEngine(
      modelId,
      progressCallback,
      signal
    );

    throwIfAborted(signal);

    // Register cancellation before creating the generation stream.
    signal?.addEventListener(
      'abort',
      interruptGeneration,
      { once: true }
    );

    try {
      const chunks = await activeEngine.chat.completions.create({
        messages,
        temperature: 0.7,
        max_tokens: 1024,
        stream: true
      });

      // Obtain the iterator before the next cancellation check so
      // we can close it if the user cancelled during stream setup.
      iterator = chunks[Symbol.asyncIterator]();

      throwIfAborted(signal);

      while (true) {
        throwIfAborted(signal);

        generationStarted = true;

        const result = await iterator.next();

        throwIfAborted(signal);

        if (result.done) {
          generationFinished = true;
          break;
        }

        const chunk = result.value;

        const token = String(
          chunk.choices?.[0]?.delta?.content || ''
        );

        if (!token) continue;

        fullAnswer += token;

        if (typeof onToken === 'function') {
          await onToken(token);
        }

        // Do not allow tokens delivered late by the worker to
        // continue updating the UI after cancellation.
        throwIfAborted(signal);
      }
    } finally {
      signal?.removeEventListener(
        'abort',
        interruptGeneration
      );

      // Explicitly close an unfinished stream. WebLLM documents
      // iterator.return() / breaking the stream as the mechanism
      // for releasing a started stream's resources.
      if (iterator && !generationFinished) {
        try {
          await iterator.return?.();
        } catch (error) {
          if (!signal?.aborted) {
            console.warn(
              'Could not close the WebLLM stream cleanly:',
              error
            );
          }
        }
      }
    }

    throwIfAborted(signal);

    if (!fullAnswer.trim()) {
      fullAnswer = await activeEngine.getMessage();

      throwIfAborted(signal);
    }

    if (
      typeof fullAnswer !== 'string' ||
      !fullAnswer.trim()
    ) {
      throw new Error(
        'WebLLM finished without producing response text.'
      );
    }

    return fullAnswer;
  } catch (error) {
    // Normalize cancellation so chat.js treats it as an intentional
    // stop rather than an ordinary model-generation failure.
    if (signal?.aborted) {
      throw createAbortError();
    }

    throw error;
  } finally {
    activeProgressCallback = null;
  }
}