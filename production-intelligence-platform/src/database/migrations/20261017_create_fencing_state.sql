CREATE TABLE IF NOT EXISTS lock_fencing_state (
    resource_key TEXT PRIMARY KEY,

    last_token BIGINT NOT NULL
        CHECK (last_token > 0),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fenced_resource_state (
    resource_key TEXT PRIMARY KEY,

    last_fencing_token BIGINT NOT NULL DEFAULT 0
        CHECK (last_fencing_token >= 0),

    last_operation_id TEXT NOT NULL,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);