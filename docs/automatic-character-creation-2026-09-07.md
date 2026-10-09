# Automatic character creation

The AI GM can now register significant named NPCs established in narration through the existing state extraction job. This is enabled for subsequent turns and does not bulk-import old names.

## Behavior

- The classifier supplies a short character description and a verbatim `creation_evidence` passage. The backend checks that passage against the persisted narration and resolves identity under the story transaction lock.
- Existing names and aliases reuse canonical identity. Ambiguous identities, invalid explicit IDs, and unsupported creation attempts remain NPC Candidates for review. Generic title-only references do not become characters.
- `faction_evidence` supplies quoted affiliations. Matching canonical faction names or aliases produce both character tags and faction membership rows in the same transaction. Factions explicitly introduced in that turn can be linked too.
- Existing unresolved membership rows are linked when their exact character identity is established. Inactive memberships are not automatically reactivated. Unresolved faction identities or quotations produce warnings instead of new tags.
- Character and membership rows retain source entry IDs, state patch IDs, and quoted evidence. Normal turns continue using state patches for the audit trail.
- Initial extraction, synchronous extraction, compact retries, and delayed extraction use the same creation instructions and validation path. Delayed extraction retains evidence while withholding obsolete scene state.
- The GM Toolkit explains automatic registration and retains the optional manual character preview workflow.

## Verification

The 1,349-test suite passes after updating assertions for the new behavior. Type checking reports zero errors and warnings; the isolated production build succeeds.

Run `node scripts/test-auto-character-creation.mjs` for the disposable PostgreSQL check. It verifies atomic creation and affiliation, same-turn factions, unresolved member linking, concurrent replay, deduplicated review candidates, extraction and retry prompts, reconnect persistence, and story isolation without model calls.

Evidence is saved under `output/auto-characters-20260907`. The runtime rollback copy is `output/runtime-backups/auto-characters-before-20260907/build`.

Activated on the live port 5173 after the runtime became idle. All 287 qualified build files matched after installation. Health checks passed and the production browser displayed the updated toolkit without console errors. No historical character backfill or model calls were performed during verification.
