'use strict';

const fs = require('fs').promises;
const crypto = require('crypto');

const { withTransaction } = require('../db/database');

const {
  storedResourcePath
} = require('./resource-processing.service');

function createError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function validateIds(resourceId, userId) {
  const id = Number(resourceId);
  const ownerId = Number(userId);

  if (
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    !Number.isSafeInteger(ownerId) ||
    ownerId <= 0
  ) {
    throw createError(
      'A valid resource and authenticated user are required.',
      400,
      'INVALID_RESOURCE'
    );
  }

  return { id, ownerId };
}

function isSqliteConstraintError(err) {
  return (
    String(err.code || '').includes('SQLITE_CONSTRAINT') ||
    String(err.message || '').includes('SQLITE_CONSTRAINT') ||
    String(err.message || '').toLowerCase().includes('foreign key')
  );
}

async function getOwnedResource(tx, resourceId, userId) {
  const resource = await tx.get(
    `SELECT
        resource_id,
        title,
        storage_uri,
        user_id,
        processing_status
       FROM data_resources
      WHERE resource_id = ?
        AND user_id = ?`,
    [resourceId, userId]
  );

  if (!resource) {
    throw createError(
      'Resource not found or access denied.',
      404,
      'RESOURCE_NOT_FOUND'
    );
  }

  return resource;
}

async function getTrainingReference(tx, resourceId) {
  return tx.get(
    `SELECT
        fjr.fine_tuning_job_id,
        ftj.status
       FROM fine_tuning_job_resources fjr
       JOIN fine_tuning_jobs ftj
         ON ftj.fine_tuning_job_id = fjr.fine_tuning_job_id
      WHERE fjr.resource_id = ?
      LIMIT 1`,
    [resourceId]
  );
}

/**
 * Remove indexed content while preserving the uploaded file and metadata.
 */
async function unindexResource({ resourceId, userId }) {
  const { id, ownerId } = validateIds(resourceId, userId);

  try {
    return await withTransaction(async tx => {
      const resource = await getOwnedResource(tx, id, ownerId);

      // Cancel active jobs before clearing indexed content.
      await tx.run(
        `UPDATE resource_processing_jobs
            SET status = 'cancelled',
                completed_at = CURRENT_TIMESTAMP,
                error_message =
                  'Cancelled because the resource was unindexed.'
          WHERE resource_id = ?
            AND status IN ('pending', 'running')`,
        [id]
      );

      await tx.run(
        `DELETE FROM resource_embeddings
          WHERE item_id IN (
            SELECT item_id
              FROM resource_items
             WHERE resource_id = ?
          )`,
        [id]
      );

      await tx.run(
        'DELETE FROM resource_items WHERE resource_id = ?',
        [id]
      );

      await tx.run(
        `UPDATE agent_resource_links
            SET is_enabled = 0
          WHERE resource_id = ?`,
        [id]
      );

      const updated = await tx.run(
        `UPDATE data_resources
            SET processing_status = 'uploaded'
          WHERE resource_id = ?
            AND user_id = ?`,
        [id, ownerId]
      );

      if (updated.changes !== 1) {
        throw createError(
          'The resource could not be unindexed.',
          404,
          'RESOURCE_NOT_FOUND'
        );
      }

      return {
        resourceId: id,
        title: resource.title
      };
    });
  } catch (err) {
    if (err.status) throw err;

    if (isSqliteConstraintError(err)) {
      throw createError(
        'Related records prevent this resource from being unindexed.',
        409,
        'RESOURCE_UNINDEX_RESTRICTED'
      );
    }

    throw err;
  }
}

/**
 * Delete a resource, cancelling indexing jobs and removing associated data.
 * Stage the file while the DB transaction is held; restore it on failure.
 */
async function deleteResource({ resourceId, userId }) {
  const { id, ownerId } = validateIds(resourceId, userId);

  let filePath = null;
  let stagedPath = null;
  let fileWasStaged = false;

  let deletedResource;

  try {
    deletedResource = await withTransaction(async tx => {
      const resource = await getOwnedResource(tx, id, ownerId);

      const trainingReference = await getTrainingReference(tx, id);

      if (trainingReference) {
        throw createError(
          `This resource is referenced by fine-tuning job ${trainingReference.fine_tuning_job_id}. Remove it from that job before deleting the resource.`,
          409,
          'RESOURCE_USED_BY_TRAINING_JOB'
        );
      }

      // Validate the path before changing database records or the file.
      filePath = storedResourcePath(resource.storage_uri);
      stagedPath = `${filePath}.delete-${crypto.randomUUID()}`;

      await tx.run(
        `UPDATE resource_processing_jobs
            SET status = 'cancelled',
                completed_at = CURRENT_TIMESTAMP,
                error_message =
                  'Cancelled because the resource was deleted.'
          WHERE resource_id = ?
            AND status IN ('pending', 'running')`,
        [id]
      );

      await tx.run(
        `DELETE FROM resource_embeddings
          WHERE item_id IN (
            SELECT item_id
              FROM resource_items
             WHERE resource_id = ?
          )`,
        [id]
      );

      await tx.run(
        'DELETE FROM resource_items WHERE resource_id = ?',
        [id]
      );

      await tx.run(
        'DELETE FROM agent_resource_links WHERE resource_id = ?',
        [id]
      );

      await tx.run(
        'DELETE FROM resource_authors WHERE resource_id = ?',
        [id]
      );

      await tx.run(
        'DELETE FROM resource_subjects WHERE resource_id = ?',
        [id]
      );

      /*
       * This file operation cannot be rolled back by SQLite.
       * The outer catch restores the original name if the transaction
       * fails after this point.
       */
      try {
        await fs.rename(filePath, stagedPath);
        fileWasStaged = true;
      } catch (err) {
        if (err.code !== 'ENOENT') {
          throw err;
        }
      }

      const result = await tx.run(
        `DELETE FROM data_resources
          WHERE resource_id = ?
            AND user_id = ?`,
        [id, ownerId]
      );

      if (result.changes !== 1) {
        throw createError(
          'The resource was not deleted. It may already have been removed.',
          404,
          'RESOURCE_NOT_FOUND'
        );
      }

      return {
        resourceId: id,
        title: resource.title
      };
    });
  } catch (err) {
    if (fileWasStaged) {
      try {
        await fs.rename(stagedPath, filePath);
        fileWasStaged = false;
      } catch (restoreError) {
        console.error(
          `Could not restore the uploaded file for resource ${id}:`,
          restoreError
        );

        throw createError(
          'Database deletion failed and the uploaded file could not be restored automatically. Check the server logs.',
          500,
          'RESOURCE_DELETE_RESTORE_FAILED'
        );
      }
    }

    if (err.status) throw err;

    if (isSqliteConstraintError(err)) {
      throw createError(
        'The resource is still referenced by another record and cannot be deleted yet.',
        409,
        'RESOURCE_DELETE_RESTRICTED'
      );
    }

    throw err;
  }

  // The transaction committed. Now permanently remove the staged file.
  let warning = null;

  if (fileWasStaged) {
    try {
      await fs.unlink(stagedPath);
      fileWasStaged = false;
    } catch (err) {
      warning =
        'The database record was deleted, but the staged file could not be removed. Check the server logs.';

      console.error(
        `Resource ${id} was deleted from SQLite, but its staged file remains:`,
        err
      );
    }
  }

  return {
    ...deletedResource,
    fileDeleted: !warning,
    warning
  };
}

module.exports = {
  unindexResource,
  deleteResource
};