'use strict';

const { sqlGet, sqlRun } = require('../db/database');

const {
  createResourceItems,
  saveResourceIndex
} = require('./resource-processing.service');

const {
  getAccessibleAgent
} = require('./model-registry.service');

let workerStarted = false;
let workerRunning = false;

const POLL_INTERVAL_MS = 1500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createCancelledError() {
  const error = new Error(
    'The indexing job was cancelled or the resource was removed.'
  );

  error.code = 'RESOURCE_INDEX_CANCELLED';
  return error;
}

function createInactiveAgentError() {
  const error = new Error(
    'The selected agent is deprecated, its model is unregistered, ' +
    'or the agent is no longer accessible. The indexing job cannot continue.'
  );

  error.code = 'AGENT_NOT_ACTIVE';
  return error;
}

/**
 * Check whether an agent is still available for normal use.
 *
 * This relies on getAccessibleAgent() excluding deprecated agents
 * and agents whose underlying model is no longer registered.
 */
async function assertAgentIsActive(agentId, userId) {
  const agent = await getAccessibleAgent(agentId, userId);

  if (!agent) {
    throw createInactiveAgentError();
  }

  return agent;
}

/*
 * Recover interrupted indexing jobs after a server restart.
 * Only indexing jobs are handled by this worker.
 */
async function recoverInterruptedJobs() {
  await sqlRun(
    `UPDATE resource_processing_jobs
        SET status = 'pending',
            progress_percent = 0,
            started_at = NULL,
            completed_at = NULL,
            error_message = NULL
      WHERE status = 'running'
        AND operation = 'index'`
  );

  await sqlRun(
    `UPDATE data_resources
        SET processing_status = 'queued'
      WHERE EXISTS (
        SELECT 1
          FROM resource_processing_jobs j
         WHERE j.resource_id = data_resources.resource_id
           AND j.operation = 'index'
           AND j.status IN ('pending', 'running')
      )`
  );

  // Repair resources left in "processing" without an active job.
  await sqlRun(
    `UPDATE data_resources
        SET processing_status =
          CASE
            WHEN EXISTS (
              SELECT 1
                FROM resource_items ri
               WHERE ri.resource_id = data_resources.resource_id
            )
            THEN 'ready'
            ELSE 'uploaded'
          END
      WHERE processing_status = 'processing'
        AND NOT EXISTS (
          SELECT 1
            FROM resource_processing_jobs j
           WHERE j.resource_id = data_resources.resource_id
             AND j.operation = 'index'
             AND j.status IN ('pending', 'running')
        )`
  );
}

async function getNextPendingJob() {
  return sqlGet(
    `SELECT
        processing_job_id,
        resource_id,
        requested_by,
        operation,
        processor_config_json
       FROM resource_processing_jobs
      WHERE status = 'pending'
        AND operation = 'index'
      ORDER BY created_at ASC, processing_job_id ASC
      LIMIT 1`
  );
}

async function updateJobProgress(jobId, progress) {
  await sqlRun(
    `UPDATE resource_processing_jobs
        SET progress_percent = ?
      WHERE processing_job_id = ?
        AND status = 'running'`,
    [progress, jobId]
  );
}

