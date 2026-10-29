const express = require('express');
const requireUser = require('../middleware/requireUser');

const {
  sqlGet,
  sqlAll,
  sqlRun,
  withTransaction
} = require('../db/database');

const {
  EMBEDDING_MODEL,
  OLLAMA_BASE_URL,
  getOllamaModels
} = require('../services/ollama.service');

const {
  mapResourceForTemplate
} = require('../services/resource-processing.service');

const {
  getAccessibleModel,
  getAccessibleAgent,
  getAccessibleResource
} = require('../services/model-registry.service');

const {
  startResourceIndexingWorker
} = require('../services/resource-indexing-worker.service');

const router = express.Router();

// Run indexing jobs independently of browser navigation.
startResourceIndexingWorker();

function redirectWithMessage(
  req,
  res,
  message,
  destination = '/ai_model'
) {
  req.session.message = message;
  return res.redirect(destination);
}

function parsePositiveInteger(value) {
  const number = Number(value);

  return Number.isInteger(number) && number > 0
    ? number
    : null;
}

function asAgentForLegacyTemplate(agent) {
  if (!agent) return agent;

  // Temporary aliases for existing Pug templates and links that still
  // refer to an agent as a "model" and use ai_id.
  return {
    ...agent,
    ai_id: agent.agent_id,
    model_ref: agent.model_key,
    model_display_name: agent.model_name || agent.name
  };
}


// ============================================================
// SERVER OLLAMA CONNECTION
// ============================================================

async function getOrCreateServerOllamaConnection() {
  const baseUrl = OLLAMA_BASE_URL.replace(/\/+$/, '');

  let connection = await sqlGet(
    `SELECT *
       FROM model_connections
      WHERE owner_user_id IS NULL
        AND provider = 'ollama'
        AND runtime_location = 'server'
        AND base_url = ?
        AND is_enabled = 1
      ORDER BY connection_id ASC
      LIMIT 1`,
    [baseUrl]
  );

  if (connection) return connection;

  const inserted = await sqlRun(
    `INSERT INTO model_connections (
        owner_user_id,
        name,
        provider,
        runtime_location,
        base_url,
        is_enabled
     )
     VALUES (NULL, ?, 'ollama', 'server', ?, 1)`,
    ['Application Ollama Server', baseUrl]
  );

  connection = await sqlGet(
    `SELECT *
       FROM model_connections
      WHERE connection_id = ?`,
    [inserted.lastID]
  );

  return connection;
}


// ============================================================
// GET OR CREATE LOGICAL MODEL AND SERVER DEPLOYMENT
//
// Reuses existing deployments, including deployments disabled
// during unregistration. Re-registering a model does not restore
// any previously deprecated agents.
// ============================================================

async function getOrCreateOllamaModelAndDeployment({
  userId,
  modelRef,
  installedModel
}) {
  const connection = await getOrCreateServerOllamaConnection();

  // Find the deployment regardless of whether it is currently enabled.
  // The unique connection/model-reference pair must not be inserted twice.
  let deployment = await sqlGet(
    `SELECT
        md.*,
        md.model_id AS resolved_model_id
       FROM model_deployments md
      WHERE md.connection_id = ?
        AND md.provider_model_ref = ?
      LIMIT 1`,
    [connection.connection_id, modelRef]
  );

  let modelId;

  if (deployment) {
    // Reuse the logical model attached to the existing deployment.
    modelId = deployment.resolved_model_id;

    await sqlRun(
      `UPDATE ai_models
          SET is_registered = 1
        WHERE model_id = ?`,
      [modelId]
    );

    // Restore the deployment rather than attempting a duplicate insert.
    await sqlRun(
      `UPDATE model_deployments
          SET is_enabled = 1,
              availability_status = 'available',
              last_checked_at = CURRENT_TIMESTAMP,
              last_error = NULL
        WHERE deployment_id = ?`,
      [deployment.deployment_id]
    );

    deployment = await sqlGet(
      `SELECT *
         FROM model_deployments
        WHERE deployment_id = ?`,
      [deployment.deployment_id]
    );
  } else {
    // No deployment exists for this server connection and model reference.
    const model = await sqlGet(
      `SELECT *
         FROM ai_models
        WHERE user_id = ?
          AND model_key = ?
        LIMIT 1`,
      [userId, modelRef]
    );

    if (!model) {
      const insertedModel = await sqlRun(
        `INSERT INTO ai_models (
            name,
            model_key,
            description,
            model_family,
            model_format,
            model_version,
            model_digest,
            model_origin,
            is_registered,
            is_public,
            user_id
         )
         VALUES (?, ?, NULL, ?, ?, NULL, ?, 'registered', 1, 0, ?)`,
        [
          modelRef,
          modelRef,
          installedModel.details?.family || null,
          installedModel.details?.format || null,
          installedModel.digest || null,
          userId
        ]
      );

      modelId = insertedModel.lastID;
    } else {
      modelId = model.model_id;

      await sqlRun(
        `UPDATE ai_models
            SET is_registered = 1
          WHERE model_id = ?
            AND user_id = ?`,
        [modelId, userId]
      );
    }

    const insertedDeployment = await sqlRun(
      `INSERT INTO model_deployments (
          model_id,
          connection_id,
          provider_model_ref,
          availability_status,
          last_checked_at,
          is_enabled
       )
       VALUES (?, ?, ?, 'available', CURRENT_TIMESTAMP, 1)`,
      [modelId, connection.connection_id, modelRef]
    );

    deployment = await sqlGet(
      `SELECT *
         FROM model_deployments
        WHERE deployment_id = ?`,
      [insertedDeployment.lastID]
    );
  }

  return {
    modelId,
    connection,
    deployment
  };
}


