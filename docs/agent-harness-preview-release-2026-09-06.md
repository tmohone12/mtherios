# Agent harness preview slice — 2026-09-06

Implemented the first read-only slice of the harness plan's preview workflow.

## Delivered

- Added `turn.preview` to the existing engine command surface.
- Reused `prepareServerTurnContext` for the actual draft, action mode, client context, prompt budget, retrieval, timeline, and effective narrative settings.
- Added inspection mode that skips prepared-turn cache writes, prompt-cache writes/hit touches, and story-vault refreshes.
- Returned an allowlisted preview contract with bounded section/source diagnostics, fingerprints, model capacity source, budgets, warnings, and timing; internal prompt/provider objects are not serialized.
- Added **Preview context** to the backend composer and a bounded original-transcript inspector using the existing `campaign.entriesAround` read command.
- Marked previews stale when the draft, action mode, settings, story revision, or creative mode changes; late responses are discarded and closing the inspector restores keyboard focus.

## Verification

- `npm test`: 129 files, 1,251 tests passed.
- `npm run check`: 0 errors, 0 warnings.
- `npm run build`: passed; isolated production build completed.
- Read-only wiki inspection test confirms no cache row or refresh is created.

## Activation boundary

The running terminal process remains PID 37292 from before this change. A live probe correctly returned `Unknown engine command: turn.preview`, so the new command is not claimed deployed. No restart was attempted; activation remains pending an approved restart path.

The preview is intentionally labelled **Context before GM tool observations**. Full preview/request byte agreement and tool-result reservation remain Slice 5 work. Evidence opening currently exposes transcript-position sources; derived memory records remain listed with their source IDs until their source-entry mapping is added.
