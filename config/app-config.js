const path = require('path');

// ============================================================
// PROJECT PATHS
// ============================================================

const PROJECT_ROOT = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 3005);

const DB_PATH = path.resolve(
  PROJECT_ROOT,
  process.env.DB_PATH || 'ai_training.sqlite'
);

const RESOURCE_DIR = path.join(
  PROJECT_ROOT,
  'uploads',
  'resources'
);

const MODEL_UPLOAD_DIR = path.join(
  PROJECT_ROOT,
  'uploads',
  'models'
);

const TEMP_UPLOAD_DIR = path.join(
  PROJECT_ROOT,
  'uploads',
  'temp'
);

const STORAGE_DIR = path.join(
  PROJECT_ROOT,
  'storage'
);


// ============================================================
// OLLAMA CONFIGURATION
//
// Keep Ollama as one supported provider.
// Other providers will be configured through the provider
// abstraction and model registry, not hardcoded here.
// ============================================================

const OLLAMA_BASE_URL = String(
  process.env.OLLAMA_BASE_URL ||
  'http://127.0.0.1:11434'
)
  .trim()
  .replace(/\/+$/, '');

const EMBEDDING_MODEL =
  process.env.OLLAMA_EMBEDDING_MODEL ||
  'qwen3-embedding:0.6b';


// ============================================================
// SESSION CONFIGURATION
// ============================================================

const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  process.env.AUTH0_SECRET ||
  '';


// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  PROJECT_ROOT,
  PORT,
  DB_PATH,
  RESOURCE_DIR,
  MODEL_UPLOAD_DIR,
  TEMP_UPLOAD_DIR,
  STORAGE_DIR,
  OLLAMA_BASE_URL,
  EMBEDDING_MODEL,
  SESSION_SECRET
};