const express = require('express');
const fs = require('fs');
const path = require('path');

const requireUser = require('../middleware/requireUser');
const { PROJECT_ROOT } = require('../config/app-config');
const { sqlAll, sqlRun } = require('../db/database');
const { deleteResource, unindexResource } = require('../services/resource.service');

const {
  uploadResource,
  resourceTypeFromFilename,
  storedResourcePath,
  mapResourceForTemplate,
  loadFormData,
  resolveAuthorId,
  resolveSubjectId,
  resolveSourceId
} = require('../services/resource-processing.service');

const {
  getAccessibleResource
} = require('../services/model-registry.service');

const router = express.Router();

/*
|--------------------------------------------------------------------------
| GET /resources
|--------------------------------------------------------------------------
| Display the resource hub and upload form.
*/

router.get('/resources', requireUser, async (req, res, next) => {
  const userId = req.session.user.id;

  const message = req.session.message || null;
  req.session.message = null;

  try {
    const [formData, rows] = await Promise.all([
      loadFormData(),

      sqlAll(
        `SELECT
            dr.*,
            DATE(dr.date_added) AS date_added,
            u.username AS uploader,
            so.source_name,
            so.source_url,

            (
              SELECT group_concat(a.author_name, ', ')
                FROM resource_authors ra
                JOIN authors a
                  ON a.author_id = ra.author_id
               WHERE ra.resource_id = dr.resource_id
            ) AS author_name,

            (
              SELECT group_concat(s.subject_name, ', ')
                FROM resource_subjects rs
                JOIN subjects s
                  ON s.subject_id = rs.subject_id
               WHERE rs.resource_id = dr.resource_id
            ) AS subject_name

         FROM data_resources dr

         JOIN users u
           ON u.user_id = dr.user_id

         LEFT JOIN sources so
           ON so.source_id = dr.source_id

         WHERE dr.user_id = ?
            OR dr.is_public = 1

         ORDER BY
           CASE WHEN dr.user_id = ? THEN 0 ELSE 1 END,
           dr.date_added DESC,
           dr.resource_id DESC`,
        [userId, userId]
      )
    ]);

    const results = rows.map(mapResourceForTemplate);

    return res.render('resources', {
      title: 'Resources',
      results,
      currentUserId: userId,
      message,
      ...formData,
      selectedAuthor: '',
      selectedSubject: '',
      query: ''
    });
  } catch (err) {
    return next(err);
  }
});

/*
|--------------------------------------------------------------------------
| Resource upload handler
|--------------------------------------------------------------------------
| Shared by the legacy PDF upload endpoint and the generalized endpoint.
*/

