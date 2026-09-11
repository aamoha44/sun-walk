# 00 — Product brief

**Scope:** ASU Tempe (UFRM campus code `MC`) only.
**Builder model:** solo developer.
**Delivery:** PWA. No app store.

## Problem

Incoming students get lost on Tempe campus. Official sources publish building
centroids and little else. Google Maps routes outdoors but does not know which
door to use, which mall is the fast one, what is closed for construction, or what
class you are trying to get to. Indoor and entrance-level knowledge is where
general-purpose maps are weakest and where a campus-specific tool can win.

**For a student with a mobility disability, this is not an inconvenience — it is
a failure to route at all.** Every general-purpose map routes to a building
centroid and calls it done. It cannot tell a wheelchair user that the front door
is three steps up but the loading-dock entrance around the side is level; it
cannot tell them a "connected" path is a flight of stairs; it has no concept of
a curb cut, a ramp grade, or which specific door is the one they can actually
use. That gap is not a missing feature on top of an otherwise-working map — it
is the map not working for them, full stop, on the one axis where getting it
wrong means someone cannot get to class. **This is Sun Walk's differentiator.**
It is why entrances are ground-truthed doors on the footprint boundary, not a
building centroid (`08-decisions.md` 2026-08-27); why routing seeds a
multi-target search over every door instead of assuming one "the" entrance
(`05-routing-and-cost.md` §5); why stairs and ramps are separate edges with
separate, non-interchangeable costs instead of one blended "entrance" number;
and why an unroutable request returns a typed, honest reason instead of
silently failing (`05-routing-and-cost.md` §6, K-17). Every one of those
architectural choices exists because accessible routing is the product, not a
profile toggle bolted on afterward.

Shade is a real, second axis nobody else serves — a 600 m walk at 14:00 in
August across open concrete is a materially different experience from the same
distance under the Palm Walk canopy — and it stays designed into the cost
model from day one (`05-routing-and-cost.md`). But it is a comfort
differentiator; accessibility is an access differentiator. Ship the one that
determines whether someone can make the trip at all before polishing the one
that determines how pleasant it is.

## Product principles

1. **Accessible routing is the differentiator, not a profile.** Win on
   entrance-level accuracy — which specific door, whether it has stairs or a
   ramp, whether a crossing has a curb cut — before winning on Tempe knowledge,
   shade, or schedule context. Those stay real, secondary wins.
2. **Outdoor plus named entrances first.** Room-level indoor is out of scope
   until there is a real data source.
3. **Own the routable graph.** Pull upstream data where it is good, but the
   network we route over is ours, versioned, and correctable in minutes.
   (D-001 resolved 2026-08-28: the OSM-derived graph ships under ODbL 1.0 — "own"
   here means versioned and correctable, not proprietary. See `/NOTICE`.)
4. **Honest failure.** If we cannot route somewhere, say so and say why. Never
   render an empty map and let the student assume they typed something wrong.
5. **Solo-developer realistic.** Ship a trustworthy core-campus graph before any
   feature work.

## What "trustworthy" means, numerically

These are the acceptance targets for the rebuilt graph. The numbers in the
"prototype" column are measured from the discarded Phase-0 build and exist so
you can tell whether you are improving on it.

| Metric | Prototype | Target |
|---|---|---|
| Buildings in service area with ≥1 entrance | 61 / 277 (22%) | ≥ 95% |
| Buildings within 50 m of the graph | 32% | ≥ 90% |
| Detour ratio, median (graph dist ÷ straight line) | 1.50 | ≤ 1.30 |
| Detour ratio, p90 | 2.22 | ≤ 1.45 |
| Edges crossing a building footprint interior | 15+ known | 0 |
| Walkable centerline in the core | 6.2 km | ≥ 25 km |
| Connected components | 1 | 1 |
| Routes walked and GPS-verified | 0 | ≥ 10 before soft launch |

A pure Manhattan grid produces a median detour ratio of about 1.27, so 1.30 is
close to the floor for a real street-and-mall layout.

## Roadmap summary

Full detail and definitions of done are in `10-roadmap.md`.

- **Phase A — Scaffolding.** Repo, types, store, tests, validators, no graph.
- **Phase B — Sources.** UFRM footprints + facilities, OSM extract, manifest.
- **Phase C — Builder.** The real pedestrian graph. This is the hard phase.
- **Phase D — App.** Store, routing, MapLibre projection, PMTiles basemap.
- **Phase E — Ground truth.** Walk routes, diff GPS traces, write overlays.
  Never finishes.
- **Phase F — Accessibility, schedule, and shade.** The actual product
  differentiators, accessibility ground truth first.

## Explicitly out of scope

Other ASU campuses. Indoor room-level routing. Turn-by-turn voice. AR overlay.
Native apps. Accounts and sync. Anything before the graph passes its gates.

## Rejected data sources

- `tours.asu.edu` virtual tour — marketing imagery, no metric geometry or
  connectivity. Possible future source for entrance photos only.
- Google Maps Platform — cannot own the graph, per-view cost.
- Mapbox GL JS — polished but hosted, costed, and less control than MapLibre.
