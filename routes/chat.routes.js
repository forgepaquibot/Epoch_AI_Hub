const express = require('express');
const requireUser = require('../middleware/requireUser');
const { sqlGet, sqlAll, sqlRun } = require('../db/database');
const MarkdownIt = require('markdown-it');
const { katex } = require('@mdit/plugin-katex');

const {
  sendChatMessage,
  prepareDeviceLocalChat,
  completeDeviceLocalChat
} = require('../services/chat.service');

const router = express.Router();
const md = new MarkdownIt();

md.use(katex);

// ============================================================
// STREAMING HELPERS
// ============================================================

function writeNdjson(res, event) {
  if (res.destroyed || res.writableEnded) {
    return Promise.resolve();
  }

  const canContinue = res.write(
    `${JSON.stringify(event)}\n`
  );

  if (canContinue) {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    const finish = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      resolve();
    };

    const onDrain = finish;
    const onClose = finish;

    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

function getChatErrorMessage(err) {
  if (err.status && err.status < 500) {
    return err.message;
  }

  return (
    'Could not generate a response. ' +
    'Check the selected model runtime and server logs.'
  );
}

function isCancellationError(err, signal) {
  return Boolean(
    signal?.aborted ||
    err?.name === 'AbortError' ||
    err?.code === 'CHAT_CANCELLED' ||
    err?.code === 'ABORT_ERR'
  );
}

// ============================================================
// CHAT PAGE
// ============================================================

router.get('/chat', requireUser, async (req, res, next) => {
  try {
    const userId = req.session.user.id;

    const agents = await sqlAll(
      `SELECT
          a.agent_id,
          a.agent_id AS ai_id,
          a.model_id,
          a.name,
          a.name AS agent_name,
          a.description,
          a.personality_prompt,
          a.welcome_message,
          a.preferred_runtime_location,
          a.preferred_server_deployment_id,
          a.allow_fallback_to_server,
          a.is_public,
          a.user_id,
          u.username AS owner_username,
          m.name AS model_name,
          m.model_key,
          m.model_key AS model_ref,
          m.model_family,
          m.model_format,
          m.model_version,
          m.metadata_json AS model_metadata_json

       FROM ai_agents a

       JOIN ai_models m
         ON m.model_id = a.model_id

       JOIN users u
         ON u.user_id = a.user_id

       WHERE (a.user_id = ? OR a.is_public = 1)
         AND COALESCE(a.is_deprecated, 0) = 0

       ORDER BY
          CASE WHEN a.user_id = ? THEN 0 ELSE 1 END,
          a.name COLLATE NOCASE`,
      [userId, userId]
    );

    const sessions = await sqlAll(
      `SELECT
          cs.session_id,
          cs.agent_id,
          cs.agent_id AS ai_id,
          cs.title,
          cs.updated_at,
          cs.runtime_location,
          a.name AS agent_name

       FROM chat_sessions cs

       JOIN ai_agents a
         ON a.agent_id = cs.agent_id

       WHERE cs.user_id = ?
         AND COALESCE(a.is_deprecated, 0) = 0

       ORDER BY cs.updated_at DESC
       LIMIT 30`,
      [userId]
    );

    const message = req.session.message || null;
    req.session.message = null;

    return res.render('chat', {
      title: 'Chat',
      agents,
      models: agents,
      sessions,
      message
    });
  } catch (err) {
    return next(err);
  }
});

// ============================================================
// LOAD LATEST COMPLETED CONVERSATION FOR AN AGENT
// ============================================================

router.get(
  '/chat/agents/:agentId/latest',
  requireUser,
  async (req, res) => {
    try {
      const userId = req.session.user.id;
      const agentId = Number(req.params.agentId);

      if (!Number.isSafeInteger(agentId) || agentId <= 0) {
        return res.status(400).json({
          error: 'Invalid agent.'
        });
      }

      const agent = await sqlGet(
        `SELECT agent_id, preferred_runtime_location
           FROM ai_agents
          WHERE agent_id = ?
            AND (user_id = ? OR is_public = 1)
            AND COALESCE(is_deprecated, 0) = 0`,
        [agentId, userId]
      );

      if (!agent) {
        return res.status(404).json({
          error: 'Agent not found or access denied.'
        });
      }

      // Find the latest conversation for this user and agent
      // that contains a completed assistant response.
      const session = await sqlGet(
        `SELECT
            cs.session_id,
            cs.agent_id,
            cs.runtime_location

           FROM chat_sessions cs

          WHERE cs.user_id = ?
            AND cs.agent_id = ?

            AND EXISTS (
              SELECT 1
                FROM chat_messages cm
               WHERE cm.session_id = cs.session_id
                 AND cm.role = 'assistant'
            )

          ORDER BY (
            SELECT MAX(cm.message_id)
              FROM chat_messages cm
             WHERE cm.session_id = cs.session_id
               AND cm.role = 'assistant'
          ) DESC

          LIMIT 1`,
        [userId, agentId]
      );

      // No previous completed conversation: preselect the agent
      // and its preferred runtime, without creating a session.
      if (!session) {
        return res.json({
          agent_id: agent.agent_id,
          runtime_location:
            agent.preferred_runtime_location || 'device_local',
          session_id: null,
          prompt: '',
          answer: '',
          sources: [],
          hasResponse: false
        });
      }

      const assistantMessage = await sqlGet(
        `SELECT message_id, content, sources_json
           FROM chat_messages
          WHERE session_id = ?
            AND role = 'assistant'
          ORDER BY message_id DESC
          LIMIT 1`,
        [session.session_id]
      );

      const userMessage = await sqlGet(
        `SELECT content
           FROM chat_messages
          WHERE session_id = ?
            AND role = 'user'
            AND message_id < ?
          ORDER BY message_id DESC
          LIMIT 1`,
        [session.session_id, assistantMessage.message_id]
      );

      let sources = [];

      try {
        const parsed = JSON.parse(
          assistantMessage.sources_json || '[]'
        );

        if (Array.isArray(parsed)) {
          sources = parsed;
        }
      } catch {
        sources = [];
      }

      return res.json({
        agent_id: session.agent_id,
        session_id: session.session_id,
        runtime_location:
          session.runtime_location ||
          agent.preferred_runtime_location ||
          'device_local',
        prompt: userMessage?.content || '',
        answer: assistantMessage.content || '',
        sources,
        hasResponse: Boolean(assistantMessage.content)
      });
    } catch (err) {
      console.error(
        'Could not load latest agent conversation:',
        err
      );

      return res.status(500).json({
        error: 'Could not load the latest conversation.'
      });
    }
  }
);

// ============================================================
// LOAD THE LATEST TURN OF A CONVERSATION
// ============================================================

router.get(
  '/chat/sessions/:sessionId/latest',
  requireUser,
  async (req, res) => {
    try {
      const userId = req.session.user.id;
      const sessionId = Number(req.params.sessionId);

      if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
        return res.status(400).json({
          error: 'Invalid conversation.'
        });
      }

      // Ensure this conversation belongs to the signed-in user.
      const session = await sqlGet(
        `SELECT session_id, agent_id, runtime_location
           FROM chat_sessions
          WHERE session_id = ?
            AND user_id = ?`,
        [sessionId, userId]
      );

      if (!session) {
        return res.status(404).json({
          error: 'Conversation not found or access denied.'
        });
      }

      // Retrieve the most recent completed assistant response.
      const assistantMessage = await sqlGet(
        `SELECT message_id, content, sources_json
           FROM chat_messages
          WHERE session_id = ?
            AND role = 'assistant'
          ORDER BY message_id DESC
          LIMIT 1`,
        [sessionId]
      );

      // If there is no assistant response yet, return the latest
      // user prompt when one exists.
      if (!assistantMessage) {
        const latestUserMessage = await sqlGet(
          `SELECT content
             FROM chat_messages
            WHERE session_id = ?
              AND role = 'user'
            ORDER BY message_id DESC
            LIMIT 1`,
          [sessionId]
        );

        return res.json({
          session_id: session.session_id,
          agent_id: session.agent_id,
          runtime_location: session.runtime_location,
          prompt: latestUserMessage?.content || '',
          answer: '',
          sources: [],
          hasResponse: false
        });
      }

      // Find the user prompt immediately preceding that response.
      const userMessage = await sqlGet(
        `SELECT content
           FROM chat_messages
          WHERE session_id = ?
            AND role = 'user'
            AND message_id < ?
          ORDER BY message_id DESC
          LIMIT 1`,
        [sessionId, assistantMessage.message_id]
      );

      let sources = [];

      try {
        const parsed = JSON.parse(
          assistantMessage.sources_json || '[]'
        );

        if (Array.isArray(parsed)) {
          sources = parsed;
        }
      } catch {
        sources = [];
      }

      return res.json({
        session_id: session.session_id,
        agent_id: session.agent_id,
        runtime_location: session.runtime_location,
        prompt: userMessage?.content || '',
        answer: assistantMessage.content || '',
        sources,
        hasResponse: Boolean(assistantMessage.content)
      });
    } catch (err) {
      console.error('Could not load conversation:', err);

      return res.status(500).json({
        error: 'Could not load the conversation.'
      });
    }
  }
);

