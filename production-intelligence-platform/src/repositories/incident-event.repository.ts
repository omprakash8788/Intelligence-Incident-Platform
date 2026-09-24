import type { PoolClient } from "pg";
import type {
  CreateIncidentEventData,
  IncidentEventRepositoryContract
} from "./incident-event.repository.interface.js";

export class IncidentEventRepository
  implements IncidentEventRepositoryContract {

  async create(
    client: PoolClient,
    data: CreateIncidentEventData
  ) {

    const query = `
      INSERT INTO incident_events (
        incident_id,
        event_type
      )
      VALUES ($1, $2)
      RETURNING
        id,
        incident_id,
        event_type,
        created_at
    `;

    const result = await client.query(query, [
      data.incidentId,
      data.eventType
    ]);

    return result.rows[0];
  }
}