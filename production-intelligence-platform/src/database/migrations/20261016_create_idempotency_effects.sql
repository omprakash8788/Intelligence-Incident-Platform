CREATE TABLE IF NOT EXISTS idempotency_effects (
    idempotency_key TEXT PRIMARY KEY,
    payload_hash TEXT NOT NULL,
    result JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS business_effects (
    effect_id UUID PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE
        REFERENCES idempotency_effects(idempotency_key),
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_business_effects_created_at
    ON business_effects (created_at);