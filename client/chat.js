'use strict';

import {
  supportsWebGPU,
  getWebLLMModelId,
  isPrebuiltWebLLMModel,
  generateWithWebLLM
} from './model-runtime.js';

document.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('#chat-form');
  const agentSelect = document.querySelector('#agent_id');
  const runtimeSelect = document.querySelector('#runtime_location');
  const sessionSelect = document.querySelector('#session_id');
  const prompt = document.querySelector('#prompt');
  const status = document.querySelector('#chat-status');
  const runtimeStatus = document.querySelector('#runtime-status');
  const responseBox = document.querySelector('#chat-response');
  const emptyState = document.querySelector('#chat-empty');
  const answerNode = document.querySelector('#answer-text');
  const sourcesNode = document.querySelector('#sources-text');
  const welcomePanel = document.querySelector('#welcome-panel');
  const welcomeText = document.querySelector('#welcome-text');
  const sendButton = document.querySelector('#send-message');

  const originalSendButtonText =
    sendButton?.textContent.trim() || 'Send message';

  let runtimeCheckId = 0;
  let generationRunId = 0;
  let activeGeneration = null;

  // ============================================================
  // GENERATION STATE AND CANCELLATION
  // ============================================================

  function isCancelled(run) {
    return Boolean(
      run?.cancelled || run?.controller.signal.aborted
    );
  }

  function throwIfCancelled(run) {
    if (!isCancelled(run)) return;

    const error = new Error('Chat generation was cancelled.');
    error.name = 'AbortError';
    error.code = 'CHAT_CANCELLED';

    throw error;
  }

  function setStatus(message) {
    if (status) {
      status.textContent = message;
    }
  }

  function setSendButtonState(state) {
    if (!sendButton) return;

    if (state === 'generating') {
      sendButton.disabled = false;
      sendButton.textContent = 'Stop generation';
      sendButton.setAttribute('aria-busy', 'true');
      sendButton.setAttribute('aria-label', 'Stop generation');
      sendButton.dataset.action = 'stop';
      return;
    }

    if (state === 'stopping') {
      sendButton.disabled = true;
      sendButton.textContent = 'Stopping…';
      sendButton.setAttribute('aria-busy', 'true');
      sendButton.setAttribute('aria-label', 'Stopping generation');
      sendButton.dataset.action = 'stopping';
      return;
    }

    if (state === 'saving') {
      sendButton.disabled = true;
      sendButton.textContent = 'Saving…';
      sendButton.setAttribute('aria-busy', 'true');
      sendButton.setAttribute('aria-label', 'Saving conversation');
      sendButton.dataset.action = 'saving';
      return;
    }

    sendButton.disabled = false;
    sendButton.textContent = originalSendButtonText;
    sendButton.setAttribute('aria-busy', 'false');
    sendButton.setAttribute('aria-label', originalSendButtonText);
    sendButton.dataset.action = 'send';
  }

  function setGenerationSaving(run) {
    if (
      activeGeneration !== run ||
      isCancelled(run)
    ) {
      throwIfCancelled(run);
      return;
    }

    run.saving = true;

    setSendButtonState('saving');
    setStatus('Saving your conversation…');
  }

  function showResponse() {
    if (responseBox) responseBox.hidden = false;
    if (emptyState) emptyState.hidden = true;
  }

  function clearOutput() {
    if (answerNode) {
      answerNode.textContent = '';
      answerNode.style.whiteSpace = 'pre-wrap';
    }

    if (sourcesNode) {
      sourcesNode.textContent = '';
    }

    if (responseBox) responseBox.hidden = true;
    if (emptyState) emptyState.hidden = false;
  }

  function stopGeneration() {
    const run = activeGeneration;

    // Saving is not cancellable through the Stop button.
    if (!run || run.saving || isCancelled(run)) {
      return;
    }

    // Mark the run cancelled before aborting so late tokens and
    // completion events cannot update the interface.
    run.cancelled = true;

    clearOutput();
    setStatus('Stopping generation…');
    setSendButtonState('stopping');

    // Abort the server request or signal WebLLM to interrupt.
    run.controller.abort();

    console.log(
      `[Chat] Cancellation requested for generation ${run.id}.`
    );
  }

  function restoreAfterGeneration(run) {
    // A stale run must never reset the controls of a newer run.
    if (activeGeneration !== run) {
      return;
    }

    activeGeneration = null;

    setSendButtonState('send');

    if (status) {
      status.classList.remove('is-generating');
    }
  }

  // ============================================================
  // AGENT AND SESSION HELPERS
  // ============================================================

  function selectedAgentOption() {
    return agentSelect?.selectedOptions?.[0] || null;
  }

  function selectedRuntime() {
    return runtimeSelect?.value || 'device_local';
  }

  function restoreSessionRuntime(runtimeLocation) {
    const supportedRuntimes = [
      'device_local',
      'server',
      'hosted'
    ];

    if (
      runtimeSelect &&
      supportedRuntimes.includes(runtimeLocation)
    ) {
      runtimeSelect.value = runtimeLocation;
    } else {
      const preferred =
        selectedAgentOption()?.dataset.preferredRuntime;

      if (runtimeSelect) {
        runtimeSelect.value =
          supportedRuntimes.includes(preferred)
            ? preferred
            : 'device_local';
      }
    }

    refreshRuntimeStatus();
  }

  function showWelcome() {
    const option = selectedAgentOption();
    const message = option?.dataset.welcomeMessage || '';

    if (welcomeText) {
      welcomeText.textContent = message;
    }

    if (welcomePanel) {
      welcomePanel.hidden = !message;
    }
  }

  function pickSession(
    sessionId,
    selectedAgentId,
    runtimeLocation
  ) {
    if (sessionSelect) {
      sessionSelect.value = String(sessionId || '');
    }

    if (agentSelect && selectedAgentId) {
      agentSelect.value = String(selectedAgentId);
    }

    showWelcome();
    restoreSessionRuntime(runtimeLocation);
  }

  function updateSession(sessionId, selectedAgentId) {
    if (!sessionId || !sessionSelect) return;

    let option = [...sessionSelect.options].find(
      item => item.value === String(sessionId)
    );

    if (!option) {
      option = document.createElement('option');
      option.value = String(sessionId);
      option.textContent = `Conversation ${sessionId}`;
      sessionSelect.appendChild(option);
    }

    option.dataset.agentId = String(selectedAgentId || '');
    option.dataset.aiId = String(selectedAgentId || '');
    option.selected = true;
  }

  function updateSources(sources) {
    if (!sourcesNode) return;

    sourcesNode.textContent =
      Array.isArray(sources) && sources.length
        ? sources.join(', ')
        : 'No resource excerpts were retrieved for this answer.';
  }

  // ============================================================
  // MARKDOWN RENDERING
  // ============================================================

  async function renderMarkdown(text, signal) {
    if (!answerNode) return;

    if (signal?.aborted) {
      throwIfCancelled(activeGeneration);
    }

    if (typeof text !== 'string' || !text.trim()) {
      answerNode.textContent = '(Empty response)';
      answerNode.style.whiteSpace = 'pre-wrap';
      return;
    }

    try {
      const response = await fetch('/beautify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ text }),
        signal
      });

      if (signal?.aborted) {
        throwIfCancelled(activeGeneration);
      }

      if (!response.ok) {
        throw new Error(
          `Markdown rendering failed: HTTP ${response.status}.`
        );
      }

      const html = await response.text();

      if (signal?.aborted) {
        throwIfCancelled(activeGeneration);
      }

      answerNode.style.whiteSpace = '';
      answerNode.innerHTML = html;
    } catch (error) {
      // Never restore partial text after cancellation.
      if (signal?.aborted) {
        throw error;
      }

      console.error('Could not format chat response:', error);

      answerNode.textContent = text;
      answerNode.style.whiteSpace = 'pre-wrap';
    }
  }

  async function finishAnswer(data, fallbackAnswer = '', run) {
    throwIfCancelled(run);

    const serverAnswer =
      typeof data.answer === 'string' ? data.answer : '';

    const streamedAnswer =
      typeof fallbackAnswer === 'string' ? fallbackAnswer : '';

    const finalAnswer = serverAnswer.trim()
      ? serverAnswer
      : streamedAnswer;

    showResponse();
    updateSources(data.sources);

    const finalAgentId =
      data.agent_id || agentSelect?.value || '';

    // New sessions appear only after successful persistence.
    updateSession(data.session_id, finalAgentId);

    if (!finalAnswer.trim()) {
      if (answerNode) {
        answerNode.textContent =
          'No response text was received. Check the server logs.';
        answerNode.style.whiteSpace = 'pre-wrap';
      }

      setStatus('No answer text was received.');
      return;
    }

    if (answerNode) {
      answerNode.textContent = finalAnswer;
      answerNode.style.whiteSpace = 'pre-wrap';
    }

    await renderMarkdown(finalAnswer, run.controller.signal);

    throwIfCancelled(run);

    if (prompt) {
      prompt.value = '';
    }

    setStatus('Response complete.');
  }

  // ============================================================
  // JSON REQUEST HELPERS
  // ============================================================

  async function readJsonResponse(response) {
    const text = await response.text();

    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return {
        error: text || 'Unexpected response from the server.'
      };
    }
  }

  async function postJson(url, payload, signal) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload),
      signal
    });

    const data = await readJsonResponse(response);

    if (signal?.aborted) {
      throwIfCancelled(activeGeneration);
    }

    if (!response.ok) {
      throw new Error(
        data.error || `Request failed with HTTP ${response.status}.`
      );
    }

    return data;
  }

  // ============================================================
  // RUNTIME AVAILABILITY
  // ============================================================

  async function refreshRuntimeStatus() {
    const checkId = ++runtimeCheckId;

    if (!runtimeStatus) return;

    const option = selectedAgentOption();

    if (!option?.value) {
      runtimeStatus.textContent = 'Choose an agent first.';
      return;
    }

    const runtime = selectedRuntime();

    if (runtime === 'server') {
      runtimeStatus.textContent =
        'Server execution selected. The server will check that a matching deployment is configured.';
      return;
    }

    if (runtime === 'hosted') {
      runtimeStatus.textContent =
        'Hosted execution is not available yet.';
      return;
    }

    if (!supportsWebGPU()) {
      runtimeStatus.textContent =
        'This browser does not expose WebGPU. Choose server execution or use a compatible browser/device.';
      return;
    }

    const modelId = getWebLLMModelId(option);

    if (!modelId) {
      runtimeStatus.textContent =
        'This model has no WebLLM model ID configured. Its Ollama name alone is not sufficient. Choose server execution or configure a compatible browser model.';
      return;
    }

    runtimeStatus.textContent =
      'Checking the WebLLM model catalog…';

    try {
      const available = await isPrebuiltWebLLMModel(modelId);

      if (checkId !== runtimeCheckId) return;

      runtimeStatus.textContent = available
        ? `Browser model ready to load: ${modelId}. First use may download model files.`
        : `WebLLM does not include "${modelId}" in its prebuilt catalog. Choose server execution or configure a supported browser model.`;
    } catch (error) {
      if (checkId !== runtimeCheckId) return;

      runtimeStatus.textContent =
        `Could not check WebLLM: ${error.message}`;
    }
  }

  // ============================================================
  // SERVER STREAMING
  // ============================================================

  async function streamServerResponse(payload, run) {
    const signal = run.controller.signal;

    const response = await fetch('/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/x-ndjson'
      },
      body: JSON.stringify(payload),
      signal
    });

    throwIfCancelled(run);

    const contentType = (
      response.headers.get('content-type') || ''
    ).toLowerCase();

    if (!response.ok) {
      const data = await readJsonResponse(response);

      throwIfCancelled(run);

      throw new Error(data.error || 'Chat request failed.');
    }

    // Accept the legacy JSON response format too.
    if (!contentType.includes('application/x-ndjson')) {
      const data = await readJsonResponse(response);

      throwIfCancelled(run);

      if (typeof data.answer !== 'string') {
        throw new Error(
          data.error || 'Unexpected response from the chat server.'
        );
      }

      await finishAnswer(data, data.answer, run);
      return;
    }

    if (!response.body) {
      throw new Error('The browser cannot read the response stream.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let buffer = '';
    let streamedText = '';
    let finalEvent = null;

    function processLine(line) {
      throwIfCancelled(run);

      if (!line.trim()) return;

      let data;

      try {
        data = JSON.parse(line);
      } catch {
        throw new Error('Received an invalid event from the server.');
      }

      if (data.type === 'token') {
        const token = String(data.token || '');

        if (!token) return;

        streamedText += token;

        if (answerNode) {
          answerNode.textContent = streamedText;
        }

        showResponse();
        return;
      }

      // The server route must emit this event before it starts
      // saving the completed response.
      if (data.type === 'saving') {
        setGenerationSaving(run);
        return;
      }

      if (data.type === 'done') {
        finalEvent = data;
        return;
      }

      if (data.type === 'cancelled') {
        const error = new Error('Chat generation was cancelled.');
        error.name = 'AbortError';
        error.code = 'CHAT_CANCELLED';
        throw error;
      }

      if (data.type === 'error') {
        throw new Error(
          data.error || 'The server model could not finish its response.'
        );
      }
    }

    try {
      while (true) {
        throwIfCancelled(run);

        const { value, done } = await reader.read();

        throwIfCancelled(run);

        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let newlineIndex;

        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          throwIfCancelled(run);

          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);

          processLine(line);
        }
      }

      buffer += decoder.decode();

      if (buffer.trim()) {
        processLine(buffer);
      }
    } catch (error) {
      try {
        await reader.cancel(error);
      } catch {
        // The stream may already be closed.
      }

      throw error;
    } finally {
      reader.releaseLock();
    }

    throwIfCancelled(run);

    if (!finalEvent) {
      throw new Error(
        'The stream ended before the server confirmed completion.'
      );
    }

    // The server has completed and persisted the turn before its
    // "done" event arrives.
    setGenerationSaving(run);
    await finishAnswer(finalEvent, streamedText, run);
  }

  // ============================================================
  // DEVICE-LOCAL WEBLLM GENERATION
  // ============================================================

  async function runDeviceLocalChat(payload, run) {
    const signal = run.controller.signal;
    const option = selectedAgentOption();
    const browserModelId = getWebLLMModelId(option);

    if (!supportsWebGPU()) {
      throw new Error(
        'WebGPU is unavailable in this browser. Select server execution instead.'
      );
    }

    if (!browserModelId) {
      throw new Error(
        'This agent does not have a WebLLM model configured. Select a compatible agent or use server execution.'
      );
    }

    const modelAvailable = await isPrebuiltWebLLMModel(browserModelId);

    throwIfCancelled(run);

    if (!modelAvailable) {
      throw new Error(
        `WebLLM does not support "${browserModelId}" in its prebuilt catalog.`
      );
    }

    setStatus('Preparing local chat context…');

    const prepared = await postJson(
      '/chat/local/prepare',
      {
        agent_id: payload.agent_id,
        session_id: payload.session_id,
        prompt: payload.prompt
      },
      signal
    );

    throwIfCancelled(run);

    if (prepared.model_id !== browserModelId) {
      throw new Error(
        'The browser model configuration does not match the server configuration. Refresh the page and try again.'
      );
    }

    updateSession(prepared.session_id, payload.agent_id);
    updateSources(prepared.sources || []);

    let streamedText = '';

    showResponse();

    if (answerNode) {
      answerNode.textContent = '';
      answerNode.style.whiteSpace = 'pre-wrap';
    }

    const answer = await generateWithWebLLM({
      modelId: prepared.model_id,
      messages: prepared.messages,
      signal,

      onProgress: progress => {
        if (isCancelled(run)) return;

        setStatus(`Loading device model: ${progress}`);
      },

      onToken: token => {
        if (isCancelled(run)) return;

        streamedText += token;

        if (answerNode) {
          answerNode.textContent = streamedText;
        }

        showResponse();
        setStatus('Generating on your device…');
      }
    });

    throwIfCancelled(run);

    // Once generation completes, disable Stop while the completed
    // turn is being persisted.
    setGenerationSaving(run);

    const completed = await postJson(
      '/chat/local/complete',
      {
        agent_id: payload.agent_id,
        session_id: prepared.session_id,
        model_id: prepared.model_id,
        prompt: payload.prompt,
        answer,
        sources: prepared.sources || []
      },
      signal
    );

    throwIfCancelled(run);

    await finishAnswer(completed, streamedText, run);
  }

  // ============================================================
  // PAGE EVENT LISTENERS
  // ============================================================

  agentSelect?.addEventListener('change', () => {
    if (activeGeneration) return;

    showWelcome();

    const preferred =
      selectedAgentOption()?.dataset.preferredRuntime;

    if (
      runtimeSelect &&
      ['device_local', 'server', 'hosted'].includes(preferred)
    ) {
      runtimeSelect.value = preferred;
    } else if (runtimeSelect) {
      runtimeSelect.value = 'device_local';
    }

    refreshRuntimeStatus();
  });

  runtimeSelect?.addEventListener('change', () => {
    if (activeGeneration) return;

    refreshRuntimeStatus();
  });

  sessionSelect?.addEventListener('change', () => {
    if (activeGeneration) {
      setStatus('Stop generation before switching conversations.');
      return;
    }

    const selected = sessionSelect.selectedOptions?.[0];

    if (selected?.dataset.agentId && agentSelect) {
      agentSelect.value = selected.dataset.agentId;
    } else if (selected?.dataset.aiId && agentSelect) {
      agentSelect.value = selected.dataset.aiId;
    }

    showWelcome();

    restoreSessionRuntime(
      selected?.dataset.runtimeLocation
    );
  });

  // ============================================================
  // CONTINUE AN EXISTING CONVERSATION
  // ============================================================

  let sessionLoadId = 0;

  document.querySelectorAll('[data-load-session]').forEach(button => {
    button.addEventListener('click', async () => {
      if (activeGeneration) {
        setStatus('Stop generation before switching conversations.');
        return;
      }

      const sessionId = button.dataset.loadSession;

      if (!sessionId) return;

      const loadId = ++sessionLoadId;
      const originalButtonText = button.textContent;

      button.disabled = true;
      button.textContent = 'Loading…';

      setStatus('Loading conversation…');

      try {
        const response = await fetch(
          `/chat/sessions/${encodeURIComponent(sessionId)}/latest`,
          {
            headers: {
              'Accept': 'application/json'
            }
          }
        );

        const data = await readJsonResponse(response);

        if (!response.ok) {
          throw new Error(
            data.error || 'Could not load this conversation.'
          );
        }

        // Ignore stale results if another conversation was requested.
        if (loadId !== sessionLoadId || activeGeneration) {
          return;
        }

        // Select the conversation, agent and runtime.
        pickSession(
          data.session_id,
          data.agent_id || button.dataset.agentId,
          data.runtime_location || button.dataset.runtimeLocation
        );

        // Restore the prompt that produced the latest response.
        if (prompt) {
          prompt.value = data.prompt || '';
        }

        if (data.hasResponse && data.answer) {
          // Display the latest completed assistant response.
          showResponse();

          if (answerNode) {
            answerNode.textContent = data.answer;
            answerNode.style.whiteSpace = 'pre-wrap';
          }

          updateSources(data.sources || []);

          await renderMarkdown(data.answer);

          if (loadId !== sessionLoadId || activeGeneration) {
            return;
          }

          setStatus(
            'Conversation loaded. The latest prompt is ready to edit or resend.'
          );
        } else {
          clearOutput();

          setStatus(
            'Conversation selected. No completed response is saved yet.'
          );
        }

        prompt?.focus({ preventScroll: true });

        window.scrollTo({
          top: 0,
          behavior: 'smooth'
        });
      } catch (error) {
        if (loadId !== sessionLoadId) return;

        console.error('Could not continue conversation:', error);

        setStatus(error.message || 'Could not load conversation.');
      } finally {
        button.disabled = false;
        button.textContent = originalButtonText;
      }
    });
  });

  // ============================================================
  // SEND / STOP BUTTON
  // ============================================================

  showWelcome();
  refreshRuntimeStatus();

  form?.addEventListener('submit', async event => {
    event.preventDefault();

    if (activeGeneration) {
      // Ignore keyboard-triggered form submissions while saving.
      if (activeGeneration.saving) {
        return;
      }

      stopGeneration();
      return;
    }

    const agentId = agentSelect?.value;
    const message = prompt?.value.trim();

    if (!agentId || !message) return;

    if (message.length > 10000) {
      setStatus('Messages must be 10,000 characters or fewer.');
      return;
    }

    const payload = {
      agent_id: agentId,
      session_id: sessionSelect?.value || null,
      prompt: message,
      runtime_location: selectedRuntime()
    };

    const run = {
      id: ++generationRunId,
      controller: new AbortController(),
      runtime: payload.runtime_location,
      cancelled: false,
      saving: false
    };

    activeGeneration = run;

    setSendButtonState('generating');

    if (status) {
      status.classList.add('is-generating');
    }

    clearOutput();
    showResponse();

    setStatus(
      payload.runtime_location === 'device_local'
        ? 'Preparing device-local generation…'
        : 'Sending request to the server…'
    );

    try {
      if (payload.runtime_location === 'device_local') {
        await runDeviceLocalChat(payload, run);
      } else if (payload.runtime_location === 'server') {
        await streamServerResponse(payload, run);
      } else {
        throw new Error(
          'Hosted inference is not available yet.'
        );
      }
    } catch (error) {
      if (
        isCancelled(run) ||
        error.name === 'AbortError' ||
        error.code === 'CHAT_CANCELLED' ||
        error.code === 'ABORT_ERR'
      ) {
        clearOutput();
        setStatus('Generation stopped.');
      } else {
        console.error('Chat request failed:', error);

        setStatus(error.message || 'Chat request failed.');

        if (answerNode?.textContent) {
          showResponse();
        }
      }
    } finally {
      restoreAfterGeneration(run);
    }
  });

  // ============================================================
  // OPEN CHAT FROM THE AI MODEL HUB
  // ============================================================

  async function initializeFromAgentLink() {
    const params = new URLSearchParams(window.location.search);
    const agentId = params.get('agent_id');

    // Normal visits to /chat continue behaving as before.
    if (!agentId) return;

    const option = [...(agentSelect?.options || [])].find(
      item => item.value === agentId
    );

    if (!option) {
      setStatus('The requested agent is unavailable.');
      return;
    }

    const supportedRuntimes = [
      'device_local',
      'server',
      'hosted'
    ];

    const requestedRuntime = params.get('runtime_location');

    const preferredRuntime =
      option.dataset.preferredRuntime || 'device_local';

    agentSelect.value = agentId;
    showWelcome();

    if (runtimeSelect) {
      runtimeSelect.value = supportedRuntimes.includes(
        requestedRuntime
      )
        ? requestedRuntime
        : preferredRuntime;
    }

    await refreshRuntimeStatus();

    clearOutput();

    if (prompt) {
      prompt.value = '';
    }

    setStatus('Loading the latest conversation…');

    try {
      const response = await fetch(
        `/chat/agents/${encodeURIComponent(agentId)}/latest`,
        {
          headers: {
            'Accept': 'application/json'
          }
        }
      );

      const data = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(
          data.error || 'Could not load the agent conversation.'
        );
      }

      // Keep the requested agent selected.
      agentSelect.value = String(data.agent_id || agentId);
      showWelcome();

      if (data.session_id) {
        updateSession(data.session_id, data.agent_id);

        // Restore the latest conversation and its runtime.
        pickSession(
          data.session_id,
          data.agent_id,
          data.runtime_location || preferredRuntime
        );

        if (prompt) {
          prompt.value = data.prompt || '';
        }

        if (data.hasResponse && data.answer) {
          showResponse();
          updateSources(data.sources || []);

          if (answerNode) {
            answerNode.textContent = data.answer;
            answerNode.style.whiteSpace = 'pre-wrap';
          }

          await renderMarkdown(data.answer);

          setStatus(
            'Latest conversation loaded. Your previous prompt is ready to edit or resend.'
          );
        } else {
          clearOutput();
          setStatus(
            'Conversation selected. No completed response is available yet.'
          );
        }
      } else {
        // No completed conversation exists for this agent.
        // Do not create a session until generation succeeds.
        if (sessionSelect) {
          sessionSelect.value = '';
        }

        if (runtimeSelect) {
          runtimeSelect.value = supportedRuntimes.includes(
            data.runtime_location
          )
            ? data.runtime_location
            : preferredRuntime;
        }

        if (prompt) {
          prompt.value = '';
        }

        clearOutput();

        setStatus(
          'Agent selected. No previous conversation found. Start a new conversation.'
        );
      }

      prompt?.focus({ preventScroll: true });

      window.scrollTo({
        top: 0,
        behavior: 'smooth'
      });
    } catch (error) {
      console.error(
        'Could not initialize chat from the AI Model Hub:',
        error
      );

      setStatus(
        error.message || 'Could not load the agent conversation.'
      );
    }
  }

  initializeFromAgentLink();
});