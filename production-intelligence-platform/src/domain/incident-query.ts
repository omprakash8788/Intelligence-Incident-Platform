import type { IncidentSeverity, IncidentStatus } from "./incident.js";

export interface IncidentQuery {
  page: number;
  limit: number;
  service?: string;
  severity?: IncidentSeverity;
  status?: IncidentStatus;
}

