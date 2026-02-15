/**
 * Multi-channel alerting system
 */

import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'

export type AlertType =
  | 'RECOVERY_FAILURE'
  | 'HEALTH_CHECK_FAILURE'
  | 'UNDERCOLLATERALIZATION'
  | 'AGENT_DOWN';

interface AlertConfig {
  enabled: boolean;
  onRecoveryFailure: boolean;
  onHealthFailure: boolean;
  onUndercollateralization: boolean;

  emailEnabled: boolean;
  emailSmtpHost?: string;
  emailSmtpPort?: number;
  emailUser?: string;
  emailPass?: string;
  emailFrom?: string;
  emailTo?: string;

  slackEnabled: boolean;
  slackWebhookUrl?: string;

  discordEnabled: boolean;
  discordWebhookUrl?: string;
}

interface AlertData {
  type: AlertType;
  timestamp: number;
  message: string;
  details?: unknown;
}

export class AlertManager {
  private config: AlertConfig;
  private emailTransporter: Transporter | null = null;
  private alertHistory: AlertData[] = [];

  constructor() {
    this.config = this.loadConfig();

    if (this.config.emailEnabled) {
      this.initializeEmail();
    }
  }

  private loadConfig(): AlertConfig {
    return {
      enabled: process.env.ALERTS_ENABLED === 'true',
      onRecoveryFailure: process.env.ALERT_ON_RECOVERY_FAILURE !== 'false',
      onHealthFailure: process.env.ALERT_ON_HEALTH_FAILURE !== 'false',
      onUndercollateralization: process.env.ALERT_ON_UNDERCOLLATERALIZATION !== 'false',

      emailEnabled: process.env.ALERT_EMAIL_ENABLED === 'true',
      emailSmtpHost: process.env.ALERT_EMAIL_SMTP_HOST,
      emailSmtpPort: process.env.ALERT_EMAIL_SMTP_PORT ? Number(process.env.ALERT_EMAIL_SMTP_PORT) : undefined,
      emailUser: process.env.ALERT_EMAIL_USER,
      emailPass: process.env.ALERT_EMAIL_PASS,
      emailFrom: process.env.ALERT_EMAIL_FROM,
      emailTo: process.env.ALERT_EMAIL_TO,

      slackEnabled: process.env.ALERT_SLACK_ENABLED === 'true',
      slackWebhookUrl: process.env.ALERT_SLACK_WEBHOOK_URL,

      discordEnabled: process.env.ALERT_DISCORD_ENABLED === 'true',
      discordWebhookUrl: process.env.ALERT_DISCORD_WEBHOOK_URL,
    };
  }

  private initializeEmail(): void {
    if (!this.config.emailSmtpHost || !this.config.emailUser || !this.config.emailPass) {
      console.warn('[alerts] Email enabled but missing SMTP configuration');
      return;
    }

    try {
      this.emailTransporter = nodemailer.createTransport({
        host: this.config.emailSmtpHost,
        port: this.config.emailSmtpPort || 587,
        secure: this.config.emailSmtpPort === 465,
        auth: {
          user: this.config.emailUser,
          pass: this.config.emailPass,
        },
      });
    } catch (error) {
      console.error('[alerts] Failed to initialize email transporter:', error);
    }
  }

  async sendAlert(type: AlertType, message: string, details?: unknown): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    // Check if this alert type is enabled
    if (type === 'RECOVERY_FAILURE' && !this.config.onRecoveryFailure) return;
    if (type === 'HEALTH_CHECK_FAILURE' && !this.config.onHealthFailure) return;
    if (type === 'UNDERCOLLATERALIZATION' && !this.config.onUndercollateralization) return;

    const alertData: AlertData = {
      type,
      timestamp: Date.now(),
      message,
      details,
    };

    // Store in history
    this.alertHistory.push(alertData);
    if (this.alertHistory.length > 100) {
      this.alertHistory = this.alertHistory.slice(-100);
    }

    console.log(`[alerts] Sending ${type} alert: ${message}`);

    // Send to all enabled channels
    const promises: Promise<void>[] = [];

    if (this.config.emailEnabled) {
      promises.push(this.sendEmail(alertData));
    }

    if (this.config.slackEnabled) {
      promises.push(this.sendSlack(alertData));
    }

