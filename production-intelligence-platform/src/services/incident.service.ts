import type {
  Incident,
  IncidentSeverity
} from "../domain/incident.js";

import { NotFoundError } from "../errors/NotFoundError.js";
import { withTransaction } from "../database/transaction.js";

import type {
  IncidentRepositoryContract
} from "../repositories/incident.repository.interface.js";

import type {
  IncidentEventRepositoryContract
} from "../repositories/incident-event.repository.interface.js";

interface CreateIncidentInput {
  service: string;
  severity: IncidentSeverity;
}

export class IncidentService {

  constructor(
    private readonly incidentRepository: IncidentRepositoryContract,
    private readonly incidentEventRepository: IncidentEventRepositoryContract
  ) {}

  async createIncident(
    input: CreateIncidentInput
  ): Promise<Incident> {

    return this.incidentRepository.create({
      service: input.service,
      severity: input.severity,
      status: "detected"
    });
  }

  async getIncidentById(
    id: string
  ): Promise<Incident> {

    const incident =
      await this.incidentRepository.findById(id);

    if (!incident) {
      throw new NotFoundError(
        "Incident not found",
        "INCIDENT_NOT_FOUND"
      );
    }

    return incident;
  }

  async createIncidentWithEvent(
    input: CreateIncidentInput
  ): Promise<Incident> {

    return withTransaction(async (client) => {

      const incident =
        await this.incidentRepository.createWithClient(
          client,
          {
            service: input.service,
            severity: input.severity,
            status: "detected"
          }
        );

      await this.incidentEventRepository.create(
        client,
        {
          incidentId: incident.id,
          eventType: "INCIDENT_CREATED"
        }
      );

      return incident;
    });
  }
}

