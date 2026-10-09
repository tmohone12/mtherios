# MythEngine Phase 4 GM context

Date: 2026-09-22. The GM context path is implemented and live-verified in the isolated MythEngine working copy on `codex/mythengine-overhaul`. The [overhaul plan](mythengine-overhaul-plan-2026-09-21.md) continues with Phase 5. Assistant independence remains a Phase 8 integration gate because the separate Assistant does not exist yet.

## Delivered behavior

Content items and canonical records retain optional branch and POV scope through writes, history restore, copy, export and import. Migration `0029_authored_context_scope.sql` was applied only to the isolated MythEngine database; `data/phase4-before.sql` is its local pre-migration backup. GM mode resolves item override, then type default, then Searchable. Clearing the override restores inheritance. The server loads eligible project/game/branch/POV records and resolves mode before returning authored body data to the prompt compiler. Pinned includes authored content, Partial includes title and description, and Searchable adds no catalog preload. Required current player, scene, actor and belief context stays separately labeled.

The server compiles authored context for prepare, preview, debug and generation. Project/type/item/canonical revisions and the effective narrative setting participate in prepared-context freshness. A content-policy change invalidates the prepared draft; the authoring fingerprint is checked again before the primary provider request and a roll continuation. Whole Pinned and Partial records are protected in final budgeting. If they cannot fit, preflight names the contributing items and remedies instead of clipping them silently. Query-driven wiki retrieval records its query, source paths and reason.

The content tree and editors expose effective and explicit modes, “Use type default,” branch/POV scope, keyboard/touch native selectors and type-impact estimates. Turn inspection distinguishes required engine material from authored Pinned and Partial entries. Sent source IDs link to the corresponding project/game document or canonical record and its retained revision. Primary and roll-continuation request receipts retain source spans for authored and required context.

## Live acceptance evidence

The disposable project `shelf_f91b2dfe-88d0-4cd4-acfb-8b2474e591a2` and game `story_dad7ef54-ec13-4329-baa3-c5a60fbaec74` remain in the isolated MythEngine database for review. On the final build, debug and preview agreed: one Pinned and one Partial item were fully sent; the Pinned body and Partial description appeared, while the Partial body, Searchable body, branch-only body and POV-only body were absent. Changing the shared type default from Searchable to Partial caused its inheriting item to appear on the next preview without editing that item; restoring Searchable removed it. A 120-token context preview failed with a per-item oversize explanation.

The browser saved an explicit Partial override, displayed the server-confirmed value, then reset it to “Use type default.” Type preview showed five active documents, one inheriting, three Pinned, one Partial and an estimated 58 preload tokens before game/branch/POV filtering. A source link opened the Pinned document in its game and expanded revision 1. Two actual turns ran only in the disposable game. The final turn reached game server version 3; its persisted primary-request receipt marked both authored items fully sent and located the Partial entry at context characters 1044–1169 and the Pinned entry at 1170–1340. No real campaign turn was submitted.

## Verification and boundary

- `npm run check`: 0 errors, 0 warnings.
- Focused context, receipt, orchestrator and type tests: 72 passing.
- `npm run build`: passed. Final source fingerprint `6d1f17d39752736432e717dfea072f9f57059f11a79949f32ea7f12d1dc26b60`; artifact `42865de5b24e45afac9dc6f188713b1a643075c9b01b4cda8b12067bda529806`.
- `npm test`: 1,554 passing, three inherited `promptHarness.test.ts` chapter/arc budget failures (159 files total). Phase 4 added no remaining test failure.
- Final live MythEngine runtime: `http://127.0.0.1:5174/`, PID 50860, jobs disabled. The real campaign *The Journey* remained at server version 1251. The original Mtherios runtime on 5173 was not restarted.

Assistant has no separate runtime in this phase. The GM-only compiler does not impose preload modes on another service, but Assistant scope and budget independence require a live test when Phase 8 adds that service. Phase 5 tool continuations do not exist yet; the current roll continuation uses the same prepared context and records a separate request summary with source spans. The disposable fixture's vault/index can lag its two test turns while jobs are disabled; PostgreSQL and the sent request receipts were used as the acceptance source.
