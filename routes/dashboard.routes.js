'use strict';

const express = require('express');

const requireUser = require('../middleware/requireUser');
const { sqlGet, sqlAll } = require('../db/database');

const router = express.Router();

/*
|--------------------------------------------------------------------------
| GET /dashboard
|--------------------------------------------------------------------------
| Show resource, model, agent, chat, and indexing-job summaries.
*/

router.get('/dashboard', requireUser, async (req, res, next) => {
  const userId = req.session.user.id;

  try {
    const [
      resourceCounts,
      modelCounts,
      agentCounts,
      chatCounts,
      recentResources,
      recentChats,
      recentJobs
    ] = await Promise.all([
      // Count resources accessible to the current user.
      sqlGet(
        `SELECT
           COUNT(*) AS total,
           COALESCE(
             SUM(
               CASE WHEN is_public = 1 THEN 1 ELSE 0 END
             ),
             0
           ) AS public_count
         FROM data_resources
         WHERE user_id = ? OR is_public = 1`,
        [userId]
      ),

      // Count models owned by the user or available publicly.
      sqlGet(
        `SELECT
           COUNT(*) AS total,
           COALESCE(
             SUM(
               CASE WHEN is_public = 1 THEN 1 ELSE 0 END
             ),
             0
           ) AS public_count
         FROM ai_models
         WHERE user_id = ? OR is_public = 1`,
        [userId]
      ),

      // Count agents owned by the user or available publicly.
      sqlGet(
        `SELECT
           COUNT(*) AS total,
           COALESCE(
             SUM(
               CASE WHEN is_public = 1 THEN 1 ELSE 0 END
             ),
             0
           ) AS public_count
         FROM ai_agents
         WHERE user_id = ? OR is_public = 1`,
        [userId]
      ),

      // Count chat sessions belonging to the current user.
      sqlGet(
        `SELECT COUNT(*) AS total
         FROM chat_sessions
         WHERE user_id = ?`,
        [userId]
      ),

      // Most recently added accessible resources.
      sqlAll(
        `SELECT
           dr.resource_id,
           dr.title,
           dr.resource_type,
           dr.processing_status,
           dr.is_public,
           DATE(dr.date_added) AS date_added,
           u.username AS owner_username
         FROM data_resources dr
         JOIN users u
           ON u.user_id = dr.user_id
         WHERE dr.user_id = ? OR dr.is_public = 1
         ORDER BY
           dr.date_added DESC,
           dr.resource_id DESC
         LIMIT 5`,
        [userId]
      ),

      // Most recently updated conversations.
      // Each conversation belongs to an agent, which references a model.
      sqlAll(
        `SELECT
           cs.session_id,
           cs.agent_id,
           cs.agent_id AS ai_id,
           cs.title,
           cs.updated_at,
           cs.runtime_location,
           a.name AS agent_name,
           m.name AS model_name,
           m.model_key
         FROM chat_sessions cs
         JOIN ai_agents a
           ON a.agent_id = cs.agent_id
         JOIN ai_models m
           ON m.model_id = a.model_id
         WHERE cs.user_id = ?
         ORDER BY
           cs.updated_at DESC,
           cs.session_id DESC
         LIMIT 5`,
        [userId]
      ),

      // Recent resource-indexing jobs requested by this user.
      sqlAll(
        `SELECT
           rpj.processing_job_id,
           rpj.operation,
           rpj.status,
           rpj.progress_percent,
           rpj.created_at,
           rpj.started_at,
           dr.title AS resource_title
         FROM resource_processing_jobs rpj
         JOIN data_resources dr
           ON dr.resource_id = rpj.resource_id
         WHERE rpj.requested_by = ?
         ORDER BY rpj.processing_job_id DESC
         LIMIT 5`,
        [userId]
      )
    ]);

    return res.render('dashboard', {
      title: 'Dashboard',
      resourceCounts,
      modelCounts,
      agentCounts,
      chatCounts,
      recentResources,
      recentChats,
      recentJobs
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;