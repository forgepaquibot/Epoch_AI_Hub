const { sqlGet, sqlAll } = require('../db/database');

// ============================================================
// MODELS
// ============================================================

/**
 * Get a model that the user owns or that is public.
 *
 * Models contain model metadata, not agent personalities.
 */
async function getAccessibleModel(modelId, userId) {
  return sqlGet(
    `SELECT
        m.*,
        u.username AS owner_username
     FROM ai_models m
     JOIN users u
       ON u.user_id = m.user_id
     WHERE m.model_id = ?
       AND m.is_registered = 1
       AND (m.user_id = ? OR m.is_public = 1)`,
    [modelId, userId]
  );
}

/**
 * List models that the user owns or that are public.
 */
async function listAccessibleModels(userId) {
  return sqlAll(
    `SELECT
        m.*,
        u.username AS owner_username
     FROM ai_models m
     JOIN users u
       ON u.user_id = m.user_id
     WHERE m.is_registered = 1
       AND (m.user_id = ? OR m.is_public = 1)
     ORDER BY m.name COLLATE NOCASE`,
    [userId]
  );
}


// ============================================================
// AGENTS
// ============================================================

/**
 * Shared query for retrieving agents together with their models.
 *
 * Agent settings, such as personality_prompt and welcome_message,
 * belong to ai_agents rather than ai_models.
 */
const accessibleAgentSelect = `
  SELECT
      a.*,

      au.username AS owner_username,

      m.name AS model_name,
      m.model_key,
      m.description AS model_description,
      m.model_family,
      m.model_format,
      m.model_version,
      m.model_digest,
      m.artifact_uri,
      m.model_origin,
      m.parent_model_id,
      m.training_base_ref,
      m.is_public AS model_is_public,
      m.user_id AS model_owner_id,
      m.metadata_json AS model_metadata_json,

      mu.username AS model_owner_username

  FROM ai_agents a

  JOIN ai_models m
    ON m.model_id = a.model_id

  JOIN users au
    ON au.user_id = a.user_id

  JOIN users mu
    ON mu.user_id = m.user_id
`;

/**
 * Get an agent that the user owns or that is public.
 *
 * A public agent can use its configured model even when the
 * underlying model record is not public. Sharing an agent allows
 * access to the agent, not direct access to the model's artifacts.
 */
async function getAccessibleAgent(agentId, userId) {
  return sqlGet(
    `${accessibleAgentSelect}
     WHERE a.agent_id = ?
       AND (a.user_id = ? OR a.is_public = 1)
       AND a.is_deprecated = 0
       AND m.is_registered = 1`,
    [agentId, userId]
  );
}

/**
 * List agents that the user owns or that are public.
 */
async function listAccessibleAgents(userId) {
  return sqlAll(
    `${accessibleAgentSelect}
     WHERE (a.user_id = ? OR a.is_public = 1)
       AND a.is_deprecated = 0
       AND m.is_registered = 1
     ORDER BY a.name COLLATE NOCASE`,
    [userId]
  );
}


// ============================================================
// RESOURCES
// ============================================================

/**
 * Get a resource that the user owns or that is public.
 *
 * Agent-resource links do not replace resource access checks.
 */
async function getAccessibleResource(resourceId, userId) {
  return sqlGet(
    `SELECT
        dr.*,
        u.username AS owner_username
     FROM data_resources dr
     JOIN users u
       ON u.user_id = dr.user_id
     WHERE dr.resource_id = ?
       AND (dr.user_id = ? OR dr.is_public = 1)`,
    [resourceId, userId]
  );
}


// ============================================================
// SERVER AND HOSTED MODEL DEPLOYMENTS
// ============================================================

/**
 * Get a deployment for a directly accessible model.
 *
 * A connection is usable when it is platform-managed or belongs
 * to the requesting user. Disabled deployments/connections are
 * excluded.
 *
 * The caller must still check live provider/model availability.
 */
async function getAccessibleDeployment(deploymentId, userId) {
  return sqlGet(
    `SELECT
        md.*,

        mc.name AS connection_name,
        mc.provider,
        mc.runtime_location,
        mc.base_url,
        mc.connection_config_json,
        mc.owner_user_id AS connection_owner_id,

        m.name AS model_name,
        m.model_key

     FROM model_deployments md

     JOIN model_connections mc
       ON mc.connection_id = md.connection_id

     JOIN ai_models m
       ON m.model_id = md.model_id

     WHERE md.deployment_id = ?
       AND md.is_enabled = 1
       AND mc.is_enabled = 1
       AND m.is_registered = 1
       AND (mc.owner_user_id IS NULL OR mc.owner_user_id = ?)
       AND (m.user_id = ? OR m.is_public = 1)`,
    [deploymentId, userId, userId]
  );
}

/**
 * Get a deployment specifically for an accessible agent.
 *
 * This allows a public agent to use its configured model without
 * requiring the underlying model record to be public.
 *
 * The deployment must belong to the same model as the agent.
 */
async function getDeploymentForAgent(agentId, deploymentId, userId) {
  return sqlGet(
    `SELECT
        md.*,

        mc.name AS connection_name,
        mc.provider,
        mc.runtime_location,
        mc.base_url,
        mc.connection_config_json,
        mc.owner_user_id AS connection_owner_id,

        m.name AS model_name,
        m.model_key,

        a.name AS agent_name,
        a.user_id AS agent_owner_id

     FROM ai_agents a

     JOIN ai_models m
       ON m.model_id = a.model_id

     JOIN model_deployments md
       ON md.model_id = a.model_id

     JOIN model_connections mc
       ON mc.connection_id = md.connection_id

     WHERE a.agent_id = ?
       AND md.deployment_id = ?
       AND (a.user_id = ? OR a.is_public = 1)
       AND a.is_deprecated = 0
       AND m.is_registered = 1
       AND md.is_enabled = 1
       AND mc.is_enabled = 1
       AND (mc.owner_user_id IS NULL OR mc.owner_user_id = ?)`,
    [agentId, deploymentId, userId, userId]
  );
}


// ============================================================
// DEVICE-LOCAL MODEL INSTALLATIONS
// ============================================================

/**
 * Get a model installation belonging to the requesting user's
 * active device.
 *
 * The caller must verify that the installation status is
 * 'available' and that its runtime supports the requested model.
 */
async function getAccessibleDeviceInstallation(
  installationId,
  userId
) {
  return sqlGet(
    `SELECT
        i.*,

        d.device_name,
        d.runtime_type,
        d.capabilities_json AS device_capabilities_json,

        m.name AS model_name,
        m.model_key

     FROM device_model_installations i

     JOIN user_devices d
       ON d.device_id = i.device_id

     JOIN ai_models m
       ON m.model_id = i.model_id

     WHERE i.installation_id = ?
       AND d.user_id = ?
       AND d.is_active = 1
       AND m.is_registered = 1`,
    [installationId, userId]
  );
}


// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  getAccessibleModel,
  listAccessibleModels,

  getAccessibleAgent,
  listAccessibleAgents,

  getAccessibleResource,

  getAccessibleDeployment,
  getDeploymentForAgent,

  getAccessibleDeviceInstallation
};