async function processJob(job) {
  const jobId = Number(job.processing_job_id);
  const resourceId = Number(job.resource_id);
  const userId = Number(job.requested_by);

  let config;

  try {
    config = JSON.parse(job.processor_config_json || '{}');
  } catch {
    throw new Error(
      'The indexing job configuration is invalid.'
    );
  }

  const agentId = Number(config.agentId);

  if (!Number.isSafeInteger(agentId) || agentId <= 0) {
    throw new Error(
      'The indexing job has no valid agent ID.'
    );
  }

  // ----------------------------------------------------------
  // 1. Check agent availability before doing any indexing work.
  // ----------------------------------------------------------

  await assertAgentIsActive(agentId, userId);

  const resource = await sqlGet(
    `SELECT *
       FROM data_resources
      WHERE resource_id = ?
        AND user_id = ?`,
    [resourceId, userId]
  );

  if (!resource) {
    throw new Error(
      'The resource no longer exists or is not owned by the requester.'
    );
  }

  // ----------------------------------------------------------
  // 2. Mark the resource as processing only if this job is
  //    still running. Do not revive a cancelled job.
  // ----------------------------------------------------------

  const processingUpdate = await sqlRun(
    `UPDATE data_resources
        SET processing_status = 'processing'
      WHERE resource_id = ?
        AND user_id = ?
        AND EXISTS (
          SELECT 1
            FROM resource_processing_jobs j
           WHERE j.processing_job_id = ?
             AND j.resource_id = ?
             AND j.status = 'running'
        )`,
    [resourceId, userId, jobId, resourceId]
  );

  if (processingUpdate.changes !== 1) {
    throw createCancelledError();
  }

  await updateJobProgress(jobId, 10);

  // ----------------------------------------------------------
  // 3. Extract and normalize the resource.
  // ----------------------------------------------------------

  const items = await createResourceItems(resource);

  await updateJobProgress(jobId, 35);

  // ----------------------------------------------------------
  // 4. Recheck the agent after extraction.
  //
  // Unregistration may have happened while extraction was running.
  // If the agent is no longer active, do not save the index.
  // ----------------------------------------------------------

  await assertAgentIsActive(agentId, userId);

  // Check that the job was not cancelled while extraction ran.
  const currentJob = await sqlGet(
    `SELECT processing_job_id
       FROM resource_processing_jobs
      WHERE processing_job_id = ?
        AND resource_id = ?
        AND status = 'running'
        AND operation = 'index'`,
    [jobId, resourceId]
  );

  if (!currentJob) {
    throw createCancelledError();
  }

  // ----------------------------------------------------------
  // 5. Save the resource index.
  //
  // saveResourceIndex must also validate the job and agent state
  // inside its write transaction to protect against unregistration
  // happening between the check above and the actual database write.
  // ----------------------------------------------------------

  await saveResourceIndex(resource, items, {
    processingJobId: jobId,
    agentId,
    userId,
    onProgress: progress => updateJobProgress(jobId, progress)
  });
}

async function runOneJob() {
  const job = await getNextPendingJob();

  if (!job) {
    return false;
  }

  // Claim only if the job remains pending.
  const claimed = await sqlRun(
    `UPDATE resource_processing_jobs
        SET status = 'running',
            progress_percent = 1,
            started_at = CURRENT_TIMESTAMP,
            completed_at = NULL,
            error_message = NULL
      WHERE processing_job_id = ?
        AND operation = 'index'
        AND status = 'pending'`,
    [job.processing_job_id]
  );

  if (claimed.changes !== 1) {
    return true;
  }

  try {
    await processJob(job);
  } catch (err) {
    if (err.code === 'RESOURCE_INDEX_CANCELLED') {
      // Cancellation is expected; do not turn it into a failure.
      return true;
    }

    const message = String(
      err?.message || 'Unknown indexing error'
    ).slice(0, 1000);

    console.error(
      `Resource indexing job ${job.processing_job_id} failed:`,
      err
    );

    try {
      // Only a still-running job may become failed.
      // If another operation changed its status, leave it unchanged.
      const failed = await sqlRun(
        `UPDATE resource_processing_jobs
            SET status = 'failed',
                completed_at = CURRENT_TIMESTAMP,
                error_message = ?
          WHERE processing_job_id = ?
            AND status = 'running'`,
        [message, job.processing_job_id]
      );

      if (failed.changes === 1) {
        await sqlRun(
          `UPDATE data_resources
              SET processing_status = 'failed'
            WHERE resource_id = ?
              AND user_id = ?
              AND processing_status IN ('queued', 'processing')
              AND NOT EXISTS (
                SELECT 1
                  FROM resource_processing_jobs j
                 WHERE j.resource_id = data_resources.resource_id
                   AND j.status IN ('pending', 'running')
              )`,
          [job.resource_id, job.requested_by]
        );
      }
    } catch (updateError) {
      console.error(
        'Could not record the indexing failure:',
        updateError
      );
    }
  }

  return true;
}

async function workerLoop() {
  if (workerRunning) {
    return;
  }

  workerRunning = true;

  try {
    while (workerStarted) {
      try {
        const processedJob = await runOneJob();

        if (!processedJob) {
          await sleep(POLL_INTERVAL_MS);
        }
      } catch (err) {
        console.error(
          'Resource indexing worker error:',
          err
        );

        await sleep(POLL_INTERVAL_MS);
      }
    }
  } finally {
    workerRunning = false;

    // Restart the loop if a future change stops and restarts it.
    if (workerStarted) {
      void workerLoop();
    }
  }
}

async function startResourceIndexingWorker() {
  if (workerStarted) {
    return;
  }

  // Keep this false until recovery finishes.
  try {
    await recoverInterruptedJobs();
  } catch (err) {
    console.error(
      'Could not recover interrupted indexing jobs:',
      err
    );
  }

  workerStarted = true;
  void workerLoop();
}

module.exports = {
  startResourceIndexingWorker
};