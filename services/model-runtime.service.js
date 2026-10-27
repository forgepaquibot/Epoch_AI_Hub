const {
  createChatCompletion
} = require('./ollama.service');

function createError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

/**
 * Generate a response using a selected server/hosted deployment.
 *
 * Each provider adapter implements compatible streaming semantics:
 * model, messages, options, onToken and signal.
 *
 * The AbortSignal allows the caller to cancel active generation.
 */
async function streamModelResponse({
  deployment,
  messages,
  options = {},
  onToken,
  signal
}) {
  if (!deployment) {
    throw createError(
      'No model deployment was provided.',
      400,
      'DEPLOYMENT_REQUIRED'
    );
  }

  if (
    !['server', 'hosted'].includes(
      deployment.runtime_location
    )
  ) {
    throw createError(
      'This runtime cannot execute the selected deployment.',
      400,
      'INVALID_DEPLOYMENT_RUNTIME'
    );
  }

  if (!deployment.provider_model_ref) {
    throw createError(
      'The deployment has no provider-specific model identifier.',
      400,
      'MODEL_REFERENCE_MISSING'
    );
  }

  const provider = String(
    deployment.provider || ''
  ).trim().toLowerCase();

  switch (provider) {
    case 'ollama':
      return createChatCompletion({
        model: deployment.provider_model_ref,
        messages,
        options,
        onToken,

        // Forward cancellation to the Ollama HTTP request.
        signal,

        // The Ollama adapter uses the configured default URL
        // when no deployment-specific base URL is provided.
        baseUrl: deployment.base_url || undefined
      });

    default:
      throw createError(
        `The "${provider || 'unknown'}" provider is not implemented yet.`,
        501,
        'PROVIDER_NOT_IMPLEMENTED'
      );
  }
}

module.exports = {
  streamModelResponse
};