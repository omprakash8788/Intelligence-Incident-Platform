CREATE TABLE transactional_outbox (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    event_id UUID NOT NULL UNIQUE,

    event_type TEXT NOT NULL,

    payload JSONB NOT NULL,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT clock_timestamp(),

    published_at TIMESTAMPTZ NULL,

    locked_until TIMESTAMPTZ NULL,

    locked_by TEXT NULL,

    attempts INTEGER NOT NULL DEFAULT 0
        CHECK (attempts >= 0),

    last_error TEXT NULL
);

CREATE INDEX transactional_outbox_pending_idx
ON transactional_outbox (id)
WHERE published_at IS NULL;