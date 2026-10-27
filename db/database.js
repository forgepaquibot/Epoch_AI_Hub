'use strict';

const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const { DB_PATH } = require('../config/app-config');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let markDatabaseReady;

const ready = new Promise(resolve => {
  markDatabaseReady = resolve;
});

const db = new sqlite3.Database(DB_PATH, err => {
  if (err) {
    console.error('Could not open SQLite database:', err.message);
    process.exit(1);
    return;
  }

  db.run('PRAGMA foreign_keys = ON', pragmaErr => {
    if (pragmaErr) {
      console.error(
        'Could not enable foreign keys:',
        pragmaErr.message
      );

      process.exit(1);
      return;
    }

    db.get('PRAGMA foreign_keys', (verifyErr, row) => {
      if (verifyErr || Number(row?.foreign_keys) !== 1) {
        console.error(
          'SQLite foreign-key enforcement could not be verified:',
          verifyErr?.message || 'Foreign keys are disabled.'
        );

        process.exit(1);
        return;
      }

      console.log('SQLite database ready:', DB_PATH);
      markDatabaseReady();
    });
  });
});

/*
 * All application SQL helper calls use this queue.
 * withTransaction() holds its place in the queue for the entire
 * transaction, so unrelated helper calls cannot enter it.
 */
let operationQueue = Promise.resolve();

function enqueue(operation) {
  const result = operationQueue.then(operation, operation);

  // A failed query must not permanently break the queue.
  operationQueue = result.then(
    () => undefined,
    () => undefined
  );

  return result;
}

/*
 * Raw helpers are used internally by withTransaction().
 * Do not call these directly from routes or services.
 */
function rawGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function rawAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function rawRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);

      resolve({
        lastID: this.lastID,
        changes: this.changes
      });
    });
  });
}

function sqlGet(sql, params = []) {
  return ready.then(() =>
    enqueue(() => rawGet(sql, params))
  );
}

function sqlAll(sql, params = []) {
  return ready.then(() =>
    enqueue(() => rawAll(sql, params))
  );
}

function sqlRun(sql, params = []) {
  return ready.then(() =>
    enqueue(() => rawRun(sql, params))
  );
}

/*
 * Run a transaction with exclusive access to the application
 * SQL-helper queue. Inside the callback, use only tx.get(),
 * tx.all(), and tx.run() — not the global sqlGet/sqlAll/sqlRun.
 */
function withTransaction(callback) {
  if (typeof callback !== 'function') {
    return Promise.reject(
      new TypeError('withTransaction requires a callback.')
    );
  }

  return ready.then(() =>
    enqueue(async () => {
      await rawRun('BEGIN IMMEDIATE TRANSACTION');

      const tx = {
        get: rawGet,
        all: rawAll,
        run: rawRun
      };

      try {
        const result = await callback(tx);

        await rawRun('COMMIT');

        return result;
      } catch (err) {
        try {
          await rawRun('ROLLBACK');
        } catch (rollbackError) {
          console.error(
            'SQLite transaction rollback failed:',
            rollbackError
          );
        }

        throw err;
      }
    })
  );
}

module.exports = {
  db,
  DB_PATH,
  ready,
  sqlGet,
  sqlAll,
  sqlRun,
  withTransaction
};