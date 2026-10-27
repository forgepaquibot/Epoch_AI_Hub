PRAGMA foreign_keys = ON;

-- ============================================================
-- AI MODEL HUB - SCHEMA V2
--
-- Models and agents are separate.
-- One model can power multiple agents.
-- Device-local inference is the default.
-- Server and hosted runtimes are configurable independently.
-- Model availability must be checked at runtime.
-- Paid server inference is prepared for future plan enforcement.
-- Never store raw provider API keys in this database.
--
-- IMPORTANT: This is a fresh-schema definition, NOT a migration.
-- ============================================================


-- ============================================================
-- 1. USERS AND USER PREFERENCES
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    auth0_sub TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (password_hash IS NOT NULL OR auth0_sub IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS user_preferences (
    user_id INTEGER PRIMARY KEY,

    default_runtime_location TEXT NOT NULL DEFAULT 'device_local'
        CHECK (
            default_runtime_location IN ('device_local', 'server', 'hosted')
        ),

    fallback_policy TEXT NOT NULL DEFAULT 'never'
        CHECK (fallback_policy IN ('never', 'ask')),

    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id)
        REFERENCES users(user_id) ON DELETE CASCADE
);


-- ============================================================
-- 2. SERVICE PLANS AND SUBSCRIPTIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS service_plans (
    plan_id INTEGER PRIMARY KEY,
    plan_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,

    allows_server_inference INTEGER NOT NULL DEFAULT 0
        CHECK (allows_server_inference IN (0, 1)),

    allows_hosted_providers INTEGER NOT NULL DEFAULT 0
        CHECK (allows_hosted_providers IN (0, 1)),

    monthly_server_token_limit INTEGER
        CHECK (
            monthly_server_token_limit IS NULL
            OR monthly_server_token_limit >= 0
        ),

    is_active INTEGER NOT NULL DEFAULT 1
        CHECK (is_active IN (0, 1)),

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO service_plans (
    plan_key,
    name,
    description,
    allows_server_inference,
    allows_hosted_providers,
    monthly_server_token_limit
)
VALUES
    (
        'free',
        'Free',
        'Use compatible models on your own device.',
        0,
        0,
        0
    ),
    (
        'server_basic',
        'Server',
        'Placeholder for future server-hosted inference.',
        1,
        0,
        100000
    ),
    (
        'server_plus',
        'Server Plus',
        'Placeholder for a future higher server inference allowance.',
        1,
        1,
        1000000
    );

CREATE TABLE IF NOT EXISTS user_subscriptions (
    subscription_id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    plan_id INTEGER NOT NULL,

    status TEXT NOT NULL DEFAULT 'active'
        CHECK (
            status IN (
                'trialing',
                'active',
                'past_due',
                'cancelled',
                'expired',
                'incomplete'
            )
        ),

    starts_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ends_at TEXT,

    billing_provider TEXT,
    external_customer_ref TEXT,
    external_subscription_ref TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id)
        REFERENCES users(user_id) ON DELETE CASCADE,

    FOREIGN KEY (plan_id)
        REFERENCES service_plans(plan_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_status
    ON user_subscriptions(user_id, status, ends_at);

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_external_ref
    ON user_subscriptions(billing_provider, external_subscription_ref);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_current_subscription_per_user
    ON user_subscriptions(user_id)
    WHERE status IN ('trialing', 'active');


-- ============================================================
-- 3. RESOURCE METADATA
-- ============================================================

CREATE TABLE IF NOT EXISTS authors (
    author_id INTEGER PRIMARY KEY,
    author_name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS subjects (
    subject_id INTEGER PRIMARY KEY,
    subject_name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS sources (
    source_id INTEGER PRIMARY KEY,
    source_name TEXT,
    source_url TEXT NOT NULL
);


-- ============================================================
-- 4. GENERAL DATA RESOURCES
-- ============================================================

CREATE TABLE IF NOT EXISTS data_resources (
    resource_id INTEGER PRIMARY KEY,

    title TEXT NOT NULL,
    description TEXT,

    resource_type TEXT NOT NULL,
    original_filename TEXT,
    mime_type TEXT,
    storage_uri TEXT NOT NULL,

    file_size_bytes INTEGER
        CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),

    checksum_sha256 TEXT,
    metadata_json TEXT,

    date_added TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    is_public INTEGER NOT NULL DEFAULT 0
        CHECK (is_public IN (0, 1)),

    user_id INTEGER NOT NULL,
    source_id INTEGER,

    processing_status TEXT NOT NULL DEFAULT 'uploaded'
        CHECK (
            processing_status IN (
                'uploaded',
                'queued',
                'processing',
                'ready',
                'failed'
            )
        ),

    FOREIGN KEY (user_id)
        REFERENCES users(user_id) ON DELETE CASCADE,

    FOREIGN KEY (source_id)
        REFERENCES sources(source_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_data_resources_user
    ON data_resources(user_id);

CREATE INDEX IF NOT EXISTS idx_data_resources_public
    ON data_resources(is_public);

CREATE INDEX IF NOT EXISTS idx_data_resources_type
    ON data_resources(resource_type);

CREATE INDEX IF NOT EXISTS idx_data_resources_status
    ON data_resources(processing_status);

CREATE INDEX IF NOT EXISTS idx_data_resources_checksum
    ON data_resources(checksum_sha256);

CREATE TABLE IF NOT EXISTS resource_authors (
    resource_id INTEGER NOT NULL,
    author_id INTEGER NOT NULL,

    PRIMARY KEY (resource_id, author_id),

    FOREIGN KEY (resource_id)
        REFERENCES data_resources(resource_id) ON DELETE CASCADE,

    FOREIGN KEY (author_id)
        REFERENCES authors(author_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS resource_subjects (
    resource_id INTEGER NOT NULL,
    subject_id INTEGER NOT NULL,

    PRIMARY KEY (resource_id, subject_id),

    FOREIGN KEY (resource_id)
        REFERENCES data_resources(resource_id) ON DELETE CASCADE,

    FOREIGN KEY (subject_id)
        REFERENCES subjects(subject_id) ON DELETE CASCADE
);


-- ============================================================
-- 5. MODEL CATALOG
--
-- An ai_models row identifies a logical model, not a specific
-- installation. A model can have multiple agents and deployments.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_models (
    model_id INTEGER PRIMARY KEY,

    name TEXT NOT NULL,
    model_key TEXT NOT NULL,

    description TEXT,
    model_family TEXT,
    model_format TEXT,
    model_version TEXT,
    model_digest TEXT,
    artifact_uri TEXT,
    metadata_json TEXT,

    model_origin TEXT NOT NULL DEFAULT 'registered'
        CHECK (
            model_origin IN ('registered', 'imported', 'fine_tuned')
        ),

    parent_model_id INTEGER,
    training_base_ref TEXT,

    date_created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    is_public INTEGER NOT NULL DEFAULT 0
        CHECK (is_public IN (0, 1)),

    -- 1 = registered in the application catalog
    -- 0 = unregistered; the model record and files are retained
    is_registered INTEGER NOT NULL DEFAULT 1
        CHECK (is_registered IN (0, 1)),

    user_id INTEGER NOT NULL,

    UNIQUE (user_id, model_key),

    FOREIGN KEY (user_id)
        REFERENCES users(user_id) ON DELETE CASCADE,

    FOREIGN KEY (parent_model_id)
        REFERENCES ai_models(model_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_models_user
    ON ai_models(user_id);

CREATE INDEX IF NOT EXISTS idx_ai_models_public
    ON ai_models(is_public);

CREATE INDEX IF NOT EXISTS idx_ai_models_parent
    ON ai_models(parent_model_id);

CREATE INDEX IF NOT EXISTS idx_ai_models_key
    ON ai_models(model_key);


-- ============================================================
-- 6. SERVER AND HOSTED PROVIDER CONNECTIONS
--
-- Supports Ollama and other server runtimes/providers.
--
-- Examples for provider:
--   ollama
--   llamacpp
--   vllm
--   openai_compatible
--   another provider adapter implemented by the application
--
-- NULL owner_user_id means a platform-managed connection.
-- credential_ref references a secret stored securely elsewhere.
-- Never put raw API keys in SQLite.
-- ============================================================

CREATE TABLE IF NOT EXISTS model_connections (
    connection_id INTEGER PRIMARY KEY,

    owner_user_id INTEGER,

    name TEXT NOT NULL,
    provider TEXT NOT NULL,

    runtime_location TEXT NOT NULL
        CHECK (runtime_location IN ('server', 'hosted')),

    base_url TEXT,
    credential_ref TEXT,
    connection_config_json TEXT,

    is_enabled INTEGER NOT NULL DEFAULT 1
        CHECK (is_enabled IN (0, 1)),

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (owner_user_id)
        REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_model_connections_owner
    ON model_connections(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_model_connections_provider_location
    ON model_connections(provider, runtime_location);

CREATE INDEX IF NOT EXISTS idx_model_connections_enabled
    ON model_connections(is_enabled);


-- ============================================================
-- 7. MODEL DEPLOYMENTS
--
-- Maps a logical model to a provider-specific model identifier
-- through a server or hosted connection.
--
-- Availability is cached only. Check the provider at runtime because
-- a model can be removed or a runtime can go offline.
-- ============================================================

CREATE TABLE IF NOT EXISTS model_deployments (
    deployment_id INTEGER PRIMARY KEY,

    model_id INTEGER NOT NULL,
    connection_id INTEGER NOT NULL,

    provider_model_ref TEXT NOT NULL,

    capabilities_json TEXT,
    provider_options_json TEXT,

    availability_status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (
            availability_status IN (
                'unknown',
                'available',
                'missing',
                'unavailable',
                'error'
            )
        ),

    last_checked_at TEXT,
    last_error TEXT,

    is_enabled INTEGER NOT NULL DEFAULT 1
        CHECK (is_enabled IN (0, 1)),

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (connection_id, provider_model_ref),

    FOREIGN KEY (model_id)
        REFERENCES ai_models(model_id) ON DELETE CASCADE,

    FOREIGN KEY (connection_id)
        REFERENCES model_connections(connection_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_model_deployments_model
    ON model_deployments(model_id);

CREATE INDEX IF NOT EXISTS idx_model_deployments_connection
    ON model_deployments(connection_id);

CREATE INDEX IF NOT EXISTS idx_model_deployments_status
    ON model_deployments(availability_status, is_enabled);


-- ============================================================
-- 8. USER DEVICES AND MODEL INSTALLATIONS
--
-- A device record is created when the user enables local inference.
-- device_token_hash should be a hash of a random app-generated token,
-- not a browser fingerprint.
--
-- The status is a cache. Availability must be rechecked before use.
-- ============================================================

CREATE TABLE IF NOT EXISTS user_devices (
    device_id INTEGER PRIMARY KEY,

    user_id INTEGER NOT NULL,

    device_token_hash TEXT NOT NULL UNIQUE,
    device_name TEXT,

    runtime_type TEXT NOT NULL DEFAULT 'browser'
        CHECK (
            runtime_type IN ('browser', 'desktop_companion', 'other')
        ),

    capabilities_json TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT,

    is_active INTEGER NOT NULL DEFAULT 1
        CHECK (is_active IN (0, 1)),

    FOREIGN KEY (user_id)
        REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_devices_user_active
    ON user_devices(user_id, is_active);

CREATE TABLE IF NOT EXISTS device_model_installations (
    installation_id INTEGER PRIMARY KEY,

    device_id INTEGER NOT NULL,
    model_id INTEGER NOT NULL,

    provider TEXT NOT NULL,

    runtime_kind TEXT NOT NULL
        CHECK (
            runtime_kind IN (
                'webllm',
                'ollama_local',
                'llamacpp_local',
                'other'
            )
        ),

    provider_model_ref TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (
            status IN (
                'unknown',
                'checking',
                'available',
                'missing',
                'unsupported',
                'error'
            )
        ),

    last_checked_at TEXT,
    last_error TEXT,
    runtime_details_json TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (device_id, provider, provider_model_ref),

    FOREIGN KEY (device_id)
        REFERENCES user_devices(device_id) ON DELETE CASCADE,

    FOREIGN KEY (model_id)
        REFERENCES ai_models(model_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_device_model_installations_device_status
    ON device_model_installations(device_id, status);

CREATE INDEX IF NOT EXISTS idx_device_model_installations_model
    ON device_model_installations(model_id);


-- ============================================================
-- 9. AGENTS
--
-- An agent holds its own personality and configuration.
-- Multiple agents can reference the same model_id.
-- Device-local inference is the default.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_agents (
    agent_id INTEGER PRIMARY KEY,

    model_id INTEGER NOT NULL,

    name TEXT NOT NULL,
    description TEXT,

    personality_prompt TEXT,
    welcome_message TEXT,

    preferred_runtime_location TEXT NOT NULL DEFAULT 'device_local'
        CHECK (
            preferred_runtime_location IN (
                'device_local', 'server', 'hosted'
            )
        ),

    allow_fallback_to_server INTEGER NOT NULL DEFAULT 0
        CHECK (allow_fallback_to_server IN (0, 1)),

    preferred_server_deployment_id INTEGER,

    date_created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    is_public INTEGER NOT NULL DEFAULT 0
        CHECK (is_public IN (0, 1)),

    is_deprecated INTEGER NOT NULL DEFAULT 0
        CHECK (is_deprecated IN (0, 1)),

    user_id INTEGER NOT NULL,

    FOREIGN KEY (model_id)
        REFERENCES ai_models(model_id) ON DELETE RESTRICT,

    FOREIGN KEY (preferred_server_deployment_id)
        REFERENCES model_deployments(deployment_id) ON DELETE SET NULL,

    FOREIGN KEY (user_id)
        REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_agents_user
    ON ai_agents(user_id);

CREATE INDEX IF NOT EXISTS idx_ai_agents_public
    ON ai_agents(is_public);

CREATE INDEX IF NOT EXISTS idx_ai_agents_model
    ON ai_agents(model_id);

CREATE INDEX IF NOT EXISTS idx_ai_agents_runtime
    ON ai_agents(preferred_runtime_location);


-- ============================================================
-- 10. NORMALIZED RESOURCE ITEMS
-- ============================================================

CREATE TABLE IF NOT EXISTS resource_items (
    item_id INTEGER PRIMARY KEY,

    resource_id INTEGER NOT NULL,
    item_index INTEGER NOT NULL,

    item_type TEXT NOT NULL,
    content_text TEXT,
    structured_json TEXT,
    metadata_json TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (resource_id, item_index),

    FOREIGN KEY (resource_id)
        REFERENCES data_resources(resource_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_resource_items_resource
    ON resource_items(resource_id);

CREATE INDEX IF NOT EXISTS idx_resource_items_type
    ON resource_items(item_type);


-- ============================================================
-- 11. RESOURCE EMBEDDINGS
-- ============================================================

CREATE TABLE IF NOT EXISTS resource_embeddings (
    embedding_id INTEGER PRIMARY KEY,

    item_id INTEGER NOT NULL,
    embedding_model TEXT NOT NULL,

    dimensions INTEGER NOT NULL
        CHECK (dimensions > 0),

    embedding_json TEXT NOT NULL,

    is_imported INTEGER NOT NULL DEFAULT 0
        CHECK (is_imported IN (0, 1)),

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (item_id, embedding_model),

    FOREIGN KEY (item_id)
        REFERENCES resource_items(item_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_resource_embeddings_model
    ON resource_embeddings(embedding_model);


-- ============================================================
-- 12. RESOURCE PROCESSING JOBS
-- ============================================================

CREATE TABLE IF NOT EXISTS resource_processing_jobs (
    processing_job_id INTEGER PRIMARY KEY,

    resource_id INTEGER NOT NULL,
    requested_by INTEGER NOT NULL,

    operation TEXT NOT NULL DEFAULT 'index'
        CHECK (
            operation IN ('extract', 'validate', 'index', 'import_vectors')
        ),

    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (
            status IN ('pending', 'running', 'done', 'failed', 'cancelled')
        ),

    progress_percent INTEGER NOT NULL DEFAULT 0
        CHECK (progress_percent BETWEEN 0 AND 100),

    processor_config_json TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT,
    completed_at TEXT,

    error_message TEXT,

    FOREIGN KEY (resource_id)
        REFERENCES data_resources(resource_id) ON DELETE CASCADE,

    FOREIGN KEY (requested_by)
        REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_resource_jobs_resource
    ON resource_processing_jobs(resource_id);

CREATE INDEX IF NOT EXISTS idx_resource_jobs_user
    ON resource_processing_jobs(requested_by);

CREATE INDEX IF NOT EXISTS idx_resource_jobs_status
    ON resource_processing_jobs(status);


-- ============================================================
-- 13. RESOURCES SELECTED FOR AN AGENT
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_resource_links (
    link_id INTEGER PRIMARY KEY,

    agent_id INTEGER NOT NULL,
    resource_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,

    is_enabled INTEGER NOT NULL DEFAULT 1
        CHECK (is_enabled IN (0, 1)),

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (agent_id, resource_id, user_id),

    FOREIGN KEY (agent_id)
        REFERENCES ai_agents(agent_id) ON DELETE CASCADE,

    FOREIGN KEY (resource_id)
        REFERENCES data_resources(resource_id) ON DELETE CASCADE,

    FOREIGN KEY (user_id)
        REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_resource_links_agent
    ON agent_resource_links(agent_id);

CREATE INDEX IF NOT EXISTS idx_agent_resource_links_resource
    ON agent_resource_links(resource_id);

CREATE INDEX IF NOT EXISTS idx_agent_resource_links_user
    ON agent_resource_links(user_id);


-- ============================================================
-- 14. CHAT HISTORY
--
-- Each session records the agent and runtime route actually selected.
-- The application must verify device, installation, deployment,
-- agent and user ownership before sending any inference request.
-- ============================================================

CREATE TABLE IF NOT EXISTS chat_sessions (
    session_id INTEGER PRIMARY KEY,

    user_id INTEGER NOT NULL,
    agent_id INTEGER NOT NULL,

    runtime_location TEXT NOT NULL DEFAULT 'device_local'
        CHECK (
            runtime_location IN ('device_local', 'server', 'hosted')
        ),

    device_id INTEGER,
    device_model_installation_id INTEGER,
    deployment_id INTEGER,

    resolved_provider TEXT,
    resolved_model_ref TEXT,

    title TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id)
        REFERENCES users(user_id) ON DELETE CASCADE,

    FOREIGN KEY (agent_id)
        REFERENCES ai_agents(agent_id) ON DELETE CASCADE,

    FOREIGN KEY (device_id)
        REFERENCES user_devices(device_id) ON DELETE SET NULL,

    FOREIGN KEY (device_model_installation_id)
        REFERENCES device_model_installations(installation_id) ON DELETE SET NULL,

    FOREIGN KEY (deployment_id)
        REFERENCES model_deployments(deployment_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_updated
    ON chat_sessions(user_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_agent_updated
    ON chat_sessions(agent_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_deployment
    ON chat_sessions(deployment_id);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_device_installation
    ON chat_sessions(device_model_installation_id);

CREATE TABLE IF NOT EXISTS chat_messages (
    message_id INTEGER PRIMARY KEY,

    session_id INTEGER NOT NULL,

    role TEXT NOT NULL
        CHECK (role IN ('system', 'user', 'assistant', 'tool')),

    content TEXT NOT NULL,
    sources_json TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (session_id)
        REFERENCES chat_sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session
    ON chat_messages(session_id, message_id);


-- ============================================================
-- 15. FINE-TUNING DATASETS
-- ============================================================

CREATE TABLE IF NOT EXISTS fine_tuning_datasets (
    dataset_id INTEGER PRIMARY KEY,

    created_by INTEGER NOT NULL,

    name TEXT NOT NULL,
    description TEXT,

    format TEXT NOT NULL DEFAULT 'conversational_jsonl'
        CHECK (
            format IN ('conversational_jsonl', 'prompt_completion_jsonl')
        ),

    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'review', 'ready', 'failed')),

    example_count INTEGER NOT NULL DEFAULT 0
        CHECK (example_count >= 0),

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (created_by)
        REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fine_tuning_datasets_owner
    ON fine_tuning_datasets(created_by);

CREATE INDEX IF NOT EXISTS idx_fine_tuning_datasets_status
    ON fine_tuning_datasets(status);


-- ============================================================
-- 16. FINE-TUNING EXAMPLES
-- ============================================================

CREATE TABLE IF NOT EXISTS fine_tuning_examples (
    example_id INTEGER PRIMARY KEY,

    dataset_id INTEGER NOT NULL,
    source_resource_id INTEGER,

    messages_json TEXT NOT NULL,

    split TEXT NOT NULL DEFAULT 'train'
        CHECK (split IN ('train', 'validation')),

    is_approved INTEGER NOT NULL DEFAULT 0
        CHECK (is_approved IN (0, 1)),

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (dataset_id)
        REFERENCES fine_tuning_datasets(dataset_id) ON DELETE CASCADE,

    FOREIGN KEY (source_resource_id)
        REFERENCES data_resources(resource_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_fine_tuning_examples_dataset
    ON fine_tuning_examples(dataset_id, is_approved, split);

CREATE INDEX IF NOT EXISTS idx_fine_tuning_examples_source
    ON fine_tuning_examples(source_resource_id);


-- ============================================================
-- 17. FINE-TUNING JOBS
-- ============================================================

CREATE TABLE IF NOT EXISTS fine_tuning_jobs (
    fine_tuning_job_id INTEGER PRIMARY KEY,

    base_model_id INTEGER NOT NULL,
    source_agent_id INTEGER,
    created_by INTEGER NOT NULL,

    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (
            status IN (
                'pending',
                'preparing',
                'running',
                'evaluating',
                'completed',
                'failed',
                'cancelled'
            )
        ),

    progress_percent INTEGER NOT NULL DEFAULT 0
        CHECK (progress_percent BETWEEN 0 AND 100),

    training_method TEXT,
    config_json TEXT,

    output_model_name TEXT,

    output_is_public INTEGER NOT NULL DEFAULT 0
        CHECK (output_is_public IN (0, 1)),

    personality_prompt_snapshot TEXT,
    welcome_message_snapshot TEXT,

    output_model_id INTEGER,
    output_artifact_uri TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT,
    completed_at TEXT,

    error_message TEXT,

    FOREIGN KEY (base_model_id)
        REFERENCES ai_models(model_id) ON DELETE RESTRICT,

    FOREIGN KEY (source_agent_id)
        REFERENCES ai_agents(agent_id) ON DELETE SET NULL,

    FOREIGN KEY (created_by)
        REFERENCES users(user_id) ON DELETE CASCADE,

    FOREIGN KEY (output_model_id)
        REFERENCES ai_models(model_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_fine_tuning_jobs_user
    ON fine_tuning_jobs(created_by);

CREATE INDEX IF NOT EXISTS idx_fine_tuning_jobs_status
    ON fine_tuning_jobs(status);

CREATE INDEX IF NOT EXISTS idx_fine_tuning_jobs_base
    ON fine_tuning_jobs(base_model_id);


-- ============================================================
-- 18. RESOURCES USED BY A FINE-TUNING JOB
-- ============================================================

CREATE TABLE IF NOT EXISTS fine_tuning_job_resources (
    fine_tuning_job_id INTEGER NOT NULL,
    resource_id INTEGER NOT NULL,

    role TEXT NOT NULL DEFAULT 'training'
        CHECK (role IN ('training', 'validation')),

    PRIMARY KEY (fine_tuning_job_id, resource_id, role),

    FOREIGN KEY (fine_tuning_job_id)
        REFERENCES fine_tuning_jobs(fine_tuning_job_id) ON DELETE CASCADE,

    FOREIGN KEY (resource_id)
        REFERENCES data_resources(resource_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_fine_tuning_job_resources_resource
    ON fine_tuning_job_resources(resource_id);


-- ============================================================
-- 19. DATASETS USED BY A FINE-TUNING JOB
-- ============================================================

CREATE TABLE IF NOT EXISTS fine_tuning_job_datasets (
    fine_tuning_job_id INTEGER NOT NULL,
    dataset_id INTEGER NOT NULL,

    PRIMARY KEY (fine_tuning_job_id, dataset_id),

    FOREIGN KEY (fine_tuning_job_id)
        REFERENCES fine_tuning_jobs(fine_tuning_job_id) ON DELETE CASCADE,

    FOREIGN KEY (dataset_id)
        REFERENCES fine_tuning_datasets(dataset_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_fine_tuning_job_datasets_dataset
    ON fine_tuning_job_datasets(dataset_id);