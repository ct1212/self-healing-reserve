# Self-Healing Reserve - Production Deployment

This guide follows the VPS networking rules: localhost-only services behind Nginx reverse proxy.

## Architecture

```
Internet → Nginx (80/443) → /cre → 127.0.0.1:3002 (Dashboard)
           Only ports 22, 80, 443 public
```

## Prerequisites

- VPS with Ubuntu/Debian
- User: `agent`
- Nginx installed
- Firewall (ufw) configured
- Node.js and npm installed

## Initial Setup

### 1. Install System Dependencies

```bash
# Nginx
sudo apt update
sudo apt install nginx -y
sudo systemctl enable --now nginx

# Firewall
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

### 2. Clone Repository

```bash
cd /home/agent/projects
git clone https://github.com/ct1212/self-healing-reserve.git
cd self-healing-reserve
npm run setup  # Install all dependencies
```

## Dashboard Deployment

### 3. Configure Nginx

Copy the nginx configuration snippet:

```bash
sudo cp deployment/nginx-cre.conf /etc/nginx/snippets/cre.conf
```

Create or edit `/etc/nginx/sites-available/main`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name _;  # Replace with your domain or IP

    # Self-Healing Reserve Dashboard
    include /etc/nginx/snippets/cre.conf;

    # Add other apps here
    # include /etc/nginx/snippets/dex.conf;
    # include /etc/nginx/snippets/mo.conf;
}
```

Enable the site:

```bash
sudo ln -sf /etc/nginx/sites-available/main /etc/nginx/sites-enabled/main
sudo nginx -t
sudo systemctl reload nginx
```

### 4. Install Systemd Service

```bash
sudo cp deployment/self-healing-reserve.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable self-healing-reserve
sudo systemctl start self-healing-reserve
```

### 5. Verify Deployment

Check service status:

```bash
sudo systemctl status self-healing-reserve
```

Check logs:

```bash
sudo journalctl -u self-healing-reserve -f
```

Test localhost:

```bash
curl http://127.0.0.1:3002/api/status
```

Test via Nginx:

```bash
curl http://<YOUR_IP_OR_DOMAIN>/cre/api/status
```

Access in browser:

```
http://<YOUR_IP_OR_DOMAIN>/cre
```

## Configuration

Environment variables are configured in the systemd service file. To change:

1. Edit `/etc/systemd/system/self-healing-reserve.service`
2. Reload: `sudo systemctl daemon-reload`
3. Restart: `sudo systemctl restart self-healing-reserve`

### Production Environment Variables

```bash
# Required
BIND_HOST=127.0.0.1          # Localhost only
DASHBOARD_PORT=3002          # Internal port
PUBLIC_URL=your-ip-or-domain  # Your VPS IP or domain

# Optional
RPC_URL=http://127.0.0.1:8545
MOCK_API_URL=http://127.0.0.1:3001
CONTRACT_ADDRESS=0x...

# Alerts
ALERTS_ENABLED=true
ALERT_SLACK_ENABLED=true
ALERT_SLACK_WEBHOOK_URL=https://hooks.slack.com/...
```

## Updates

To deploy updates:

```bash
cd /home/agent/projects/self-healing-reserve
git pull
npm run setup  # If dependencies changed
sudo systemctl restart self-healing-reserve
```

## Security Checklist

- ✅ Dashboard listens on 127.0.0.1 only
- ✅ Nginx proxies /cre to port 3002
- ✅ Only ports 22, 80, 443 public
- ✅ Service runs as user `agent`
- ✅ Auto-restart on failure
- ⬜ Add HTTPS with Certbot (when domain ready)
- ⬜ Add Basic Auth for sensitive paths (optional)

## HTTPS Setup (Future)

When you have a domain:

```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d yourdomain.com
```

Update nginx config:

```nginx
server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    include /etc/nginx/snippets/cre.conf;
}
```

## Troubleshooting

### Service won't start

```bash
# Check logs
sudo journalctl -u self-healing-reserve -n 50

# Check if port is in use
sudo ss -tlnp | grep 3002

# Test manually
cd /home/agent/projects/self-healing-reserve/dashboard
BIND_HOST=127.0.0.1 npm run start
```

### Nginx errors

```bash
# Test configuration
sudo nginx -t

# Check error log
sudo tail -f /var/log/nginx/error.log

# Verify snippet exists
ls -la /etc/nginx/snippets/cre.conf
```

### Can't access via browser

```bash
# Check firewall
sudo ufw status

# Verify nginx is running
sudo systemctl status nginx

# Check if service is accessible locally
curl -v http://127.0.0.1:3002/api/status
```

## Monitoring

View real-time logs:

```bash
# Service logs
sudo journalctl -u self-healing-reserve -f

# Nginx access logs
sudo tail -f /var/log/nginx/access.log

# Nginx error logs
sudo tail -f /var/log/nginx/error.log
```

## Backup

Important files to backup:

- `/home/agent/projects/self-healing-reserve/` - Application code
- `/etc/systemd/system/self-healing-reserve.service` - Service config
- `/etc/nginx/snippets/cre.conf` - Nginx config
- `/etc/nginx/sites-available/main` - Main site config

## Definition of Done

- ✅ App listens on 127.0.0.1:3002
- ✅ Nginx maps /cre to port 3002
- ✅ Only ports 22, 80, 443 are public
- ✅ Service runs under systemd as agent
- ✅ Status check works via `curl http://localhost:3002/api/status`
- ✅ Dashboard accessible via `http://VPS_IP/cre`