// ============================================================
// MARKDOWN FORMATTING
// ============================================================

router.post(
  '/beautify',
  requireUser,
  express.json({ limit: '1mb' }),
  async (req, res, next) => {
    try {
      const markdown = req.body?.text;

      if (
        typeof markdown !== 'string' ||
        !markdown.trim()
      ) {
        return res.status(400).send(
          'Invalid or empty Markdown text.'
        );
      }

      return res
        .type('html')
        .send(md.render(markdown));
    } catch (err) {
      return next(err);
    }
  }
);

// ============================================================
// PREPARE A DEVICE-LOCAL CHAT TURN
// ============================================================

router.post(
  '/chat/local/prepare',
  requireUser,
  async (req, res) => {
    try {
      const agentId = Number(req.body.agent_id);

      const rawSessionId = req.body.session_id;
      const requestedSessionId =
        rawSessionId == null || rawSessionId === ''
          ? null
          : Number(rawSessionId);

      const prompt = String(
        req.body.prompt || ''
      ).trim();

      if (
        !Number.isSafeInteger(agentId) ||
        agentId <= 0 ||
        !prompt
      ) {
        return res.status(400).json({
          error: 'Select an agent and enter a message.'
        });
      }

      if (
        requestedSessionId !== null &&
        (
          !Number.isSafeInteger(requestedSessionId) ||
          requestedSessionId <= 0
        )
      ) {
        return res.status(400).json({
          error: 'Invalid chat session.'
        });
      }

      const result = await prepareDeviceLocalChat({
        userId: req.session.user.id,
        agentId,
        prompt,
        requestedSessionId
      });

      return res.json(result);
    } catch (err) {
      console.error('Local chat preparation error:', err);

      const status = err.status || 500;

      return res.status(status).json({
        error: status < 500
          ? err.message
          : 'Could not prepare the device-local conversation.',
        code: err.code || 'LOCAL_CHAT_PREPARE_ERROR'
      });
    }
  }
);

