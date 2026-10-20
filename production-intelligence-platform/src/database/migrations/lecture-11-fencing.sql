CREATE TABLE IF NOT EXISTS lecture11_fenced_resources (
    resource_id TEXT PRIMARY KEY,
    highest_token BIGINT NOT NULL
        CHECK (highest_token > 0),
    value TEXT NOT NULL
);