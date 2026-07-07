## What does this change?

<!-- One or two sentences. Link an issue if there is one. -->

## Which package(s)?

- [ ] `core-ts`
- [ ] `openclaw-plugin`
- [ ] `hermes-plugin`
- [ ] `claude-code`
- [ ] `SPEC.md` / `spec/fixtures/`

## Checklist

- [ ] `npm run build && npm test` passes (for `core-ts`/`openclaw-plugin`/`claude-code` changes)
- [ ] `python -m unittest discover -s test` passes from `packages/hermes-plugin/` (for Hermes changes)
- [ ] If this changes the `UsageSnapshot` shape, config schema, or footer/on-demand/alert text format, `SPEC.md` and `spec/fixtures/` are updated to match, and **both** `core-ts` and `hermes-plugin/usage-hud/core.py` still pass the shared fixtures
- [ ] Any claim about a host's API/behavior is backed by a real source (official docs, or reading the actual package/repo) — see `DESIGN.md` for the verification standard this project holds itself to
