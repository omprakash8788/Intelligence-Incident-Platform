import { pool } from "../database/pool.js";
import type {
    Incident,
    IncidentSeverity,
    IncidentStatus
} from "../domain/incident.js";
import type { PoolClient } from "pg";


interface CreateIncidentData {
    service: string;
    severity: IncidentSeverity;
    status: IncidentStatus;
}

export class IncidentRepository {
    async create(
        data: CreateIncidentData
    ): Promise<Incident> {
        const query = `
      INSERT INTO incidents (
        id,
        service,
        severity,
        status
      )
      VALUES (
        gen_random_uuid(),
        $1,
        $2,
        $3
      )
      RETURNING
        id,
        service,
        severity,
        status,
        created_at,
        updated_at
    `;

        const result = await pool.query(query, [
            data.service,
            data.severity,
            data.status
        ]);

        const row = result.rows[0];

        return {
            id: row.id,
            service: row.service,
            severity: row.severity,
            status: row.status,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }

    async findById(
        id: string
    ): Promise<Incident | null> {
        const query = `
    SELECT
      id,
      service,
      severity,
      status,
      created_at,
      updated_at
    FROM incidents
    WHERE id = $1
  `;

        const result = await pool.query(query, [id]);

        if (result.rows.length === 0) {
            return null;
        }

        const row = result.rows[0];

        return {
            id: row.id,
            service: row.service,
            severity: row.severity,
            status: row.status,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }

    async createWithClient(
        client: PoolClient,
        data: CreateIncidentData
    ): Promise<Incident> {
        const query = `
    INSERT INTO incidents (
      id,
      service,
      severity,
      status
    )
    VALUES (
      gen_random_uuid(),
      $1,
      $2,
      $3
    )
    RETURNING
      id,
      service,
      severity,
      status,
      created_at,
      updated_at
  `;

        const result = await client.query(query, [
            data.service,
            data.severity,
            data.status
        ]);

        const row = result.rows[0];

        return {
            id: row.id,
            service: row.service,
            severity: row.severity,
            status: row.status,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }
}

