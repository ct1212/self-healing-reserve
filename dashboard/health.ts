/**
 * Health monitoring for Chainlink feed, blockchain, and agent systems
 */

import { createPublicClient, http } from 'viem'
import { hardhat, mainnet } from 'viem/chains'
import { ChainlinkAggregator } from '../contracts/abi/ChainlinkAggregator'

interface ComponentHealth {
  healthy: boolean;
  lastCheck: number;
  latency?: number;
  error?: string;
}

interface BlockchainHealth extends ComponentHealth {
  currentBlock?: number;
}

interface AgentHealth extends ComponentHealth {
  lastReport?: number;
  uptime?: number;
}

export interface HealthStatus {
  api: ComponentHealth;
  blockchain: BlockchainHealth;
  agent: AgentHealth;
}

export class HealthMonitor {
  private status: HealthStatus;
  private checkInterval: NodeJS.Timeout | null = null;
  private failureThreshold = 3;
  private failureCounts = {
    api: 0,
    blockchain: 0,
    agent: 0,
  };

  private apiUrl: string;
  private rpcUrl: string;
  private client: ReturnType<typeof createPublicClient>;

  // Chainlink feed health
  private chainlinkFeedAddress: `0x${string}`;
  private chainlinkRpc: string;
  private mainnetClient: ReturnType<typeof createPublicClient>;

  // Track agent reporting
  private agentLastReport: number | null = null;
  private agentStartTime: number | null = null;

  constructor(apiUrl: string, rpcUrl: string, chainlinkFeedAddress?: string, chainlinkRpc?: string) {
    this.apiUrl = apiUrl;
    this.rpcUrl = rpcUrl;
    this.chainlinkFeedAddress = (chainlinkFeedAddress || '0xAd410E655C0fE4741F573152592eeb766e686CE7') as `0x${string}`;
    this.chainlinkRpc = chainlinkRpc || 'https://ethereum-rpc.publicnode.com';

    this.client = createPublicClient({
      chain: hardhat,
      transport: http(rpcUrl),
    });

    this.mainnetClient = createPublicClient({
      chain: mainnet,
      transport: http(this.chainlinkRpc),
    });

    this.status = {
      api: { healthy: false, lastCheck: 0 },
      blockchain: { healthy: false, lastCheck: 0 },
      agent: { healthy: false, lastCheck: 0 },
    };
  }

  start(): void {
    // Initial check
    this.runHealthChecks();

    // Check every 10 seconds
    this.checkInterval = setInterval(() => {
      this.runHealthChecks();
    }, 10000);
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  private async runHealthChecks(): Promise<void> {
    await Promise.all([
      this.checkApiHealth(),
      this.checkBlockchainHealth(),
      this.checkAgentHealth(),
    ]);
  }

  private async checkApiHealth(): Promise<void> {
    const startTime = Date.now();
    try {
      // Check Chainlink feed health by calling latestRoundData
      const roundData = await this.mainnetClient.readContract({
        address: this.chainlinkFeedAddress,
        abi: ChainlinkAggregator,
        functionName: 'latestRoundData',
      });

      const [, answer, , updatedAt] = roundData;
      const latency = Date.now() - startTime;

      // Verify feed is reasonably fresh (< 24h since update)
      const feedAge = Math.floor(Date.now() / 1000) - Number(updatedAt);
      if (feedAge > 86400) {
        throw new Error(`Feed stale (${Math.floor(feedAge / 3600)}h old)`);
      }

      if (answer <= 0n) {
        throw new Error('Feed returned non-positive value');
      }

      this.status.api = {
        healthy: true,
        lastCheck: Date.now(),
        latency,
      };
      this.failureCounts.api = 0;
    } catch (error) {
      this.failureCounts.api++;

      this.status.api = {
        healthy: this.failureCounts.api < this.failureThreshold,
        lastCheck: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async checkBlockchainHealth(): Promise<void> {
    const startTime = Date.now();
    try {
      const blockNumber = await this.client.getBlockNumber();
      const latency = Date.now() - startTime;

      this.status.blockchain = {
        healthy: true,
        lastCheck: Date.now(),
        currentBlock: Number(blockNumber),
        latency,
      };
      this.failureCounts.blockchain = 0;
    } catch (error) {
      this.failureCounts.blockchain++;

      this.status.blockchain = {
        healthy: this.failureCounts.blockchain < this.failureThreshold,
        lastCheck: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async checkAgentHealth(): Promise<void> {
    const now = Date.now();
    const agentTimeout = 60000; // 60 seconds

    if (!this.agentLastReport) {
      // No reports yet - agent not started
      this.status.agent = {
        healthy: false,
        lastCheck: now,
        error: 'No reports received from agent',
      };
      return;
    }

    const timeSinceReport = now - this.agentLastReport;

    if (timeSinceReport > agentTimeout) {
      this.failureCounts.agent++;

      this.status.agent = {
        healthy: this.failureCounts.agent < this.failureThreshold,
        lastCheck: now,
        lastReport: this.agentLastReport,
        error: `No report in ${Math.floor(timeSinceReport / 1000)}s`,
      };
    } else {
      this.failureCounts.agent = 0;

      const uptime = this.agentStartTime ? now - this.agentStartTime : undefined;

      this.status.agent = {
        healthy: true,
        lastCheck: now,
        lastReport: this.agentLastReport,
        uptime,
      };
    }
  }

  recordAgentReport(startTime?: number): void {
    this.agentLastReport = Date.now();

    if (startTime && !this.agentStartTime) {
      this.agentStartTime = startTime;
    }
  }

  getHealth(): HealthStatus {
    return { ...this.status };
  }

  isHealthy(): boolean {
    return this.status.api.healthy &&
           this.status.blockchain.healthy &&
           this.status.agent.healthy;
  }
}
