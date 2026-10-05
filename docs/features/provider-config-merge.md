# Feature: `kit apply` safety — backups, surgical merge, schema guard

> Contract: `TECHNICAL-DOCUMENTATION.md` § Local Security Model; `FUNCTIONAL-SPECIFICATIONS.md` § Edge Cases.

## Purpose

`kit apply` writes into ZCode's own personal configuration — the one file (`~/.zcode/v2/provider_config.json`) the app validates *strictly*, where any violation degrades the whole personal config to account-only providers. The apply path is built so a bad roster can never corrupt it.

## The safety chain

1. **Dry-run first**: `kit apply --dry-run` prints the planned diff and writes nothing.
2. **Backup**: `provider_config.json` is backed up (`*.bak-kit*`) before every write.
3. **Schema guard**: the file's `schemaVersion` must be `1`; anything else aborts the apply instead of writing a shape the kit doesn't understand.
4. **Surgical merge**: only the keys the kit owns are rewritten — app-managed rules are left untouched (`lib/provider-merge.mjs`).
5. **No silent removal**: a provider with a missing key never removes a working registration; removal is an explicit `enabled: false` in the roster.
6. **Raw-key warning**: a raw `apiKey` in the committed roster triggers a `kit apply` warning (the fix is moving it to `kit env set` and referencing `apiKeyEnv`).

## Idempotence & verification

Apply is idempotent — re-running converges to the same rendered state (verified on this machine at creation: provider_config stayed semantically identical to its backup). After every apply: service restart + `/healthz` check, and `kit doctor` validates the whole chain end-to-end (`--live` also probes each provider).

## Where the code lives

`lib/provider-merge.mjs` (merge + guard), `lib/render.mjs` (router config), `lib/service.mjs` (restart), `bin/zcode-router-kit.mjs` (apply/dry-run wiring).