async function handleResourceUpload(req, res) {
  if (!req.file) {
    req.session.message =
      'Choose a supported resource file (.pdf, .txt, .md, .csv, .json or .jsonl or .docx).';

    return res.redirect('/resources');
  }

  const userId = req.session.user.id;

  const title = String(
    req.body.title ||
      path.basename(
        req.file.originalname,
        path.extname(req.file.originalname)
      )
  ).trim();

  const description = String(
    req.body.description || ''
  ).trim();

  const resourceType = resourceTypeFromFilename(
    req.file.originalname
  );

  const storageUri = path.relative(
    PROJECT_ROOT,
    req.file.path
  ).split(path.sep).join('/');

  const pages = Number.parseInt(req.body.pages, 10);
  const metadata = {};

  if (
    resourceType === 'pdf' &&
    Number.isInteger(pages) &&
    pages >= 0
  ) {
    metadata.pages = pages;
  }

  // Track the inserted row so it can be removed if a later
  // metadata operation fails.
  let insertedResourceId = null;

  try {
    /*
     * Resolve the source metadata.
     */
    const sourceId = await resolveSourceId(
      req.body.source_id,
      req.body.source_name,
      req.body.source_url
    );

    /*
     * Insert the main resource record.
     */
    const resource = await sqlRun(
      `INSERT INTO data_resources
         (
           title,
           description,
           resource_type,
           original_filename,
           mime_type,
           storage_uri,
           file_size_bytes,
           metadata_json,
           is_public,
           user_id,
           source_id,
           processing_status
         )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploaded')`,
      [
        title || req.file.originalname,
        description || null,
        resourceType,
        path.basename(req.file.originalname),
        req.file.mimetype || null,
        storageUri,
        req.file.size,
        Object.keys(metadata).length
          ? JSON.stringify(metadata)
          : null,
        req.body.is_public === '1' ? 1 : 0,
        userId,
        sourceId
      ]
    );

    insertedResourceId = resource.lastID;

    /*
     * Associate an author, if provided.
     */
    const authorId = await resolveAuthorId(
      req.body.author_id,
      req.body.author_name
    );

    if (authorId) {
      await sqlRun(
        `INSERT OR IGNORE INTO resource_authors
           (resource_id, author_id)
         VALUES (?, ?)`,
        [insertedResourceId, authorId]
      );
    }

    /*
     * Associate a subject, if provided.
     */
    const subjectId = await resolveSubjectId(
      req.body.subject_id,
      req.body.subject_name
    );

    if (subjectId) {
      await sqlRun(
        `INSERT OR IGNORE INTO resource_subjects
           (resource_id, subject_id)
         VALUES (?, ?)`,
        [insertedResourceId, subjectId]
      );
    }

    req.session.message =
      `${resourceType.toUpperCase()} resource uploaded. ` +
      'Process it from the AI Model Hub to make it searchable by chat.';

    return res.redirect('/resources');
  } catch (err) {
    console.error('Resource upload error:', err);

    /*
     * Clean up any database records created by this upload.
     * Each deletion is attempted independently so a failure
     * in one cleanup operation does not prevent the others.
     */
    if (insertedResourceId !== null) {
      const cleanupQueries = [
        {
          sql: `DELETE FROM resource_authors
                WHERE resource_id = ?`,
          params: [insertedResourceId]
        },
        {
          sql: `DELETE FROM resource_subjects
                WHERE resource_id = ?`,
          params: [insertedResourceId]
        },
        {
          sql: `DELETE FROM data_resources
                WHERE resource_id = ?
                  AND user_id = ?`,
          params: [insertedResourceId, userId]
        }
      ];

      for (const cleanup of cleanupQueries) {
        try {
          await sqlRun(cleanup.sql, cleanup.params);
        } catch (cleanupErr) {
          console.error(
            'Resource upload cleanup failed:',
            cleanupErr
          );
        }
      }
    }

    /*
     * Remove the uploaded file.
     */
    try {
      await fs.promises.unlink(req.file.path);
    } catch (cleanupErr) {
      if (cleanupErr.code !== 'ENOENT') {
        console.error(
          'Uploaded file cleanup failed:',
          cleanupErr
        );
      }
    }

    req.session.message =
      'Resource upload failed. Check the server console and database schema.';

    return res.redirect('/resources');
  }
}

/*
|--------------------------------------------------------------------------
| POST /upload
|--------------------------------------------------------------------------
| Backwards-compatible endpoint for the older PDF upload form.
*/

router.post(
  '/upload',
  requireUser,
  uploadResource.single('pdf'),
  handleResourceUpload
);

/*
|--------------------------------------------------------------------------
| POST /upload_resource
|--------------------------------------------------------------------------
| Generalized endpoint for PDF, TXT, MD, CSV, JSON and JSONL files.
*/

router.post(
  '/upload_resource',
  requireUser,
  uploadResource.single('resource_file'),
  handleResourceUpload
);

/*
|--------------------------------------------------------------------------
| POST /resources/:id/unindex
|--------------------------------------------------------------------------
| Remove indexed content while preserving the uploaded file and metadata.
*/

router.post(
  '/resources/:id/unindex',
  requireUser,
  async (req, res) => {
    const resourceId = Number(req.params.id);
    const userId = req.session.user.id;

    if (
      !Number.isSafeInteger(resourceId) ||
      resourceId <= 0
    ) {
      req.session.message = 'Invalid resource.';
      return res.redirect('/resources');
    }

    try {
      const result = await unindexResource({
        resourceId,
        userId
      });

      req.session.message =
        `Resource "${result.title}" was unindexed successfully. ` +
        'The uploaded file and metadata have been preserved.';
    } catch (err) {
      console.error('Resource unindexing error:', err);

      if (err.status && err.status < 500) {
        req.session.message = err.message;
      } else {
        req.session.message =
          'Could not unindex the resource. Check the server logs.';
      }
    }

    return res.redirect('/resources');
  }
);

/*
|--------------------------------------------------------------------------
| POST /resources/:id/delete
|--------------------------------------------------------------------------
| Delete a resource owned by the authenticated user.
*/

router.post(
  '/resources/:id/delete',
  requireUser,
  async (req, res) => {
    const resourceId = Number(req.params.id);
    const userId = req.session.user.id;

    if (
      !Number.isSafeInteger(resourceId) ||
      resourceId <= 0
    ) {
      req.session.message = 'Invalid resource.';
      return res.redirect('/resources');
    }

    try {
      const result = await deleteResource({
        resourceId,
        userId
      });

      if (result.warning) {
        console.warn(result.warning);

        req.session.message =
          `Resource "${result.title}" was deleted from the database, ` +
          'but its file could not be removed. Check the server logs.';
      } else {
        req.session.message =
          `Resource "${result.title}" and its indexed data were deleted successfully.`;
      }

      return res.redirect('/resources');
    } catch (err) {
      console.error('Resource deletion error:', err);

      if (err.status && err.status < 500) {
        req.session.message = err.message;
      } else if (
        err.code === 'RESOURCE_DELETE_RESTRICTED'
      ) {
        req.session.message =
          'This resource is still referenced by another record and cannot be deleted.';
      } else {
        req.session.message =
          'Could not delete the resource. Check the server logs.';
      }

      return res.redirect('/resources');
    }
  }
);

