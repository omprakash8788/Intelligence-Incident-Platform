ALTER TABLE incidents
ADD CONSTRAINT incidents_severity_check
CHECK (
    severity IN (
        'low',
        'medium',
        'high',
        'critical'
    )
);

ALTER TABLE incidents
ADD CONSTRAINT incidents_status_check
CHECK (
    status IN (
        'detected',
        'investigating',
        'acknowledged',
        'mitigating',
        'resolved',
        'closed'
    )
);