// ============================================================
// SAVE A COMPLETED DEVICE-LOCAL CHAT TURN
// ============================================================

router.post(
  '/chat/local/complete',
  requireUser,
  async (req, res) => {
    try {
      const agentId = Number(req.body.agent_id);

      const rawSessionId = req.body.session_id;
      const sessionId =
        rawSessionId == null || rawSessionId === ''
          ? null
          : Number(rawSessionId);

      const modelId = String(
        req.body.model_id || ''
      ).trim();

      const prompt = req.body.prompt;
      const answer = req.body.answer;
      const sources = req.body.sources;

      if (
        !Number.isSafeInteger(agentId) ||
        agentId <= 0 ||
        (
          sessionId !== null &&
          (
            !Number.isSafeInteger(sessionId) ||
            sessionId <= 0
          )
        ) ||
        !modelId
      ) {
        return res.status(400).json({
          error: 'Invalid agent, conversation, or model.'
        });
      }

      const result = await completeDeviceLocalChat({
        userId: req.session.user.id,
        agentId,
        sessionId,
        modelId,
        prompt,
        answer,
        sources
      });

      return res.json(result);
    } catch (err) {
      console.error('Local chat completion error:', err);

      const status = err.status || 500;

      return res.status(status).json({
        error: status < 500
          ? err.message
          : 'Could not save the device-local response.',
        code: err.code || 'LOCAL_CHAT_COMPLETE_ERROR'
      });
    }
  }
);

