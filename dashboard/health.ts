/**
 * Health monitoring for API, blockchain, and agent systems
 */

import { createPublicClient, http } from 'viem'
import { hardhat } from 'viem/chains'

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

  // Track agent reporting
  private agentLastReport: number | null = null;
  private agentStartTime: number | null = null;

  constructor(apiUrl: string, rpcUrl: string) {
    this.apiUrl = apiUrl;
    this.rpcUrl = rpcUrl;

    this.client = createPublicClient({
      chain: hardhat,
      transport: http(rpcUrl),
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
      const response = await fetch(`${this.apiUrl}/reserves`, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();
      if (typeof data !== 'object' || !('totalReserve' in data) || !('totalLiabilities' in data)) {
        throw new Error('Invalid API response format');
      }

      const latency = Date.now() - startTime;

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
