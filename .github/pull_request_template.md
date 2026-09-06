## What and why

<!-- What changed, and what problem it solves. -->

## How it was verified

<!--
The test suite is offline, so it cannot catch a wrong endpoint path or a changed
response envelope. For anything touching the API, say what you ran by hand —
`npm run inspect` against a test tenant, which tool, what came back.
-->

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `npm run build` passes
- [ ] Verified manually against a live tenant (say how, below)

## Checklist

- [ ] No cloud ids, tokens, real alert ids, alert content, or on-call names anywhere in the diff
- [ ] New API behaviour has a test, or the PR explains why it isn't testable offline
- [ ] New or changed tools state their sharp edges in the tool **description**, not only in code comments
- [ ] Any new write tool goes through `executeAction`; any new list tool goes through `withCharacterLimit`
- [ ] `annotations` (`readOnlyHint` / `destructiveHint` / `idempotentHint`) are set honestly — clients use these to decide what to auto-approve
- [ ] `TOOLS.md` tool table updated if tools were added or removed
