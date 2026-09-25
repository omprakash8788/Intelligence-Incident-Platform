ALTER TABLE incident_events
ADD CONSTRAINT incident_events_event_type_check
CHECK (
    event_type IN (
        'INCIDENT_CREATED',
        'INCIDENT_ACKNOWLEDGED',
        'INCIDENT_STATUS_CHANGED',
        'INCIDENT_RESOLVED',
        'INCIDENT_CLOSED'
    )
);