    if (this.config.discordEnabled) {
      promises.push(this.sendDiscord(alertData));
    }

    await Promise.allSettled(promises);
  }

  private async sendEmail(alert: AlertData): Promise<void> {
    if (!this.emailTransporter) {
      console.warn('[alerts] Email transporter not initialized');
      return;
    }

    try {
      const subject = `Self-Healing Reserve Alert: ${alert.type}`;
      const text = `
Alert Type: ${alert.type}
Timestamp: ${new Date(alert.timestamp).toISOString()}
Message: ${alert.message}

${alert.details ? `Details:\n${JSON.stringify(alert.details, null, 2)}` : ''}
`;

      await this.emailTransporter.sendMail({
        from: this.config.emailFrom || this.config.emailUser,
        to: this.config.emailTo,
        subject,
        text,
      });

      console.log('[alerts] Email sent successfully');
    } catch (error) {
      console.error('[alerts] Failed to send email:', error);
    }
  }

  private async sendSlack(alert: AlertData): Promise<void> {
    if (!this.config.slackWebhookUrl) {
      console.warn('[alerts] Slack webhook URL not configured');
      return;
    }

    try {
      const color = this.getAlertColor(alert.type);
      const payload = {
        text: `Self-Healing Reserve Alert`,
        attachments: [
          {
            color,
            title: alert.type,
            text: alert.message,
            fields: [
              {
                title: 'Timestamp',
                value: new Date(alert.timestamp).toISOString(),
                short: true,
              },
            ],
            footer: 'Self-Healing Reserve',
            ts: Math.floor(alert.timestamp / 1000),
          },
        ],
      };

      const response = await fetch(this.config.slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Slack webhook returned ${response.status}`);
      }

      console.log('[alerts] Slack notification sent successfully');
    } catch (error) {
      console.error('[alerts] Failed to send Slack notification:', error);
    }
  }

  private async sendDiscord(alert: AlertData): Promise<void> {
    if (!this.config.discordWebhookUrl) {
      console.warn('[alerts] Discord webhook URL not configured');
      return;
    }

    try {
      const color = this.getAlertColorInt(alert.type);
      const payload = {
        embeds: [
          {
            title: `Self-Healing Reserve Alert: ${alert.type}`,
            description: alert.message,
            color,
            fields: [
              {
                name: 'Timestamp',
                value: new Date(alert.timestamp).toISOString(),
                inline: true,
              },
            ],
            footer: {
              text: 'Self-Healing Reserve',
            },
            timestamp: new Date(alert.timestamp).toISOString(),
          },
        ],
      };

      const response = await fetch(this.config.discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Discord webhook returned ${response.status}`);
      }

      console.log('[alerts] Discord notification sent successfully');
    } catch (error) {
      console.error('[alerts] Failed to send Discord notification:', error);
    }
  }

  private getAlertColor(type: AlertType): string {
    switch (type) {
      case 'RECOVERY_FAILURE':
      case 'AGENT_DOWN':
        return 'danger';
      case 'HEALTH_CHECK_FAILURE':
        return 'warning';
      case 'UNDERCOLLATERALIZATION':
        return '#ff9900';
      default:
        return '#808080';
    }
  }

  private getAlertColorInt(type: AlertType): number {
    switch (type) {
      case 'RECOVERY_FAILURE':
      case 'AGENT_DOWN':
        return 0xff0000; // Red
      case 'HEALTH_CHECK_FAILURE':
        return 0xffaa00; // Orange
      case 'UNDERCOLLATERALIZATION':
        return 0xff9900; // Yellow-orange
      default:
        return 0x808080; // Gray
    }
  }

  getConfig(): Partial<AlertConfig> {
    return {
      enabled: this.config.enabled,
      onRecoveryFailure: this.config.onRecoveryFailure,
      onHealthFailure: this.config.onHealthFailure,
      onUndercollateralization: this.config.onUndercollateralization,
      emailEnabled: this.config.emailEnabled,
      slackEnabled: this.config.slackEnabled,
      discordEnabled: this.config.discordEnabled,
      // Redact sensitive fields
    };
  }

  getHistory(limit = 10): AlertData[] {
    return this.alertHistory.slice(-limit);
  }
}
