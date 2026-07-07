# Contributing

Thanks for considering a contribution. This project is small and young — issues, bug reports, and PRs are all welcome.

## Ground rules

1. **Verify against the real host, not memory or secondhand docs.** This project exists because assumptions about plugin APIs turned out wrong on contact with real source more than once during its own build (see `DESIGN.md` for the specifics). Before changing a host adapter, install/clone the actual current package and confirm the hook name, payload shape, or config mechanism you're relying on still exists as described. Cite the file you checked in your PR description or a code comment.
2. **Don't re-meter usage.** Every adapter reads numbers the host already computed (tokens, context %, cost, pricing). If a change would require this project to maintain its own tokenizer or pricing table, it's out of scope — reconsider the approach.
3. **Keep `core-ts` and `hermes-plugin/usage-hud/core.py` in sync.** They implement the same contract (`SPEC.md`) against the same test vectors (`spec/fixtures/*.json`). A behavior change to formatting or threshold logic needs both implementations updated, plus a new or updated fixture if the change affects output shape.
4. **Prefer the narrowest fix.** A bug in one adapter doesn't need a refactor of the shared core unless the bug is actually in the shared core.

## Setup

```bash
git clone https://github.com/Roizlotolov/usage-hud
cd usage-hud
npm install
npm run build
npm test
```

Hermes plugin tests run separately (no Node dependency):

```bash
cd packages/hermes-plugin
python3 -m unittest discover -s test -v
```

## Making a change

1. Read `SPEC.md` first if you're touching formatting, config, or threshold behavior — it's the contract every adapter conforms to.
2. If you're changing a host adapter (`openclaw-plugin`, `hermes-plugin`, `claude-code`), read that package's README — each documents the specific hooks/APIs it relies on and why, including the dead ends already ruled out.
3. Add or update tests. Every package has a real, fast test suite (`node --test` or `python -m unittest`) — there's no reason to skip this even for a small change.
4. Open a PR. CI runs the full test matrix across all four packages automatically.

## Reporting a bug

Use the bug report issue template — it asks for the host version and package involved, which is almost always needed to reproduce anything here (these are plugin APIs that move fast across host releases).

## Security issues

Please don't open a public issue for a security concern — see [`SECURITY.md`](SECURITY.md).