// ============================================================
// RESOURCE INDEXING STATUS API
// ============================================================

router.get('/resource-processing/jobs', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  // Return JSON rather than redirecting unauthenticated fetch requests.
  const userId = Number(req.session?.user?.id);

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(401).json({
      jobs: [],
      error: 'Authentication required.'
    });
  }

  try {
    const jobs = await sqlAll(
      `SELECT
          j.processing_job_id,
          j.resource_id,
          j.operation,
          j.status,
          j.progress_percent,
          j.created_at,
          j.started_at,
          j.completed_at,
          j.error_message,
          r.title AS resource_title,
          r.processing_status AS resource_status
       FROM resource_processing_jobs j
       JOIN data_resources r
         ON r.resource_id = j.resource_id
      WHERE j.requested_by = ?
      ORDER BY
        CASE
          WHEN j.status IN ('pending', 'running') THEN 0
          ELSE 1
        END,
        j.created_at DESC,
        j.processing_job_id DESC
      LIMIT 20`,
      [userId]
    );

    return res.json({ jobs });
  } catch (err) {
    console.error(
      'Could not load resource-processing jobs:',
      err
    );

    return res.status(500).json({
      jobs: [],
      error: 'Could not load indexing status.'
    });
  }
});

// ============================================================
// CLEAR TERMINAL RESOURCE-PROCESSING JOB HISTORY
//
// Deletes only this user's completed, failed, and cancelled jobs.
// Pending and running jobs are preserved.
// Resources, embeddings, and resource links are not deleted.
// ============================================================

router.post(
  '/resource-processing/jobs/clear-history',
  requireUser,
  async (req, res) => {
    const userId = Number(req.session.user.id);

    try {
      const result = await sqlRun(
        `DELETE FROM resource_processing_jobs
          WHERE requested_by = ?
            AND status IN ('done', 'failed', 'cancelled')`,
        [userId]
      );

      const deletedCount = Number(result.changes || 0);

      const message = deletedCount === 0
        ? 'There are no completed, failed, or cancelled indexing jobs to clear.'
        : `Cleared ${deletedCount} indexing job${deletedCount === 1 ? '' : 's'} from history. Active jobs and indexed resources were kept.`;

      return redirectWithMessage(
        req,
        res,
        message,
        '/ai_model'
      );
    } catch (err) {
      console.error(
        'Could not clear resource-processing history:',
        err
      );

      return redirectWithMessage(
        req,
        res,
        'Could not clear indexing history. Check the server logs.',
        '/ai_model'
      );
    }
  }
);

// ============================================================
// MODEL HUB PAGE
// ============================================================

