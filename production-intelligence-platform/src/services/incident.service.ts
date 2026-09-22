import { IncidentRepository } from "../repositories/incident.repository.js";
import type {
    Incident,
    IncidentSeverity
} from "../domain/incident.js";
import { NotFoundError } from "../errors/NotFoundError.js";

interface CreateIncidentInput {
    service: string;
    severity: IncidentSeverity;
}

export class IncidentService {
    constructor(
        private readonly incidentRepository: IncidentRepository
    ) { }

    async createIncident(
        input: CreateIncidentInput
    ): Promise<Incident> {
        const incident =
            await this.incidentRepository.create({
                service: input.service,
                severity: input.severity,
                status: "detected"
            });

        return incident;
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
}

