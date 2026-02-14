#!/usr/bin/env bash
set -euo pipefail

# Defaults
MODEL="sonnet"
MAX_BUDGET="2.00"

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
  echo "Usage: scripts/sprint_prd.sh <sprint> [--model sonnet] [--max-budget-usd 2.00]"
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

if ! command -v claude >/dev/null 2>&1; then
  echo "Error: 'claude' command not found on PATH."
  echo "Install it: https://docs.anthropic.com/en/docs/claude-code"
  exit 1
fi

GOAL_CONTENT="$(cat "$GOAL_FILE")"

PROMPT="$(cat <<PROMPT
Here is the goal file for sprint $SPRINT:

---GOAL---
$GOAL_CONTENT
---ENDGOAL---

Your job:
1. Analyze the goal and choose the most appropriate, modern, and efficient technology stack
2. Generate a comprehensive PRD (Product Requirements Document)

When choosing the stack, consider:
- Project type (API, CLI, web app, data processing, etc.)
- Optimal language for the use case (TypeScript for web/API, Python for data/ML, Go for CLI/performance, Rust for systems, etc.)
- Modern, well-maintained tools with good ecosystems
- Fast development iteration (good DX, testing tools, etc.)
- Keep it simple - avoid over-engineering
- Prefer tools Claude can work with effectively

Return ONLY the PRD content in markdown format. Do not add markers or extra text.

PRD must include these sections:
1. **Overview** — Brief summary of what we're building and why
2. **Recommended Stack** — Technology choices with rationale (or confirm user's choices if specified)
3. **Scope** — What IS included in this sprint
4. **Out of Scope** — What is explicitly NOT included
5. **Assumptions** — What we're assuming to be true
6. **Constraints** — Technical or business limitations
7. **Architecture** — High-level system design
8. **Key Components** — Main parts of the system and their responsibilities
9. **Data Models** — Important entities and their relationships
10. **API/Interfaces** — External interfaces (if applicable)
11. **Acceptance Criteria** — How we know it's done
12. **Risks & Mitigations** — What could go wrong and how to handle it
13. **Open Questions** — Things to clarify before or during implementation

If the goal file already specifies a stack, use that. Otherwise, choose the best stack and explain why.
PROMPT
)"

echo "Generating initial PRD for sprint $SPRINT (model: $MODEL, budget: \$$MAX_BUDGET)..."

PRD_CONTENT="$(claude -p \
  --model "$MODEL" \
  --max-turns 2 \
  --dangerously-skip-permissions \
  --max-budget-usd "$MAX_BUDGET" \
  "$PROMPT")"

if [[ -z "${PRD_CONTENT//[[:space:]]/}" ]]; then
  echo "ERROR: PRD content was empty."
  exit 1
fi

printf "%s\n" "$PRD_CONTENT" > "$PRD_FILE"

{
  echo
  echo "[$(date -u +"%Y-%m-%d %H:%M:%S UTC")]"
  echo "Generated initial PRD (01-prd.md) for sprint $SPRINT."
  echo "Next: run ./scripts/sprint_refine.sh $SPRINT to review and refine the PRD interactively"
} >> "$STATUS_FILE"

echo "OK: wrote $PRD_FILE"
echo "OK: updated $STATUS_FILE"
echo ""
echo "Next steps:"
echo "  1. Run ./scripts/sprint_refine.sh $SPRINT to interactively review and refine the PRD"
echo "  2. Claude will walk you through each section and generate tasks when you're ready"
