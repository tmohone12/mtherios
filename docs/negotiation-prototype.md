# Grain-for-concession negotiation prototype

An isolated, fixture-driven vertical slice. It is unregistered in production and disabled unless each step explicitly supplies `enabled: true`. No routes, jobs, migrations, provider settings, database imports, or campaign writes are added.

Run from the MythEngine checkout:

```powershell
node src/lib/server/factions/negotiationPrototype.demo.ts
npm test -- src/lib/server/factions/negotiationPrototype.test.ts
```

## Example trace

| Day | Established development | League inventory / reserved | Regency inventory |
| --- | --- | --- | --- |
| 0 | League offers 40 grain for 20 days of toll exemption. | 100 / 0 | 10 |
| 1 | Regency counters: 40 grain for 10 days. | 100 / 0 | 10 |
| 2 | League accepts. Delivery is due on day 4; exemption is conditional on delivery. | 100 / 40 | 10 |
| 3 | Wagons remain in transit. No new decision or completed delivery. | 100 / 40 | 10 |
| 4 | Grain arrives. Supplier promise is fulfilled; exemption starts and ends on day 14. | 60 / 0 | 50 |
| 14 | Exemption ends. Recipient obligation is fulfilled; grain and agreement history persist. | 60 / 0 | 50 |

These choices come from named fixtures, not tested live model behavior. No paid or local inference is performed.

## Boundaries

- `negotiationActorPacket` contains only the acting party's goals, beliefs, inventory, authority, obligations and directly received negotiation events. The counterparty contributes identity only. Beliefs can be wrong; public visibility alone does not establish knowledge. The route constraint stays outside both model packets.
- A planning adapter returns at most four narrowly typed proposals, with source IDs from that packet. Code validates the terms, phase, references and known actor authority. Code supplies wait, investigate and refuse, then passes bounded choices through the existing `chooseJevOption` input/output types.
- A later real decision adapter can close over an explicitly chosen profile/model and call `chooseJevOption`. A real planning adapter can serialize the supplied prompt and packet through the existing text provider. Neither adapter is implemented or enabled here. Runtime import is limited to existing Zod; provider contracts are type-only imports.
- Confidence qualifies a selected choice. It does not establish success or become a success probability. Invalid output, rejection, timeout and abstention hold position. Investigation records an attempt and learns nothing automatically.
- Code rechecks inventory and concession authority before binding agreement. Grain is reserved until the explicit delivery day. A sourced blocked route yields failed delivery, releases reserved grain, breaks the supplier promise, and releases the conditional concession. It does not fabricate betrayal.
- The in-memory ledger separates secret bargaining from public physical consequences. `negotiationPresentationCues` returns only recorded local effects, omitting the secret bargain and route cause. It is a pure presentation boundary suitable for a future Director adapter; this prototype does not call the production Plot Brain.
- Steps have IDs, revisions and monotonic explicit days. A repeated command returns its saved receipt without another decision or settlement. Reusing an ID for a different actor/day is rejected. Each call returns a new validated snapshot and never mutates the caller's snapshot.

## Deliberate limits

This is one two-party toll-exemption scenario, not a general diplomatic framework. The council obligation is enforced through a numeric authority cap; arbitrary prose obligations are context, not executable law. Evidence-ID checks establish provenance membership, not semantic proof that a proposal is wise. Delivery travel is fixed at two days in the fixture; unanswered offers expire after three days. The route flag is a sourced sandbox constraint, not a simulated war or stochastic outcome.

Snapshots and event receipts are in memory, with no canonical database writer. Revision checks protect sequential use of a snapshot; a future persistence integration must use the existing transactional writer/locking path. The demo prints JSON to stdout; it does not save campaign state.

No campaign-wide policy for offscreen wars, time skips or intervention windows is selected. No production artifact build or restart is needed because nothing imports this prototype into the application.
