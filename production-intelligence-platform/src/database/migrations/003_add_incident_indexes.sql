CREATE INDEX idx_incidents_service
ON incidents(service);

CREATE INDEX idx_incidents_status
ON incidents(status);

CREATE INDEX idx_incident_events_incident_id
ON incident_events(incident_id);

