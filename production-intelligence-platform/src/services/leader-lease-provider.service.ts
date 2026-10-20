import type {
  LeaderLeaseProviderDependencies,
  LeaseProvider
} from "./leader-lease-provider.types.js";

import type {
  LeaderLeaseService
} from "./leader-lease-provider.types.js";

import type {
  LeaderLeaseProviderConfig
} from "./leader-lease-provider.types.js";

export class LeaderLeaseProvider<Lease>
  implements LeaseProvider<Lease>
{
  private readonly service: LeaderLeaseService<Lease>;
  private readonly config: LeaderLeaseProviderConfig;

  constructor(
    dependencies: LeaderLeaseProviderDependencies<Lease>
  ) {
    this.service = dependencies.service;
    this.config = dependencies.config;

    this.validateConfig(this.config);
  }

  async acquire(): Promise<Lease | null> {
    return this.service.acquireLeadership(
      this.config.electionName,
      this.config.leaderId,
      this.config.leaseMs
    );
  }

  async renew(lease: Lease): Promise<Lease | null> {
    return this.service.renewLeadership(
      lease,
      this.config.leaseMs
    );
  }

  async release(lease: Lease): Promise<boolean> {
    return this.service.releaseLeadership(lease);
  }

  private validateConfig(
    config: LeaderLeaseProviderConfig
  ): void {
    if (
      config.electionName.trim().length === 0
    ) {
      throw new Error(
        "electionName must not be empty"
      );
    }

    if (
      config.leaderId.trim().length === 0
    ) {
      throw new Error(
        "leaderId must not be empty"
      );
    }

    if (
      !Number.isSafeInteger(config.leaseMs) ||
      config.leaseMs <= 0
    ) {
      throw new Error(
        "leaseMs must be a positive safe integer"
      );
    }
  }
}