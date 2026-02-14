#!/usr/bin/env bash
set -euo pipefail

# Defaults
MODEL="sonnet"
MAX_BUDGET="3.00"

# Parse arguments
SPRINT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)
      MODEL="$2"
      shift 2
      ;;
    --max-budget-usd)
      MAX_BUDGET="$2"
      shift 2
      ;;
    -*)
      echo "Unknown flag: $1"
      exit 1
      ;;
    *)
      SPRINT="$1"
      shift
      ;;
  esac
done

if [[ -z "$SPRINT" ]]; then
  echo "Usage: scripts/sprint_refine.sh <sprint> [--model sonnet] [--max-budget-usd 3.00]"
  exit 1
fi

ROOT="$(git rev-parse --show-toplevel)"
DIR="$ROOT/sprints/$SPRINT"

GOAL_FILE="$DIR/00-goal.md"
PRD_FILE="$DIR/01-prd.md"
TASKS_FILE="$DIR/02-tasks.md"
STATUS_FILE="$DIR/03-status.md"

if [[ ! -f "$GOAL_FILE" ]]; then
  echo "Missing $GOAL_FILE — run ./scripts/sprint_new.sh $SPRINT first."
  exit 1
fi

if [[ ! -f "$PRD_FILE" ]]; then
  echo "Missing $PRD_FILE — run ./scripts/sprint_prd.sh $SPRINT first to generate the initial PRD."
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "Error: 'claude' command not found on PATH."
  echo "Install it: https://docs.anthropic.com/en/docs/claude-code"
  exit 1
fi

GOAL_CONTENT="$(cat "$GOAL_FILE")"
PRD_CONTENT="$(cat "$PRD_FILE")"

PROMPT="$(cat <<PROMPT
You are helping refine the PRD (Product Requirements Document) for sprint $SPRINT.

Here is the original goal:

---GOAL---
$GOAL_CONTENT
---ENDGOAL---

Here is the PRD I generated:

---PRD---
$PRD_CONTENT
---ENDPRD---

Your job is to walk the user through the PRD step-by-step and help them refine it:

1. **Start by summarizing** the PRD at a high level (what we're building, recommended stack, key decisions)

2. **Walk through each section** one at a time:
   - Overview
   - Recommended Stack
   - Scope & Out of Scope
   - Assumptions & Constraints
   - Architecture
   - Key Components
   - Data Models
   - API/Interfaces
   - Acceptance Criteria
   - Risks & Mitigations
   - Open Questions

3. **For each section**, ask the user:
   - Does this look correct?
   - Is anything missing?
   - Should we add, remove, or change anything?

4. **Make refinements** based on their feedback. Use the Edit tool to update the PRD file at $PRD_FILE as you go.

5. **When the user is satisfied** with the PRD, ask if they're ready to generate tasks.

6. **Generate the task list** and save it to $TASKS_FILE using this format:
   - Unchecked markdown checklist format: - [ ] Task description
   - Each task should be 5-20 minutes
   - Include tasks for: setup/scaffolding → core functionality → tests → polish → docs
   - Order tasks logically with dependencies considered
   - Be specific and actionable

7. **After generating tasks**, update the status file and let the user know they can now run sprint_dev.sh

Guidelines:
- Be concise and focused in your questions
- Don't ask about things that are obviously correct
- Focus on clarifying ambiguities and filling gaps
- If the user says "looks good" or similar, move to the next section quickly
- Keep the conversation moving forward
- Use the Edit tool to update $PRD_FILE as refinements are made
- Use the Write tool to create $TASKS_FILE when generating tasks

Remember: You're helping the user feel confident that the plan is solid before generating tasks.
PROMPT
)"

echo "=========================================="
echo "  Interactive PRD Refinement"
echo "=========================================="
echo "Sprint: $SPRINT"
echo "Model: $MODEL"
echo "Budget: \$$MAX_BUDGET"
echo ""
echo "Claude will walk you through the PRD and help you refine it."
echo "When you're satisfied, tasks will be generated."
echo ""
echo "=========================================="
echo ""

# Start interactive Claude session
printf "%s" "$PROMPT" | claude \
  --model "$MODEL" \
  --max-budget-usd "$MAX_BUDGET"

# Check if tasks were generated
if [[ -f "$TASKS_FILE" ]]; then
  {
    echo
    echo "[$(date -u +"%Y-%m-%d %H:%M:%S UTC")]"
    echo "Refined PRD and generated tasks (02-tasks.md) for sprint $SPRINT."
    echo "Next: run ./scripts/sprint_dev.sh $SPRINT"
  } >> "$STATUS_FILE"

  echo ""
  echo "=========================================="
  echo "  PRD refinement complete!"
  echo "=========================================="
  echo ""
  echo "Next steps:"
  echo "  1. Review the tasks: vi sprints/$SPRINT/02-tasks.md"
  echo "  2. Run tasks: ./scripts/sprint_dev.sh $SPRINT"
  echo "  3. Or run all tasks: ./scripts/sprint_dev.sh $SPRINT --loop"
else
  echo ""
  echo "NOTE: Tasks were not generated. Run this script again to complete the refinement."
fi
