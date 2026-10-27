require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const { auth } = require('express-openid-connect');

const {
  PORT,
  PROJECT_ROOT,
  RESOURCE_DIR,
  MODEL_UPLOAD_DIR,
  TEMP_UPLOAD_DIR,
  STORAGE_DIR,
  SESSION_SECRET
} = require('./config/app-config');

const {
  auth0Config,
  isConfigured: auth0Configured
} = require('./config/auth0');

const { db, DB_PATH } = require('./db/database');
const { syncAuth0User } = require('./services/auth0-user.service');

const accountRoutes = require('./routes/account.routes');
const resourceRoutes = require('./routes/resources.routes');
const modelRoutes = require('./routes/models.routes');
const chatRoutes = require('./routes/chat.routes');
const profileRoutes = require('./routes/profile.routes');
const dashboardRoutes = require('./routes/dashboard.routes');

const {
  createTrainingApiRouter,
  createTrainingPageRouter
} = require('./training/routes');

const errorHandler = require('./middleware/errorHandler');

const app = express();

// Warn if the application is not fully configured.
if (!SESSION_SECRET) {
  throw new Error(
    'SESSION_SECRET is required. Set it in your .env file.'
  );
}

if (!auth0Configured) {
  console.warn(
    'Auth0 is not configured. Add AUTH0_DOMAIN, AUTH0_CLIENT_ID, ' +
    'AUTH0_CLIENT_SECRET, AUTH0_SECRET, and APP_BASE_URL to .env.'
  );
}

// Create application-managed directories.
for (const directory of [
  RESOURCE_DIR,
  MODEL_UPLOAD_DIR,
  TEMP_UPLOAD_DIR,
  path.join(STORAGE_DIR, 'extracted_text'),
  path.join(STORAGE_DIR, 'training_outputs')
]) {
  fs.mkdirSync(directory, { recursive: true });
}

app.disable('x-powered-by');

app.set('view engine', 'pug');
app.set('views', path.join(PROJECT_ROOT, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '1mb' }));

// Keep existing flat URLs for browser scripts and stylesheets.
app.use(express.static(path.join(PROJECT_ROOT, 'client')));
app.use(express.static(path.join(PROJECT_ROOT, 'styles')));
app.use(express.static(path.join(PROJECT_ROOT, 'images')));

// Express sessions store flash messages and the local SQLite user ID.
app.use(require('express-session')({
  name: 'ai_model_hub.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true, // Renew cookie with every user response
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 60 * 1000
  }
}));

// Initialize Auth0 only when configuration is present.
if (auth0Configured) {
  app.use(auth(auth0Config));
  app.use(syncAuth0User);
} else {
  app.get('/login', (_req, res) => {
    res.status(503).send(
      'Auth0 is not configured. Update your .env file first.'
    );
  });
}

app.use((req, res, next) => {
  res.locals.currentUser = req.session?.user || null;
  res.locals.currentPath = req.path;
  res.locals.auth0Configured = auth0Configured;

  next();
});

// Mount the application's feature routes.
app.use('/', accountRoutes);
app.use('/', resourceRoutes);
app.use('/', modelRoutes);
app.use('/', chatRoutes);
app.use('/', profileRoutes);
app.use('/', dashboardRoutes);

app.use('/api/training', createTrainingApiRouter());
app.use('/training', createTrainingPageRouter());

// Health check.
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    database: path.basename(DB_PATH),
    auth0Configured
  });
});

// Not-found handler.
app.use((_req, res) => {
  res.status(404).render('errors/404', {
    message: 'The page you requested was not found.'
  });
});

// Centralized error handler must be mounted last.
app.use(errorHandler);

const server = app.listen(PORT, () => {
  console.log(`AI Model Hub listening at http://localhost:${PORT}`);
  console.log(`SQLite database: ${DB_PATH}`);
});

// Close the HTTP server and database cleanly.
function shutdown() {
  server.close(() => {
    db.close(err => {
      if (err) {
        console.error('Error closing SQLite database:', err.message);
      }

      process.exit(err ? 1 : 0);
    });
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = app;