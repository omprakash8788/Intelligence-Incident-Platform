import type { Incident, IncidentSeverity, IncidentStatus } from "../domain/incident.js";
import type { PoolClient } from "pg";
import type { PaginatedResult } from "../domain/pagination.js";

export interface CreateIncidentData {
  service: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
}

export interface IncidentQuery {
  page: number;
  limit: number;
  service?: string;
  severity?: IncidentSeverity;
  status?: IncidentStatus;
}

export interface IncidentRepositoryContract {
  create(data: CreateIncidentData): Promise<Incident>;

  findById(id: string): Promise<Incident | null>;

  createWithClient(
    client: PoolClient,
    data: CreateIncidentData
  ): Promise<Incident>;
   
  findMany(
    query: IncidentQuery
  ): Promise<PaginatedResult<Incident>>;

}



