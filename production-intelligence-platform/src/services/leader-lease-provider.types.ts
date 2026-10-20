export interface LeaseProvider<Lease> {
  acquire(): Promise<Lease | null>;
  renew(lease: Lease): Promise<Lease | null>;
  release(lease: Lease): Promise<boolean>;
}

export interface LeaderLeaseService<Lease> {
  acquireLeadership(
    electionName: string,
    leaderId: string,
    leaseMs: number
  ): Promise<Lease | null>;

  renewLeadership(
    lease: Lease,
    leaseMs: number
  ): Promise<Lease | null>;

  releaseLeadership(
    lease: Lease
  ): Promise<boolean>;
}

export interface LeaderLeaseProviderConfig {
  electionName: string;
  leaderId: string;
  leaseMs: number;
}

export interface LeaderLeaseProviderDependencies<Lease> {
  service: LeaderLeaseService<Lease>;
  config: LeaderLeaseProviderConfig;
}