router.get('/ai_model', requireUser, async (req, res) => {
  const userId = req.session.user.id;

  let message = req.session.message || null;
  req.session.message = null;

  let ollamaModels = [];

  try {
    const installedModels = await getOllamaModels();

    ollamaModels = installedModels.filter(model => {
      const ref = model.name || model.model;

      return ref && ref !== EMBEDDING_MODEL;
    });
  } catch (err) {
    console.error(
      'Ollama connection error:',
      err.message
    );

    message = message ||
      'Could not connect to the application Ollama server. Registered models and agents may still be available.';
  }

  try {
    // Keep deprecated agents visible to their owners in the Model Hub
    // so they can delete them. The shared agent-access helpers deliberately
    // exclude deprecated agents from normal application use.
    const agents = await sqlAll(
      `SELECT
          a.*,
          a.agent_id AS ai_id,
          a.name AS agent_name,

          m.name AS model_name,
          m.model_key,
          m.model_key AS model_ref,
          m.model_format,
          m.model_digest,
          m.model_origin,
          m.metadata_json AS model_metadata_json,

          COALESCE((
            SELECT mc.provider
              FROM model_deployments md
              JOIN model_connections mc
                ON mc.connection_id = md.connection_id
             WHERE md.model_id = m.model_id
               AND md.is_enabled = 1
               AND mc.is_enabled = 1
             ORDER BY md.deployment_id ASC
             LIMIT 1
          ), 'unknown') AS provider,

          u.username AS owner_username

       FROM ai_agents a

       JOIN ai_models m
         ON m.model_id = a.model_id

       JOIN users u
         ON u.user_id = a.user_id

       WHERE a.user_id = ?
          OR a.is_public = 1

       ORDER BY
         CASE WHEN a.user_id = ? THEN 0 ELSE 1 END,
         a.agent_id DESC`,
      [userId, userId]
    );

    const registeredModels = await sqlAll(
      `SELECT
          m.*,
          u.username AS owner_username,

          CASE WHEN EXISTS (
            SELECT 1
              FROM model_deployments md
              JOIN model_connections mc
                ON mc.connection_id = md.connection_id
             WHERE md.model_id = m.model_id
               AND md.is_enabled = 1
               AND mc.is_enabled = 1
          ) THEN 1 ELSE 0 END AS has_enabled_deployment

       FROM ai_models m

       JOIN users u
         ON u.user_id = m.user_id

       WHERE m.is_registered = 1
         AND (
           m.user_id = ?
           OR m.is_public = 1
         )

       ORDER BY
         CASE WHEN m.user_id = ? THEN 0 ELSE 1 END,
         m.model_id DESC`,
      [userId, userId]
    );

    const rawResources = await sqlAll(
      `SELECT
          dr.*,
          u.username AS owner_username

       FROM data_resources dr

       JOIN users u
         ON u.user_id = dr.user_id

       WHERE dr.user_id = ?
          OR dr.is_public = 1

       ORDER BY
         CASE WHEN dr.user_id = ? THEN 0 ELSE 1 END,
         dr.resource_id DESC`,
      [userId, userId]
    );

    const resources = rawResources.map(
      mapResourceForTemplate
    );

    const ownedResources = resources.filter(
      resource =>
        Number(resource.user_id) === Number(userId)
    );

    const readyResources = resources.filter(
      resource => resource.processing_status === 'ready'
    );

    const processingJobs = await sqlAll(
      `SELECT
          rpj.*,
          dr.title AS resource_title,
          dr.resource_type

       FROM resource_processing_jobs rpj

       JOIN data_resources dr
         ON dr.resource_id = rpj.resource_id

       WHERE rpj.requested_by = ?

       ORDER BY rpj.processing_job_id DESC
       LIMIT 20`,
      [userId]
    );

    const activeAgents = agents.filter(
      agent =>
        Number(agent.is_deprecated) !== 1
    );

    return res.render('ai_model', {
      title: 'AI Models & Agents',
      models: agents,
      agents,
      activeAgents,
      registeredModels,
      ollamaModels,
      resources,
      ownedResources,
      readyResources,
      processingJobs,
      jobs: [],
      currentUserId: userId,
      message
    });
  } catch (err) {
    console.error('AI Model Hub error:', err);

    return res.status(500).send(
      'Could not load the AI Model Hub. Check that the database matches schema v2.'
    );
  }
});


// ============================================================
// UNREGISTER MODEL AND DEPRECATE DEPENDENT AGENTS
//
// Keeps model and agent records for history.
// ============================================================

router.post(
  '/catalog/models/:id/unregister',
  requireUser,
  async (req, res) => {
    const userId = Number(req.session.user.id);
    const modelId = parsePositiveInteger(req.params.id);

    if (!modelId) {
      return redirectWithMessage(
        req,
        res,
        'Invalid model ID.'
      );
    }

    try {
      const modelName = await withTransaction(async tx => {
        const model = await tx.get(
          `SELECT model_id, name
             FROM ai_models
            WHERE model_id = ?
              AND user_id = ?`,
          [modelId, userId]
        );

        if (!model) {
          throw new Error(
            'Model not found or you do not have permission to unregister it.'
          );
        }

        // Remove the model from the registered catalog.
        await tx.run(
          `UPDATE ai_models
              SET is_registered = 0,
                  is_public = 0
            WHERE model_id = ?
              AND user_id = ?`,
          [modelId, userId]
        );

        // Deprecate all agents linked to this model.
        // The records remain so the owners can delete them.
        await tx.run(
          `UPDATE ai_agents
              SET is_deprecated = 1,
                  is_public = 0,
                  updated_at = CURRENT_TIMESTAMP
            WHERE model_id = ?`,
          [modelId]
        );

        // Disable deployments associated with the unregistered model.
        await tx.run(
          `UPDATE model_deployments
              SET is_enabled = 0,
                  availability_status = 'unavailable',
                  last_checked_at = CURRENT_TIMESTAMP,
                  last_error = 'Model unregistered from the application catalog.'
            WHERE model_id = ?`,
          [modelId]
        );

        // Keep resource-link records for history but deactivate them.
        await tx.run(
          `UPDATE agent_resource_links
              SET is_enabled = 0
            WHERE agent_id IN (
              SELECT agent_id
                FROM ai_agents
               WHERE model_id = ?
            )`,
          [modelId]
        );

        return model.name;
      });

      return redirectWithMessage(
        req,
        res,
        `Model "${modelName}" was unregistered. Dependent agents are now deprecated.`
      );
    } catch (err) {
      console.error('Model unregistration error:', err);

      return redirectWithMessage(
        req,
        res,
        err.message || 'Could not unregister the model.'
      );
    }
  }
);


