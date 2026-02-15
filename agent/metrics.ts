/**
 * Metrics tracking for agent recovery operations
 */

export interface RecoveryMetrics {
  totalRecoveries: number;
  successfulRecoveries: number;
  failedRecoveries: number;
  totalResponseTimeMs: number;
  errors: Array<{
    timestamp: number;
    step: string;
    error: string;
    context?: unknown;
  }>;
  startTime: number;
}

export interface MetricsSummary {
  totalRecoveries: number;
  successfulRecoveries: number;
  failedRecoveries: number;
  successRate: number;
  avgResponseTimeMs: number;
  uptimeSeconds: number;
  errorCount: number;
  recentErrors: Array<{
    timestamp: number;
    step: string;
    error: string;
    context?: unknown;
  }>;
}

export class MetricsCollector {
  private metrics: RecoveryMetrics;

  constructor() {
    this.metrics = {
      totalRecoveries: 0,
      successfulRecoveries: 0,
      failedRecoveries: 0,
      totalResponseTimeMs: 0,
      errors: [],
      startTime: Date.now(),
    };
  }

  recordRecoveryStart(): void {
    this.metrics.totalRecoveries++;
  }

  recordRecoverySuccess(durationMs: number): void {
    this.metrics.successfulRecoveries++;
    this.metrics.totalResponseTimeMs += durationMs;
  }

  recordRecoveryFailure(step: string, error: string, durationMs: number, context?: unknown): void {
    this.metrics.failedRecoveries++;
    this.metrics.totalResponseTimeMs += durationMs;

    this.metrics.errors.push({
      timestamp: Date.now(),
      step,
      error,
      context,
    });

    // Keep only last 100 errors to prevent unbounded memory growth
    if (this.metrics.errors.length > 100) {
      this.metrics.errors = this.metrics.errors.slice(-100);
    }
  }

  getMetrics(): MetricsSummary {
    const now = Date.now();
    const uptimeSeconds = Math.floor((now - this.metrics.startTime) / 1000);
    const successRate = this.metrics.totalRecoveries > 0
      ? (this.metrics.successfulRecoveries / this.metrics.totalRecoveries) * 100
      : 0;
    const avgResponseTimeMs = this.metrics.totalRecoveries > 0
      ? this.metrics.totalResponseTimeMs / this.metrics.totalRecoveries
      : 0;

    return {
      totalRecoveries: this.metrics.totalRecoveries,
      successfulRecoveries: this.metrics.successfulRecoveries,
      failedRecoveries: this.metrics.failedRecoveries,
      successRate,
      avgResponseTimeMs,
      uptimeSeconds,
      errorCount: this.metrics.errors.length,
      recentErrors: this.metrics.errors.slice(-10), // Last 10 errors
    };
  }

  getRawMetrics(): RecoveryMetrics {
    return { ...this.metrics };
  }
}