// ============================================================
// DELETE A CONVERSATION
// ============================================================

router.post(
  '/chat/sessions/:sessionId/delete',
  requireUser,
  async (req, res, next) => {
    try {
      const userId = req.session.user.id;
      const sessionId = Number(req.params.sessionId);

      if (
        !Number.isSafeInteger(sessionId) ||
        sessionId <= 0
      ) {
        req.session.message = 'Invalid conversation.';
        return res.redirect('/chat');
      }

      const session = await sqlGet(
        `SELECT session_id, title
           FROM chat_sessions
          WHERE session_id = ?
            AND user_id = ?`,
        [sessionId, userId]
      );

      if (!session) {
        req.session.message =
          'Conversation not found or access denied.';

        return res.redirect('/chat');
      }

      const result = await sqlRun(
        `DELETE FROM chat_sessions
          WHERE session_id = ?
            AND user_id = ?`,
        [sessionId, userId]
      );

      if (result.changes !== 1) {
        req.session.message =
          'The conversation could not be deleted.';

        return res.redirect('/chat');
      }

      req.session.message =
        'Conversation and its messages deleted successfully.';

      return res.redirect('/chat');
    } catch (err) {
      return next(err);
    }
  }
);

// ============================================================
// SEND A CHAT MESSAGE
// ============================================================

