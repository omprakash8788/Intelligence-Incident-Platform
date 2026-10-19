CREATE TABLE IF NOT EXISTS distributed_leader_leases (
    election_name TEXT PRIMARY KEY,

    leader_id TEXT NOT NULL,

    lease_expires_at TIMESTAMPTZ NOT NULL,

    fencing_token BIGINT NOT NULL
        CHECK (fencing_token > 0),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);