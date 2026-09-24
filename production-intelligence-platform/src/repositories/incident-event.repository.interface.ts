import type { PoolClient } from "pg";

export interface CreateIncidentEventData {
  incidentId: string;
  eventType: string;
}

export interface IncidentEventRepositoryContract {
  create(
    client: PoolClient,
    data: CreateIncidentEventData
  ): Promise<unknown>;
}