/*
|--------------------------------------------------------------------------
| GET /resource/:id/download
|--------------------------------------------------------------------------
| Download a resource only if the user owns it or it is public.
*/

router.get(
  '/resource/:id/download',
  requireUser,
  async (req, res, next) => {
    try {
      const resourceId = Number(req.params.id);

      if (
        !Number.isSafeInteger(resourceId) ||
        resourceId <= 0
      ) {
        return res.status(404).send('Resource not found.');
      }

      const resource = await getAccessibleResource(
        resourceId,
        req.session.user.id
      );

      if (!resource) {
        return res.status(404).send(
          'Resource not found or access denied.'
        );
      }

      const filePath = storedResourcePath(
        resource.storage_uri
      );

      try {
        await fs.promises.access(filePath, fs.constants.R_OK);
      } catch {
        return res.status(404).send(
          'Resource file not found.'
        );
      }

      return res.download(
        filePath,
        resource.original_filename || path.basename(filePath),
        err => {
          if (err) {
            return next(err);
          }
        }
      );
    } catch (err) {
      return next(err);
    }
  }
);

/*
|--------------------------------------------------------------------------
| GET /search
|--------------------------------------------------------------------------
| Search resources accessible to the current user by title,
| author and/or subject.
*/

router.get('/search', requireUser, async (req, res, next) => {
  const userId = req.session.user.id;

  const query = String(
    req.query.query || ''
  ).trim();

  const authorId = String(
    req.query.author_id || ''
  ).trim();

  const subjectId = String(
    req.query.subject_id || ''
  ).trim();

  /*
   * Validate optional metadata filters.
   */
  if (
    authorId &&
    (!/^\d+$/.test(authorId) || Number(authorId) <= 0)
  ) {
    return res.status(400).send('Invalid author filter.');
  }

  if (
    subjectId &&
    (!/^\d+$/.test(subjectId) || Number(subjectId) <= 0)
  ) {
    return res.status(400).send('Invalid subject filter.');
  }

  const params = [userId];

  let sql = `
    SELECT
      dr.*,
      DATE(dr.date_added) AS date_added,
      u.username AS uploader,
      so.source_name,
      so.source_url,

      (
        SELECT group_concat(a.author_name, ', ')
          FROM resource_authors ra
          JOIN authors a
            ON a.author_id = ra.author_id
         WHERE ra.resource_id = dr.resource_id
      ) AS author_name,

      (
        SELECT group_concat(s.subject_name, ', ')
          FROM resource_subjects rs
          JOIN subjects s
            ON s.subject_id = rs.subject_id
         WHERE rs.resource_id = dr.resource_id
      ) AS subject_name

    FROM data_resources dr

    LEFT JOIN users u
      ON u.user_id = dr.user_id

    LEFT JOIN sources so
      ON so.source_id = dr.source_id

    WHERE (
      dr.user_id = ?
      OR dr.is_public = 1
    )
  `;

  /*
   * Filter by title.
   */
  if (query) {
    sql += ` AND dr.title LIKE ?`;
    params.push(`%${query}%`);
  }

  /*
   * Filter by author.
   */
  if (authorId) {
    sql += `
      AND EXISTS (
        SELECT 1
          FROM resource_authors ra
         WHERE ra.resource_id = dr.resource_id
           AND ra.author_id = ?
      )
    `;

    params.push(Number(authorId));
  }

  /*
   * Filter by subject.
   */
  if (subjectId) {
    sql += `
      AND EXISTS (
        SELECT 1
          FROM resource_subjects rs
         WHERE rs.resource_id = dr.resource_id
           AND rs.subject_id = ?
      )
    `;

    params.push(Number(subjectId));
  }

  sql += `
    ORDER BY dr.date_added DESC
  `;

  try {
    const results = (await sqlAll(sql, params))
      .map(mapResourceForTemplate);

    const formData = await loadFormData();

    return res.render('resources', {
      title: 'Resources',
      results,
      currentUserId: userId,
      message: null,
      ...formData,
      selectedAuthor: authorId,
      selectedSubject: subjectId,
      query
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;