// ============================================================
// REGISTER AN OLLAMA MODEL AND CREATE AN AGENT
//
// Creates or reuses a logical model and deployment, then creates
// a new agent. Previously deprecated agents remain deprecated.
// ============================================================

router.post(
  '/register_ollama_model',
  requireUser,
  async (req, res) => {
    const userId = req.session.user.id;

    const modelRef = String(
      req.body.model_ref || ''
    ).trim();

    const agentName = String(
      req.body.name || modelRef
    ).trim();

    const description = String(
      req.body.description || ''
    ).trim();

    const isPublic = req.body.is_public === '1' ? 1 : 0;

    if (!modelRef || !agentName) {
      return redirectWithMessage(
        req,
        res,
        'Choose an installed Ollama model and provide an agent name.'
      );
    }

    if (
      agentName.length > 200 ||
      description.length > 2000
    ) {
      return redirectWithMessage(
        req,
        res,
        'The agent name must be 200 characters or fewer and the description 2,000 characters or fewer.'
      );
    }

    if (modelRef === EMBEDDING_MODEL) {
      return redirectWithMessage(
        req,
        res,
        'The system embedding model cannot be registered as a chat model.'
      );
    }

    try {
      const installedModels = await getOllamaModels();

      const found = installedModels.find(
        model => (model.name || model.model) === modelRef
      );

      if (!found) {
        return redirectWithMessage(
          req,
          res,
          'That model is not installed on the application Ollama server. Pull it first.'
        );
      }

      const { modelId, deployment } =
        await getOrCreateOllamaModelAndDeployment({
          userId,
          modelRef,
          installedModel: found
        });

      const insertedAgent = await sqlRun(
        `INSERT INTO ai_agents (
            model_id,
            name,
            description,
            personality_prompt,
            welcome_message,
            preferred_runtime_location,
            preferred_server_deployment_id,
            allow_fallback_to_server,
            is_public,
            user_id
        )
        VALUES (?, ?, ?, NULL, NULL, 'server', ?, 0, ?, ?)`,
        [
          modelId,
          agentName,
          description || null,
          deployment.deployment_id,
          isPublic,
          userId
        ]
      );

      const message = isPublic
        ? 'Agent created and made public. It uses the registered model; browser-local availability still depends on WebLLM compatibility.'
        : 'Agent created successfully. You can create more agents from the same model.';

      return redirectWithMessage(
        req,
        res,
        message,
        `/models/${insertedAgent.lastID}`
      );
    } catch (err) {
      console.error(
        'Model/agent registration error:',
        err
      );

      return redirectWithMessage(
        req,
        res,
        'Could not register the model and create an agent. Check the Ollama connection and database logs.'
      );
    }
  }
);


// ============================================================
// REGISTER A BROWSER-LOCAL WEBLLM MODEL AND CREATE AN AGENT
//
// Model weights are loaded by the browser, not this server route.
// ============================================================

