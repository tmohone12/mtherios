# Character, Party, and Plot Director repairs — 2026-09-08

Narration now has a persisted output allowance of 16,384 tokens, increased from 4,096. The current narrative model and reasoning preference are unchanged. The source and compiled preview also contain the fixes below; they have not been installed into the production app on port 5173.

## Character and dice

The live Veil protagonist, Aurion Belaerys, has no saved numeric player sheet. The Character tab rendered six default scores of 10, which all yield a zero modifier. The existing GM roll path already resolves recognized ability and skill checks against the canonical protagonist sheet. No ability scores were invented or assigned to Aurion.

The Character tab now explicitly identifies unsaved default scores. The GM tools helper explains that ability modifiers affect checks; armor class, hit points, and proficiency are not automatically added to those checks.

A separate identity problem was confirmed: Aurion's description and personality tags described Nairah, and his saved aliases included `Nairah` and `the Naathi woman`. A guarded transaction restored his description from his existing canonical biography, restored traits from his existing personality, marked his relationship/disposition as self, and removed those two aliases. Previous values remain in the repair evidence and audit patch. Transcript and numeric stats were not changed. This does not claim a complete historical repair of every NPC record.

The identity resolver now uses a new character's primary name as matching evidence instead of allowing its proposed aliases to identify a different existing character. Explicit IDs and previously saved canonical aliases continue to work.

## Party

Veil has no saved NPC party members. Membership itself is connected to canonical character saves and narrator context selection. Explicitly clearing a role previously fell back to the old role; null now survives both character saving and the server-to-browser projection.

## Plot Director

The planner hardcoded a 4,000-token provider allowance. Recent production calls ended at that limit with most tokens spent on reasoning. The planner now honors the configured allowance, while keeping the requested JSON draft compact. The saved Director allowance is now 16,384 tokens; production needs the new build before the planner will honor it.

The UI previously reused the narrator freshness filter to decide whether a historical frame existed. It now displays the stored frame with an Expired label and Previous spotlight when appropriate. Narration still excludes expired frames. No stale frame was activated and no new Veil frame was applied.

## Verification

- Full Vitest suite: 1,360 tests across 137 files passed.
- Svelte check: zero errors and zero warnings. Production build succeeded.
- Actual configured Director model: benign synthetic input returned a valid two-card frame, finish reason `stop`, with an outgoing allowance of 16,384 tokens.
- Browser: corrected Aurion biography, unsaved-stat notice, and expired Director history verified against the compiled preview.
- Disposable campaign: Charisma 16 persisted after reload; its canonical sheet resolves Persuasion to `1d20+3`. Party add, role save, role clear, reload, and removal were checked. Final canonical membership was false and role was null. The disposable database was removed.
- Both the repair patch and complete live story bootstrap were validated against the application contracts. Browser verification caught an invalid `from` field in the initial repair audit record; this was corrected to valid `test` operations preserving the old values before completing verification.

Evidence and repair scripts: `output/character-party-director-20260908/`. Qualified build: `E:/DEV/Builds/mtherios-controls-20260908`. Preview: `http://127.0.0.1:5174/`, using the live database with its background job worker disabled.

## Activation boundary

The narration setting, Director setting, and Aurion identity repair are live. The code changes remain in source and the qualified preview. Automatic approval review previously rejected installing the qualified build and restarting production with the stated reason `blocked by policy`; that blocked operation was not retried through another mechanism. Production remains on its earlier build.
