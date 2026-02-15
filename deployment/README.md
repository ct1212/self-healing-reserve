# Deployment Files

Production deployment configuration for VPS following Mo's networking rules.

## Files

- **`nginx-cre.conf`** - Nginx snippet for /cre path routing
- **`self-healing-reserve.service`** - Systemd service file
- **`deploy.sh`** - Automated deployment script
- **`DEPLOYMENT.md`** - Complete deployment guide

## Quick Deploy

```bash
# From project root
sudo deployment/deploy.sh
```

This will:
1. Install Nginx configuration to `/etc/nginx/snippets/cre.conf`
2. Install systemd service to `/etc/systemd/system/`
3. Enable and start the service
4. Reload Nginx
5. Verify everything is running

## Manual Steps

If you prefer manual deployment, see [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed instructions.

## Architecture

```
Internet → Nginx (80/443) → /cre → 127.0.0.1:3002 → Dashboard
           ↑ Public          ↑ Proxy   ↑ Localhost only
```

## Security

- Dashboard binds to **127.0.0.1 only**
- Only ports **22, 80, 443** are public
- Nginx is the single entry point
- Service runs as user **agent**

## Access

After deployment:
- **Public URL**: http://76.13.177.213/cre
- **Health Check**: http://76.13.177.213/cre/api/health
- **Local Test**: curl http://127.0.0.1:3002/api/health

## Environment

Production environment variables are set in the systemd service file.
Development uses `.env` file in project root.

See [DEPLOYMENT.md](./DEPLOYMENT.md) for full documentation.