router.post(
  '/register_webllm_model',
  requireUser,
  async (req, res) => {
    const userId = req.session.user.id;

    const webllmModelId = String(
      req.body.webllm_model_id ||
      req.body.model_ref ||
      ''
    ).trim();

    const modelName = String(
      req.body.model_name || webllmModelId
    ).trim();

    const modelDescription = String(
      req.body.model_description || ''
    ).trim();

    const agentName = String(
      req.body.agent_name ||
      req.body.name ||
      modelName
    ).trim();

    const agentDescription = String(
      req.body.description || ''
    ).trim();

    const personality = String(
      req.body.personality_prompt || ''
    ).trim();

    const welcome = String(
      req.body.welcome_message || ''
    ).trim();

    const isPublic = req.body.is_public === '1' ? 1 : 0;

    if (
      !webllmModelId ||
      webllmModelId.length > 240 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(webllmModelId) ||
      !modelName ||
      !agentName
    ) {
      return redirectWithMessage(
        req,
        res,
        'Provide a valid WebLLM catalog model ID, model name, and agent name.'
      );
    }

    if (
      modelName.length > 200 ||
      modelDescription.length > 2000 ||
      agentName.length > 200 ||
      agentDescription.length > 2000 ||
      personality.length > 12000 ||
      welcome.length > 2000
    ) {
      return redirectWithMessage(
        req,
        res,
        'One or more WebLLM model or agent fields exceed their allowed length.'
      );
    }

    try {
      const modelKey = `webllm:${webllmModelId}`;

      const metadata = JSON.stringify({
        runtimes: {
          webllm: {
            modelId: webllmModelId
          }
        }
      });

      const model = await sqlGet(
        `SELECT *
           FROM ai_models
          WHERE user_id = ?
            AND model_key = ?
          LIMIT 1`,
        [userId, modelKey]
      );

      let modelId;

      if (model) {
        modelId = model.model_id;

        await sqlRun(
          `UPDATE ai_models
              SET name = ?,
                  description = ?,
                  model_format = 'webllm',
                  metadata_json = ?,
                  is_registered = 1
            WHERE model_id = ?
              AND user_id = ?`,
          [
            modelName,
            modelDescription || null,
            metadata,
            modelId,
            userId
          ]
        );
      } else {
        const insertedModel = await sqlRun(
          `INSERT INTO ai_models (
              name,
              model_key,
              description,
              model_format,
              model_origin,
              metadata_json,
              is_registered,
              is_public,
              user_id
           )
           VALUES (?, ?, ?, 'webllm', 'registered', ?, 1, 0, ?)`,
          [
            modelName,
            modelKey,
            modelDescription || null,
            metadata,
            userId
          ]
        );

        modelId = insertedModel.lastID;
      }

      // Always create a fresh agent.
      // Do not reactivate any previously deprecated agents.
      const insertedAgent = await sqlRun(
        `INSERT INTO ai_agents (
            model_id,
            name,
            description,
            personality_prompt,
            welcome_message,
            preferred_runtime_location,
            allow_fallback_to_server,
            is_public,
            user_id
         )
         VALUES (?, ?, ?, ?, ?, 'device_local', 0, ?, ?)`,
        [
          modelId,
          agentName,
          agentDescription || null,
          personality || null,
          welcome || null,
          isPublic,
          userId
        ]
      );

      return redirectWithMessage(
        req,
        res,
        'WebLLM model registered and a new device-local agent was created. The browser will verify model compatibility when you chat.',
        `/models/${insertedAgent.lastID}`
      );
    } catch (err) {
      console.error(
        'WebLLM model registration error:',
        err
      );

      return redirectWithMessage(
        req,
        res,
        'Could not register the WebLLM model. Check the database and model ID.'
      );
    }
  }
);


// ============================================================
// CREATE ANOTHER AGENT FROM AN EXISTING MODEL
// ============================================================

