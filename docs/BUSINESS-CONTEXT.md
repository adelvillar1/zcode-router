# Business Context

## What this is

Personal infrastructure: the kit exists to get full value out of several **prepaid model plans** (token plan, Z.AI coding plan, MiMo plan, Step plan, DeepSeek) from inside ZCode, instead of letting each tool default to whichever single model it prefers. Every design decision follows from that: steer to the plan with headroom, meter everything (a prepaid plan pays for mixture proposers too), and never quietly start costing per-token money (`payg` gate).

## Who uses it

One developer, on their own machines. "Users" means future-you on a fresh machine — hence the new-machine quickstart as a first-class flow, and `kit init` exporting a live machine's roster.

## Non-goals

- Not a product; no multi-tenant anything, no accounts, no hosting.
- Not a general proxy — OpenAI chat-completions only.
- No artificial token limits; the kit routes, it doesn't ration.

## Upstream relationship

ZCode is the host app ([zai-org/ZCode](https://github.com/zai-org/ZCode)). The kit renders into ZCode's personal provider config and workflow directory. The upstream contribution effort (plan in `docs/upstream-contribution.md`, PR workflow pack in `docs/upstream-pr-workflow-pack.md`) established that upstream **does not accept pull requests** — the prepared PR state and the blocker are documented, not open work.

## Success looks like

`kit doctor` green on any machine after clone + roster + keys; usage visible per plan; routing decisions explainable after the fact (headers + `route-verdict` log lines); a judge outage never failing a request.