router.post('/chat', requireUser, async (req, res) => {
  const agentId = Number(
    req.body.agent_id ?? req.body.ai_id
  );

  const prompt = String(
    req.body.prompt || ''
  ).trim();

  const rawSessionId = req.body.session_id;

  const requestedSessionId =
    rawSessionId == null || rawSessionId === ''
      ? null
      : Number(rawSessionId);

  const rawDeploymentId = req.body.deployment_id;

  const deploymentId =
    rawDeploymentId == null || rawDeploymentId === ''
      ? null
      : Number(rawDeploymentId);

  const runtimeLocation =
    req.body.runtime_location || undefined;

  if (
    !Number.isSafeInteger(agentId) ||
    agentId <= 0 ||
    !prompt
  ) {
    return res.status(400).json({
      error: 'Select an agent and enter a prompt.'
    });
  }

  if (prompt.length > 10000) {
    return res.status(400).json({
      error: 'Prompt must be 10,000 characters or fewer.'
    });
  }

  if (
    requestedSessionId !== null &&
    (
      !Number.isSafeInteger(requestedSessionId) ||
      requestedSessionId <= 0
    )
  ) {
    return res.status(400).json({
      error: 'Invalid chat session.'
    });
  }

  if (
    deploymentId !== null &&
    (
      !Number.isSafeInteger(deploymentId) ||
      deploymentId <= 0
    )
  ) {
    return res.status(400).json({
      error: 'Invalid model deployment.'
    });
  }

  if (
    runtimeLocation !== undefined &&
    !['device_local', 'server', 'hosted'].includes(
      runtimeLocation
    )
  ) {
    return res.status(400).json({
      error: 'Unsupported runtime location.'
    });
  }

  const wantsStream = String(
    req.get('accept') || ''
  ).includes('application/x-ndjson');

  let streamStarted = false;

  // ----------------------------------------------------------
  // CANCELLATION
  // ----------------------------------------------------------

  const generationController = new AbortController();
  const { signal } = generationController;

  function removeCancellationListeners() {
    req.off('aborted', abortGenerationOnDisconnect);
    res.off('close', abortGenerationOnDisconnect);
    res.off('finish', removeCancellationListeners);
  }

  function abortGenerationOnDisconnect() {
    if (!res.writableEnded && !signal.aborted) {
      const error = new Error(
        'Chat generation was cancelled because the client disconnected.'
      );

      error.name = 'AbortError';
      error.code = 'CHAT_CANCELLED';

      generationController.abort(error);

      console.log(
        '[Chat] Client disconnected; cancelling generation.'
      );
    }

    if (res.destroyed || signal.aborted) {
      removeCancellationListeners();
    }
  }

  req.once('aborted', abortGenerationOnDisconnect);
  res.once('close', abortGenerationOnDisconnect);
  res.once('finish', removeCancellationListeners);

  // ----------------------------------------------------------
  // STREAMING
  // ----------------------------------------------------------

  function startStream() {
    if (
      streamStarted ||
      res.destroyed ||
      res.writableEnded
    ) {
      return;
    }

    res.status(200);

    res.set({
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no'
    });

    res.flushHeaders();
    streamStarted = true;
  }

  // ----------------------------------------------------------
  // GENERATION
  // ----------------------------------------------------------

  try {
    const userId = req.session.user.id;

    // Preserve the non-streaming API.
    if (!wantsStream) {
      const result = await sendChatMessage({
        userId,
        agentId,
        prompt,
        requestedSessionId,
        deploymentId,
        runtimeLocation,
        signal
      });

      if (signal.aborted || res.destroyed) {
        return;
      }

      return res.json(result);
    }

    const result = await sendChatMessage({
      userId,
      agentId,
      prompt,
      requestedSessionId,
      deploymentId,
      runtimeLocation,
      signal,

      onToken: async token => {
        if (
          signal.aborted ||
          res.destroyed ||
          res.writableEnded
        ) {
          return;
        }

        startStream();

        await writeNdjson(res, {
          type: 'token',
          token
        });
      },

      // chat.service.js must await this callback immediately
      // before persisting the completed turn.
      onSaving: async () => {
        if (
          signal.aborted ||
          res.destroyed ||
          res.writableEnded
        ) {
          const error = new Error('Chat generation was cancelled.');
          error.name = 'AbortError';
          error.code = 'CHAT_CANCELLED';
          throw error;
        }

        startStream();

        await writeNdjson(res, {
          type: 'saving'
        });

        if (signal.aborted || res.destroyed) {
          const error = new Error('Chat generation was cancelled.');
          error.name = 'AbortError';
          error.code = 'CHAT_CANCELLED';
          throw error;
        }
      }
    });

    if (
      signal.aborted ||
      res.destroyed ||
      res.writableEnded
    ) {
      return;
    }

    startStream();

    await writeNdjson(res, {
      type: 'done',
      answer: result.answer,
      sources: result.sources,
      session_id: result.session_id,
      agent_id: result.agent_id,
      runtime_location: result.runtime_location,
      provider: result.provider,
      model_ref: result.model_ref
    });

    return res.end();
  } catch (err) {
    if (isCancellationError(err, signal)) {
      console.log('[Chat] Generation cancelled.');

      if (res.destroyed || res.writableEnded) {
        return;
      }

      if (streamStarted) {
        await writeNdjson(res, {
          type: 'cancelled',
          code: 'CHAT_CANCELLED'
        });

        return res.end();
      }

      return res.status(499).json({
        error: 'Generation stopped.',
        code: 'CHAT_CANCELLED'
      });
    }

    console.error('Chat error:', err);

    if (res.destroyed || res.writableEnded) {
      return;
    }

    const message = getChatErrorMessage(err);

    if (!streamStarted && !res.headersSent) {
      return res.status(err.status || 500).json({
        error: message,
        code: err.code || 'CHAT_ERROR'
      });
    }

    await writeNdjson(res, {
      type: 'error',
      error: message,
      code: err.code || 'CHAT_ERROR'
    });

    return res.end();
  }
});

module.exports = router;