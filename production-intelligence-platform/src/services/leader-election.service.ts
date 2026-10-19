import { pool } from "../database/pool.js";

export interface LeadershipLease {
  electionName: string;
  leaderId: string;
  fencingToken: string;
  leaseExpiresAt: Date;
}

interface LeadershipRow {
  election_name: string;
  leader_id: string;
  fencing_token: string;
  lease_expires_at: Date;
}

export class LeaderElectionService {
  private validateIdentifiers(
    electionName: string,
    leaderId: string
  ): void {
    if (!electionName.trim()) {
      throw new Error("Election name is required");
    }

    if (!leaderId.trim()) {
      throw new Error("Leader ID is required");
    }
  }

  private validateLeaseDuration(
    leaseMs: number
  ): void {
    if (
      !Number.isSafeInteger(leaseMs) ||
      leaseMs < 1000 ||
      leaseMs > 300_000
    ) {
      throw new Error(
        "Lease duration must be between 1000 and 300000 milliseconds"
      );
    }
  }

  private mapLease(
    row: LeadershipRow
  ): LeadershipLease {
    return {
      electionName: row.election_name,
      leaderId: row.leader_id,
      fencingToken: row.fencing_token,
      leaseExpiresAt: row.lease_expires_at
    };
  }

  async acquireLeadership(
    electionName: string,
    leaderId: string,
    leaseMs: number
  ): Promise<LeadershipLease | null> {
    this.validateIdentifiers(electionName, leaderId);
    this.validateLeaseDuration(leaseMs);

    const result = await pool.query<LeadershipRow>(
      `
        INSERT INTO distributed_leader_leases (
          election_name,
          leader_id,
          lease_expires_at,
          fencing_token
        )
        VALUES (
          $1,
          $2,
          clock_timestamp()
            + ($3::double precision * INTERVAL '1 millisecond'),
          1
        )

        ON CONFLICT (election_name)
        DO UPDATE SET
          leader_id = EXCLUDED.leader_id,
          lease_expires_at = clock_timestamp()
            + ($3::double precision * INTERVAL '1 millisecond'),
          fencing_token =
            distributed_leader_leases.fencing_token + 1,
          updated_at = clock_timestamp()

        WHERE
          distributed_leader_leases.lease_expires_at
          <= clock_timestamp()

        RETURNING
          election_name,
          leader_id,
          fencing_token::text AS fencing_token,
          lease_expires_at
      `,
      [electionName, leaderId, leaseMs]
    );

    const row = result.rows[0];

    if (!row) {
      return null;
    }

    return this.mapLease(row);
  }

  async renewLeadership(
    lease: LeadershipLease,
    leaseMs: number
  ): Promise<LeadershipLease | null> {
    this.validateIdentifiers(
      lease.electionName,
      lease.leaderId
    );

    this.validateLeaseDuration(leaseMs);

    const result = await pool.query<LeadershipRow>(
      `
        UPDATE distributed_leader_leases

        SET
          lease_expires_at = clock_timestamp()
            + ($4::double precision * INTERVAL '1 millisecond'),
          updated_at = clock_timestamp()

        WHERE
          election_name = $1
          AND leader_id = $2
          AND fencing_token = $3::bigint
          AND lease_expires_at > clock_timestamp()

        RETURNING
          election_name,
          leader_id,
          fencing_token::text AS fencing_token,
          lease_expires_at
      `,
      [
        lease.electionName,
        lease.leaderId,
        lease.fencingToken,
        leaseMs
      ]
    );

    const row = result.rows[0];

    if (!row) {
      return null;
    }

    return this.mapLease(row);
  }

  async releaseLeadership(
    lease: LeadershipLease
  ): Promise<boolean> {
    this.validateIdentifiers(
      lease.electionName,
      lease.leaderId
    );

    const result = await pool.query(
      `
        UPDATE distributed_leader_leases

        SET
          lease_expires_at = clock_timestamp(),
          updated_at = clock_timestamp()

        WHERE
          election_name = $1
          AND leader_id = $2
          AND fencing_token = $3::bigint
          AND lease_expires_at > clock_timestamp()
      `,
      [
        lease.electionName,
        lease.leaderId,
        lease.fencingToken
      ]
    );

    return result.rowCount === 1;
  }
}

export const leaderElectionService =
  new LeaderElectionService();