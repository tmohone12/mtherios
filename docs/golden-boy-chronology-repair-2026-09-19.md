# The golden boy: restored chronology repair

Story: `story_332449d7-f704-4f56-aa31-097dbec8d0ce`.

The restored transcript ended in 297 AC, but imported summaries and canonical records still contained later campaign events through 299 AC. The author clarified that Aurion has not hatched dragons, his daughters Elaera and Yue are infants, and he has not met Daenerys.

## Applied result

- Archived later-campaign records whose source entries were absent from the restored transcript, including 56 incomplete or unsupported chapter projections and nine arcs.
- Corrected current character records, nursery event memories, and the final chapter's infant-incompatible details. Retired the contaminated Director frame and removed later dragon inventory from a merged player alias.
- Rebuilt twelve chapters from consecutive twenty-turn windows, with 240 distinct source accounts. One arc covers the first ten chapters; fourteen recent turns remain outside completed chapters.
- Preserved all 548 transcript entries, their positions, text, and branch/parent links. SHA-256 of the verified entry tuples: `928e542323d9d5723da062b9ffbf43bc329bbe213e5adad86be3e7041e87a28e`.
- Added the author's correction to the live system prompt. It establishes the repair checkpoint, while allowing future development through subsequent play.

Chapter generation succeeded with configured service fallbacks. Arc generation exhausted its provider fallbacks; its replacement concatenates the validated chapter narratives in order, with complete chapter source accounts and explicit `codex-source-preserving-assembly` provenance. The standard resumable job validated and applied all saved drafts. No turn was replayed or world time advanced.

## Recovery and verification

Full snapshots: `data/repairs/golden_boy_restored_chronology_20260919-v3234.json` and `data/repairs/golden_boy_restored_chronology_20260919-finalize-v3236.json`. The final stray 299 AC faction move and its two memory nodes were separately archived in `data/repairs/golden-boy-final-stray-world-event.json`.

Applied rebuild job: `job_cae18ac1-501c-42de-ac20-ece3ac291d79`, resumed from `job_383f16e7-61cd-400f-a855-e8f172b346bf`. Drafts and captured sources remain under their `data/exports/summary-rebuild-*` directories.

Verification: `node --test scripts/repair-golden-boy-chronology.test.mjs` and `node scripts/verify-golden-boy-chronology.mjs`. The latter checks source coverage, preserved transcript, corrected records, absence of unsupported future events, and the live built system prompt. Evidence is saved in `.codex-run/golden-boy-repair-verification.json` and `.codex-run/golden-boy-context-verified.json`. Final canonical story version: 3238.

Original generated dialogue remains in the transcript as historical evidence; corrected working summaries and explicit author instructions override the age-inconsistent passages.
