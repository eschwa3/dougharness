---
name: doug-approve
description: Approve the current .doug/plan.json so the doug-implement workflow may run it. Validates the plan first and writes the task anchor that survives compaction. Only the user invokes this.
disable-model-invocation: true
allowed-tools: Bash(node *plan.mjs *)
---

# doug-approve

Approval is the user's act. This skill records it.

1. Validate and approve: `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" approve`
   If validation fails, show the errors and stop. Do not edit the plan to make it pass; report what is wrong.
2. Write the anchor: `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.mjs" anchor`
3. Confirm to the user that the plan is approved and that `/doug-implement` will execute it.
