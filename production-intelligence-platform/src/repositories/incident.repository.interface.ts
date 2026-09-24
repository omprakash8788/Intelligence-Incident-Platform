import type { Incident, IncidentSeverity, IncidentStatus } from "../domain/incident.js";
import type { PoolClient } from "pg";

export interface CreateIncidentData {
  service: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
}

export interface IncidentRepositoryContract {
  create(data: CreateIncidentData): Promise<Incident>;

  findById(id: string): Promise<Incident | null>;

  createWithClient(
    client: PoolClient,
    data: CreateIncidentData
  ): Promise<Incident>;
}

