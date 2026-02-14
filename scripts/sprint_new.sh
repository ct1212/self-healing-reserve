#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: scripts/sprint_new.sh <name> [\"goal description\"]"
  echo ""
  echo "  <name>  Sprint identifier (e.g., v1, v2, auth, dashboard)"
  echo ""
  echo "Examples:"
  echo "  scripts/sprint_new.sh v1"
  echo "  scripts/sprint_new.sh auth \"Add OAuth2 login with Google and GitHub\""
  exit 1
fi

SPRINT="$1"
GOAL="${2:-}"

ROOT="$(git rev-parse --show-toplevel)"
DIR="$ROOT/sprints/$SPRINT"

mkdir -p "$DIR"

# Prompt for goal if not provided
if [[ -z "$GOAL" ]]; then
  echo "=========================================="
  echo "  Creating Sprint: $SPRINT"
  echo "=========================================="
  echo ""
  echo "What do you want to build?"
  echo "(Describe your goal in plain English - you can refine it later)"
  echo ""
  read -p "Goal: " GOAL
  echo ""

  if [[ -z "$GOAL" ]]; then
    GOAL="Describe the goal here in plain English."
  fi
fi

cat > "$DIR/00-goal.md" <<EOG
# Goal

$GOAL

# Constraints

- Keep scope small and focused
- Prefer local installs only (no global installs, no sudo)
- Use modern, well-supported tools
- (Add any specific requirements or limitations here)

# Done when

- List concrete acceptance criteria here
- Each criterion should be testable/verifiable
- Be as specific as possible

# Stack (optional)

_Leave this section empty to let Claude choose the best stack for your goal._
_Or specify your preferred technologies here if you have strong preferences._
EOG

# Create placeholder files so the directory structure is complete
if [[ ! -f "$DIR/01-prd.md" ]]; then
  cat > "$DIR/01-prd.md" <<EOF
# PRD — Sprint $SPRINT

_Run \`./scripts/sprint_prd.sh $SPRINT\` to generate._
EOF
fi

if [[ ! -f "$DIR/02-tasks.md" ]]; then
  cat > "$DIR/02-tasks.md" <<EOF
# Tasks — Sprint $SPRINT

_Run \`./scripts/sprint_prd.sh $SPRINT\` to generate._
EOF
fi

touch "$DIR/03-status.md"

echo "Created sprint $SPRINT at sprints/$SPRINT/"
echo ""
echo "Next steps:"
echo "  1. Edit sprints/$SPRINT/00-goal.md (refine goal, constraints, acceptance criteria)"
echo "     Tip: Leave the Stack section empty to let Claude choose the best tools!"
echo "  2. Run ./scripts/sprint_prd.sh $SPRINT (generates initial PRD)"
echo "  3. Run ./scripts/sprint_refine.sh $SPRINT (interactive refinement + task generation)"