router.post(
  '/agents/create',
  requireUser,
  async (req, res) => {
    const userId = req.session.user.id;

    const modelId = parsePositiveInteger(
      req.body.model_id
    );

    const name = String(
      req.body.name || ''
    ).trim();

    const description = String(
      req.body.description || ''
    ).trim();

    const personality = String(
      req.body.personality_prompt || ''
    ).trim();

    const welcome = String(
      req.body.welcome_message || ''
    ).trim();

    const isPublic = req.body.is_public === '1' ? 1 : 0;

    const preferredRuntime = String(
      req.body.preferred_runtime_location || 'device_local'
    );

    if (!modelId || !name) {
      return redirectWithMessage(
        req,
        res,
        'Choose a model and provide an agent name.'
      );
    }

    if (
      name.length > 200 ||
      description.length > 2000 ||
      personality.length > 12000 ||
      welcome.length > 2000
    ) {
      return redirectWithMessage(
        req,
        res,
        'One or more agent fields exceed their allowed length.'
      );
    }

    if (
      !['device_local', 'server', 'hosted'].includes(
        preferredRuntime
      )
    ) {
      return redirectWithMessage(
        req,
        res,
        'Select a supported runtime location.'
      );
    }

    try {
      // getAccessibleModel excludes unregistered models.
      const model = await getAccessibleModel(
        modelId,
        userId
      );

      if (!model) {
        return redirectWithMessage(
          req,
          res,
          'Model not found, unregistered, or access denied.'
        );
      }

      const inserted = await sqlRun(
        `INSERT INTO ai_agents (
            model_id,
            name,
            description,
            personality_prompt,
            welcome_message,
            preferred_runtime_location,
            allow_fallback_to_server,
            is_public,
            user_id
         )
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [
          modelId,
          name,
          description || null,
          personality || null,
          welcome || null,
          preferredRuntime,
          isPublic,
          userId
        ]
      );

      return redirectWithMessage(
        req,
        res,
        'Agent created successfully.',
        `/models/${inserted.lastID}`
      );
    } catch (err) {
      console.error('Agent creation error:', err);

      return redirectWithMessage(
        req,
        res,
        'Could not create the agent. Check the server logs.'
      );
    }
  }
);


// ============================================================
// QUEUE RESOURCE INDEXING
// ============================================================

router.post(
  '/process_resource',
  requireUser,
  async (req, res) => {
    const userId = req.session.user.id;

    const agentId = parsePositiveInteger(
      req.body.agent_id ?? req.body.ai_id
    );

    const resourceId = parsePositiveInteger(
      req.body.resource_id
    );

    let jobId = null;

    try {
      if (!agentId || !resourceId) {
        throw new Error(
          'Select a valid agent and resource.'
        );
      }

      // The shared helper rejects deprecated agents and agents backed
      // by unregistered models.
      const agent = await getAccessibleAgent(
        agentId,
        userId
      );

      if (!agent) {
        throw new Error(
          'Agent not found, deprecated, unregistered, or access denied.'
        );
      }

      const resource = await getAccessibleResource(
        resourceId,
        userId
      );

      if (!resource) {
        throw new Error(
          'Resource not found or access denied.'
        );
      }

      if (Number(resource.user_id) !== Number(userId)) {
        throw new Error(
          'Only the resource owner can process or re-index this resource.'
        );
      }

      const activeJob = await sqlGet(
        `SELECT processing_job_id
           FROM resource_processing_jobs
          WHERE resource_id = ?
            AND operation = 'index'
            AND status IN ('pending', 'running')
          LIMIT 1`,
        [resourceId]
      );

      if (activeJob) {
        throw new Error(
          'This resource is already queued or being indexed. ' +
          'You can follow its progress in the indexing panel.'
        );
      }

      // Store the agent ID so the worker can validate it again
      // before performing any work.
      const job = await sqlRun(
        `INSERT INTO resource_processing_jobs (
            resource_id,
            requested_by,
            operation,
            status,
            progress_percent,
            processor_config_json
         )
         VALUES (?, ?, 'index', 'pending', 0, ?)`,
        [
          resourceId,
          userId,
          JSON.stringify({ agentId })
        ]
      );

      jobId = job.lastID;

      await sqlRun(
        `UPDATE data_resources
            SET processing_status = 'queued'
          WHERE resource_id = ?
            AND user_id = ?`,
        [resourceId, userId]
      );

      req.session.message =
        `Indexing queued for "${resource.title}". ` +
        'You can navigate to other pages while it processes.';

      return res.redirect('/ai_model');
    } catch (err) {
      console.error(
        'Could not queue resource indexing:',
        err
      );

      if (jobId !== null) {
        try {
          await sqlRun(
            `UPDATE resource_processing_jobs
                SET status = 'failed',
                    completed_at = CURRENT_TIMESTAMP,
                    error_message = ?
              WHERE processing_job_id = ?
                AND status = 'pending'`,
            [
              String(err.message).slice(0, 1000),
              jobId
            ]
          );
        } catch (updateErr) {
          console.error(
            'Could not update failed indexing job:',
            updateErr
          );
        }
      }

      req.session.message =
        `Could not queue resource indexing: ${err.message}`;

      return res.redirect('/ai_model');
    }
  }
);


// ============================================================
// LINK AN ALREADY-INDEXED RESOURCE TO AN AGENT
// ============================================================

router.post(
  '/link_resource',
  requireUser,
  async (req, res) => {
    const userId = req.session.user.id;

    const agentId = parsePositiveInteger(
      req.body.agent_id ?? req.body.ai_id
    );

    const resourceId = parsePositiveInteger(
      req.body.resource_id
    );

    try {
      if (!agentId || !resourceId) {
        throw new Error(
          'Select a valid agent and resource.'
        );
      }

      const agent = await getAccessibleAgent(
        agentId,
        userId
      );

      const resource = await getAccessibleResource(
        resourceId,
        userId
      );

      if (!agent || !resource) {
        throw new Error(
          'Agent or resource not found, deprecated, unregistered, or access denied.'
        );
      }

      if (resource.processing_status !== 'ready') {
        throw new Error(
          'Process the resource before linking it to an agent.'
        );
      }

      await sqlRun(
        `INSERT INTO agent_resource_links (
            agent_id,
            resource_id,
            user_id,
            is_enabled
         )
         VALUES (?, ?, ?, 1)
         ON CONFLICT(agent_id, resource_id, user_id)
         DO UPDATE SET is_enabled = 1`,
        [agentId, resourceId, userId]
      );

      req.session.message =
        'Resource linked to the selected agent.';
    } catch (err) {
      req.session.message =
        `Could not link resource: ${err.message}`;
    }

    return res.redirect('/ai_model');
  }
);


// ============================================================
// AGENT DETAILS
//
// Legacy URL /models/:id is retained.
// The ID now refers to an agent_id.
// Deprecated agents are deliberately not accessible here.
// ============================================================

router.get(
  '/models/:id',
  requireUser,
  async (req, res) => {
    const agentId = parsePositiveInteger(req.params.id);
    const userId = req.session.user.id;

    if (!agentId) {
      return res.status(404).render('errors/404', {
        message: 'Agent not found.'
      });
    }

    try {
      const accessibleAgent = await getAccessibleAgent(
        agentId,
        userId
      );

      if (!accessibleAgent) {
        return res.status(404).render('errors/404', {
          message: 'Agent not found or access denied.'
        });
      }

      const agent = asAgentForLegacyTemplate(
        accessibleAgent
      );

      const isOwner =
        Number(agent.user_id) === Number(userId);

      const deployment = await sqlGet(
        `SELECT mc.provider
           FROM model_deployments md

           JOIN model_connections mc
             ON mc.connection_id = md.connection_id

          WHERE md.model_id = ?
            AND md.is_enabled = 1
            AND mc.is_enabled = 1

          ORDER BY md.deployment_id ASC
          LIMIT 1`,
        [agent.model_id]
      );

      agent.provider = deployment?.provider || 'unknown';

      const availableResources = await sqlAll(
        `SELECT
            dr.resource_id,
            dr.title,
            dr.resource_type,
            dr.is_public,

            CASE
              WHEN arl.link_id IS NULL THEN 0
              ELSE 1
            END AS linked

         FROM data_resources dr

         LEFT JOIN agent_resource_links arl
           ON arl.resource_id = dr.resource_id
          AND arl.agent_id = ?
          AND arl.user_id = ?
          AND arl.is_enabled = 1

         WHERE (dr.user_id = ? OR dr.is_public = 1)
           AND dr.processing_status = 'ready'

         ORDER BY
           CASE WHEN dr.user_id = ? THEN 0 ELSE 1 END,
           dr.title COLLATE NOCASE`,
        [agentId, userId, userId, userId]
      );

      const linkedResources = availableResources.filter(
        resource => Number(resource.linked) === 1
      );

      const message = req.session.message || null;
      req.session.message = null;

      return res.render('model_detail', {
        title: 'Agent Settings',
        model: agent,
        agent,
        isOwner,
        availableResources,
        linkedResources,
        message
      });
    } catch (err) {
      console.error('Agent detail error:', err);

      return res.status(500).render('errors/500', {
        message: 'Could not load agent settings.'
      });
    }
  }
);


// ============================================================
// SAVE AGENT SETTINGS
//
// Deprecated agents and agents backed by unregistered models
// cannot be modified.
// ============================================================

router.post(
  '/models/:id/settings',
  requireUser,
  async (req, res) => {
    const agentId = parsePositiveInteger(req.params.id);
    const userId = req.session.user.id;

    if (!agentId) {
      return res.status(404).send('Agent not found.');
    }

    try {
      const agent = await getAccessibleAgent(
        agentId,
        userId
      );

      if (!agent) {
        return res.status(404).send(
          'Agent not found or access denied.'
        );
      }

      if (Number(agent.user_id) !== Number(userId)) {
        return res.status(403).send(
          'Only the agent owner can change its settings.'
        );
      }

      const name = String(
        req.body.name || ''
      ).trim();

      const description = String(
        req.body.description || ''
      ).trim();

      const personality = String(
        req.body.personality_prompt || ''
      ).trim();

      const welcome = String(
        req.body.welcome_message || ''
      ).trim();

      const isPublic = req.body.is_public === '1' ? 1 : 0;

      const allowedRuntimes = [
        'device_local',
        'server',
        'hosted'
      ];

      const requestedRuntime = String(
        req.body.preferred_runtime_location ||
        agent.preferred_runtime_location
      );

      const preferredRuntime = allowedRuntimes.includes(
        requestedRuntime
      )
        ? requestedRuntime
        : agent.preferred_runtime_location;

      const allowFallback =
        req.body.allow_fallback_to_server === undefined
          ? Number(agent.allow_fallback_to_server || 0)
          : req.body.allow_fallback_to_server === '1'
            ? 1
            : 0;

      if (!name) {
        return redirectWithMessage(
          req,
          res,
          'The agent name is required.',
          `/models/${agentId}`
        );
      }

      if (
        name.length > 200 ||
        description.length > 2000 ||
        personality.length > 12000 ||
        welcome.length > 2000
      ) {
        return redirectWithMessage(
          req,
          res,
          'One or more fields exceed their allowed length.',
          `/models/${agentId}`
        );
      }

      const updateResult = await sqlRun(
        `UPDATE ai_agents
            SET name = ?,
                description = ?,
                is_public = ?,
                personality_prompt = ?,
                welcome_message = ?,
                preferred_runtime_location = ?,
                allow_fallback_to_server = ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE agent_id = ?
            AND user_id = ?
            AND is_deprecated = 0
            AND EXISTS (
              SELECT 1
                FROM ai_models m
               WHERE m.model_id = ai_agents.model_id
                 AND m.is_registered = 1
            )`,
        [
          name,
          description || null,
          isPublic,
          personality || null,
          welcome || null,
          preferredRuntime,
          allowFallback,
          agentId,
          userId
        ]
      );

      if (updateResult.changes !== 1) {
        return redirectWithMessage(
          req,
          res,
          'This agent is deprecated or its model is no longer registered.',
          '/ai_model'
        );
      }

      return redirectWithMessage(
        req,
        res,
        'Agent settings saved successfully.',
        `/models/${agentId}`
      );
    } catch (err) {
      console.error(
        'Agent settings update error:',
        err
      );

      return redirectWithMessage(
        req,
        res,
        'Could not save agent settings. Check the server logs.',
        `/models/${agentId}`
      );
    }
  }
);


// ============================================================
// SAVE RESOURCES LINKED TO AN AGENT
//
// Links are user-specific, even for public agents.
// Deprecated agents cannot have their links changed.
// ============================================================

router.post(
  '/models/:id/resources',
  requireUser,
  async (req, res) => {
    const agentId = parsePositiveInteger(req.params.id);
    const userId = req.session.user.id;

    if (!agentId) {
      return res.status(404).send('Agent not found.');
    }

    const rawIds = req.body.resource_ids;

    const resourceIds = [
      ...new Set(
        (
          Array.isArray(rawIds)
            ? rawIds
            : rawIds
              ? [rawIds]
              : []
        ).map(value => Number(value))
      )
    ];

    if (
      resourceIds.length > 500 ||
      resourceIds.some(
        id => !Number.isInteger(id) || id <= 0
      )
    ) {
      return redirectWithMessage(
        req,
        res,
        'The resource selection is invalid.',
        `/models/${agentId}`
      );
    }

    try {
      const agent = await getAccessibleAgent(
        agentId,
        userId
      );

      if (!agent) {
        return res.status(404).send(
          'Agent not found or access denied.'
        );
      }

      // Validate every resource before replacing existing links.
      for (const resourceId of resourceIds) {
        const resource = await getAccessibleResource(
          resourceId,
          userId
        );

        if (
          !resource ||
          resource.processing_status !== 'ready'
        ) {
          return redirectWithMessage(
            req,
            res,
            'Every selected resource must be ready and accessible to you.',
            `/models/${agentId}`
          );
        }
      }

      await withTransaction(async tx => {
        // Recheck that the agent and its model are still usable
        // within the transaction.
        const currentAgent = await tx.get(
          `SELECT a.agent_id
             FROM ai_agents a
             JOIN ai_models m
               ON m.model_id = a.model_id
            WHERE a.agent_id = ?
              AND (a.user_id = ? OR a.is_public = 1)
              AND a.is_deprecated = 0
              AND m.is_registered = 1`,
          [agentId, userId]
        );

        if (!currentAgent) {
          throw new Error(
            'Agent not found, deprecated, unregistered, or access denied.'
          );
        }

        for (const resourceId of resourceIds) {
          const resource = await tx.get(
            `SELECT resource_id
               FROM data_resources
              WHERE resource_id = ?
                AND (user_id = ? OR is_public = 1)
                AND processing_status = 'ready'`,
            [resourceId, userId]
          );

          if (!resource) {
            throw new Error(
              'Every selected resource must be ready and accessible to you.'
            );
          }
        }

        // Remove the previous selection for this user and agent.
        await tx.run(
          `DELETE FROM agent_resource_links
            WHERE agent_id = ?
              AND user_id = ?`,
          [agentId, userId]
        );

        // Save the new selection.
        for (const resourceId of resourceIds) {
          await tx.run(
            `INSERT INTO agent_resource_links (
                agent_id,
                resource_id,
                user_id,
                is_enabled
            )
            VALUES (?, ?, ?, 1)`,
            [agentId, resourceId, userId]
          );
        }
      });

      return redirectWithMessage(
        req,
        res,
        'Your agent resource links were saved.',
        `/models/${agentId}`
      );
    } catch (err) {
      console.error(
        'Agent resource-link update error:',
        err
      );

      return redirectWithMessage(
        req,
        res,
        'Could not save resource links. Check the server logs.',
        `/models/${agentId}`
      );
    }
  }
);


// ============================================================
// DELETE AN AGENT
//
// Only its owner can delete it.
// Deprecated agents can still be deleted.
// The underlying model is kept.
// ============================================================

router.post(
  '/agents/:id/delete',
  requireUser,
  async (req, res) => {
    const userId = req.session.user.id;
    const agentId = parsePositiveInteger(req.params.id);

    if (!agentId) {
      return redirectWithMessage(
        req,
        res,
        'Invalid agent.',
        '/ai_model'
      );
    }

    try {
      const agent = await sqlGet(
        `SELECT agent_id, model_id, name
           FROM ai_agents
          WHERE agent_id = ?
            AND user_id = ?`,
        [agentId, userId]
      );

      if (!agent) {
        return redirectWithMessage(
          req,
          res,
          'Agent not found or you do not have permission to delete it.',
          '/ai_model'
        );
      }

      const result = await sqlRun(
        `DELETE FROM ai_agents
          WHERE agent_id = ?
            AND user_id = ?`,
        [agentId, userId]
      );

      if (result.changes !== 1) {
        return redirectWithMessage(
          req,
          res,
          'The agent could not be deleted.',
          '/ai_model'
        );
      }

      return redirectWithMessage(
        req,
        res,
        `Agent "${agent.name}" and its conversations were deleted. The underlying model was kept.`,
        '/ai_model'
      );
    } catch (err) {
      console.error('Agent deletion error:', err);

      return redirectWithMessage(
        req,
        res,
        'Could not delete the agent. Check the server logs.',
        '/ai_model'
      );
    }
  }
);

module.exports = router;