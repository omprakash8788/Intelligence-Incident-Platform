import type { PoolClient } from "pg";
import { pool } from "../database/pool.js";
import type { Incident } from "../domain/incident.js";
import type {
  CreateIncidentData,
  IncidentQuery,
  IncidentRepositoryContract
} from "./incident.repository.interface.js";

export class IncidentRepository
  implements IncidentRepositoryContract {

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

    return {
      id: result.rows[0].id,
      service: result.rows[0].service,
      severity: result.rows[0].severity,
      status: result.rows[0].status,
      createdAt: result.rows[0].created_at,
      updatedAt: result.rows[0].updated_at,
      acknowledgedAt:null
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
      updatedAt: row.updated_at,
      acknowledgedAt:row.acknowledged_at
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
      updatedAt: row.updated_at,
      acknowledgedAt:row.acknowledged_at
    };
  }

  async findMany(
    query: IncidentQuery
  ): Promise<Incident[]> {

    const {
      page,
      limit,
      service,
      severity,
      status
    } = query;

    const conditions: string[] = [];
    const values: unknown[] = [];

    let parameterIndex = 1;

    if (service) {
      conditions.push(
        `service = $${parameterIndex}`
      );

      values.push(service);
      parameterIndex++;
    }

    if (severity) {
      conditions.push(
        `severity = $${parameterIndex}`
      );

      values.push(severity);
      parameterIndex++;
    }

    if (status) {
      conditions.push(
        `status = $${parameterIndex}`
      );

      values.push(status);
      parameterIndex++;
    }

    const offset = (page - 1) * limit;

    values.push(limit);
    const limitParameter = parameterIndex++;

    values.push(offset);
    const offsetParameter = parameterIndex++;

    const whereClause =
      conditions.length > 0
        ? `WHERE ${conditions.join(" AND ")}`
        : "";

    const sql = `
    SELECT
      id,
      service,
      severity,
      status,
      created_at,
      updated_at,
      acknowledged_at
    FROM incidents
    ${whereClause}
    ORDER BY created_at DESC, id DESC
    LIMIT $${limitParameter}
    OFFSET $${offsetParameter}
  `;

    const result = await pool.query(
      sql,
      values
    );

    return result.rows.map((row) => ({
      id: row.id,
      service: row.service,
      severity: row.severity,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      acknowledgedAt: row.acknowledged_at
    }));
  }
}