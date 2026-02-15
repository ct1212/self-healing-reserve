#!/bin/bash
# Test script for live dashboard
# Dashboard is already running via systemd

cd /home/agent/projects/self-healing-reserve

echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║  Testing Self-Healing Reserve with Live Dashboard               ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""

# Start Hardhat in background
echo "1. Starting Hardhat node..."
npx hardhat node --port 8545 > /tmp/hardhat.log 2>&1 &
HARDHAT_PID=$!
sleep 3
echo "   ✓ Hardhat running (PID: $HARDHAT_PID)"

# Deploy contract
echo ""
echo "2. Deploying contract..."
CONTRACT_ADDRESS=$(npx tsx demo/deploy-contract.ts 2>/dev/null | grep "0x" | tail -1)
export CONTRACT_ADDRESS
echo "   ✓ Contract deployed: $CONTRACT_ADDRESS"

# Update systemd service with contract address
echo ""
echo "3. Updating dashboard with contract address..."
sudo systemctl set-environment CONTRACT_ADDRESS=$CONTRACT_ADDRESS
sudo systemctl restart self-healing-reserve
sleep 2
echo "   ✓ Dashboard updated"

# Start mock API
echo ""
echo "4. Starting mock API..."
cd mock-api
npm start > /tmp/mock-api.log 2>&1 &
MOCK_API_PID=$!
cd ..
sleep 2
echo "   ✓ Mock API running (PID: $MOCK_API_PID)"

# Start agent
echo ""
echo "5. Starting recovery agent..."
cd agent
CONTRACT_ADDRESS=$CONTRACT_ADDRESS npm start > /tmp/agent.log 2>&1 &
AGENT_PID=$!
cd ..
sleep 3
echo "   ✓ Agent monitoring (PID: $AGENT_PID)"

echo ""
echo "══════════════════════════════════════════════════════════════════"
echo "✅ All services running!"
echo "══════════════════════════════════════════════════════════════════"
echo ""
echo "📊 Dashboard: http://76.13.177.213/cre"
echo ""
echo "Next steps:"
echo "  1. Visit dashboard in browser"
echo "  2. Toggle mock API to undercollateralized:"
echo "     curl -X POST http://127.0.0.1:3001/toggle"
echo "  3. Simulate workflow check:"
echo "     cd workflow && npm start"
echo "  4. Watch agent recover!"
echo ""
echo "Logs:"
echo "  tail -f /tmp/hardhat.log"
echo "  tail -f /tmp/mock-api.log"
echo "  tail -f /tmp/agent.log"
echo ""
echo "Press Ctrl+C to stop all services..."

# Keep running
trap "kill $HARDHAT_PID $MOCK_API_PID $AGENT_PID 2>/dev/null; exit" INT TERM
wait
