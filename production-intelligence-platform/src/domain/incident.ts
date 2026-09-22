export type IncidentSeverity =
  | "low"
  | "medium"
  | "high"
  | "critical";

export type IncidentStatus =
  | "detected"
  | "investigating"
  | "acknowledged"
  | "mitigating"
  | "resolved"
  | "closed";

export interface Incident {
  id: string;
  service: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  createdAt: Date;
  updatedAt: Date;
}