import {
  describe,
  expect,
  it,
  vi
} from "vitest";

import { IncidentService } from "../src/services/incident.service.js";
import { NotFoundError } from "../src/errors/NotFoundError.js";



describe("IncidentService", () => {

  it("should throw when incident does not exist", async () => {

    const incidentRepository = {
      findById: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      createWithClient: vi.fn()
    };

    const incidentEventRepository = {
      create: vi.fn()
    };

    const service = new IncidentService(
      incidentRepository,
      incidentEventRepository
    );

    await expect(
      service.getIncidentById("incident-123")
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(
      incidentRepository.findById
    ).toHaveBeenCalledWith("incident-123");
  });

});