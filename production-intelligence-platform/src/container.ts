import { IncidentRepository } from "./repositories/incident.repository.js";
import { IncidentEventRepository } from "./repositories/incident-event.repository.js";
import { IncidentService } from "./services/incident.service.js";
import { RedisService } from "./services/redis.service.js";

const incidentRepository =
  new IncidentRepository();

const incidentEventRepository =
  new IncidentEventRepository();


export const incidentService =
  new IncidentService(
    incidentRepository,
    incidentEventRepository
  );

export const redisService =
  new RedisService();