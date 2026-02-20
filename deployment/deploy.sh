#!/bin/bash
set -e

echo "========================================"
echo "Self-Healing Reserve - Production Deploy"
echo "========================================"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Error: Please run with sudo${NC}"
  exit 1
fi

# Get the actual user who called sudo
ACTUAL_USER=${SUDO_USER:-$USER}

echo -e "${GREEN}Step 1: Installing Nginx configuration${NC}"
cp /home/agent/projects/hackathon/self-healing-reserve/deployment/nginx-cre.conf /etc/nginx/snippets/cre.conf
echo "✓ Copied nginx-cre.conf to /etc/nginx/snippets/"

echo ""
echo -e "${GREEN}Step 2: Testing Nginx configuration${NC}"
nginx -t

echo ""
echo -e "${GREEN}Step 3: Installing systemd service${NC}"
cp /home/agent/projects/hackathon/self-healing-reserve/deployment/self-healing-reserve.service /etc/systemd/system/
systemctl daemon-reload
echo "✓ Installed self-healing-reserve.service"

echo ""
echo -e "${GREEN}Step 4: Enabling and starting service${NC}"
systemctl enable self-healing-reserve
systemctl restart self-healing-reserve
echo "✓ Service enabled and started"

echo ""
echo -e "${GREEN}Step 5: Reloading Nginx${NC}"
systemctl reload nginx
echo "✓ Nginx reloaded"

echo ""
echo -e "${GREEN}Step 6: Checking service status${NC}"
sleep 2
systemctl status self-healing-reserve --no-pager || true

echo ""
echo "========================================"
echo -e "${GREEN}Deployment Complete!${NC}"
echo "========================================"
echo ""
echo "Access dashboard at: http://\$(hostname -I | awk '{print \$1}')/cre"
echo ""
echo "Useful commands:"
echo "  sudo systemctl status self-healing-reserve"
echo "  sudo journalctl -u self-healing-reserve -f"
echo "  curl http://127.0.0.1:3002/api/status"
echo ""
