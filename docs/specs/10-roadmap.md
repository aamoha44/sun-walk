# 10 — Roadmap

Estimates assume one solo developer with agent assistance, working evenings.
Phases are gated: do not start the next one until the previous one's DoD passes.

---

## Phase A — Scaffolding (2–3 days)

Repo, types, store, tests, validators. **No graph.**

Definition of done:
- [ ] Vite + React + TypeScript project, strict mode, `npm run typecheck` clean
- [ ] `types.ts` copied to `src/domain/types.ts` and compiling
- [ ] `src/domain/geo.ts` with haversine, polyline length, point-to-segment
      projection, each with unit tests including a known-answer case
- [ ] `CampusStore` hydrating from a **hand-written 12-node fixture**, with
      `get`, `all`, `adjacency`, coalesced `emit`
- [ ] Dijkstra with a binary heap, routing over the fixture, with tests
- [ ] `scripts/validate-graph.py` running the structural gates (S1–S8) against
      the fixture and exiting 0
- [ ] CI green on an empty-ish repo

Rationale for building the validator before the data: the prototype built the
data first and the validator never ran.

---

## Phase B — Sources (3–5 days) — **DONE 2026-08-28** (D-001 resolved: accept ODbL)

Definition of done:
- [ ] `sources/service-area.geojson` drawn and committed
- [ ] `scripts/fetch-ufrm.py` pulls layer 10 (MC) and layer 0 (envelope-filtered),
      joins on `BLDG_CODE`, applies the duplicate policy, writes
      `sources/ufrm-facilities.geojson`, `sources/ufrm-footprints.geojson`,
      `sources/ufrm-duplicates.json`, `sources/rejected-features.json`
- [ ] `fetched == kept + rejected` asserted, non-zero exit on mismatch
- [ ] `(0,0)` features rejected with a reason, not filtered silently
- [ ] Footprint coverage verified: report the count of MC codes with and without
      a polygon (resolves D-006)
- [ ] `EditDate` / `ExtractDateTime` min/max/p50 recorded in the manifest, plus
      three manual spot-checks against reality
- [ ] `scripts/fetch-osm.py` clips a pinned Geofabrik extract to the service area
- [ ] `sources/manifest.json` complete with SHA-256 for every file

---

## Phase C — Builder (5–8 days). This is the hard phase.

Definition of done:
- [ ] `scripts/build-graph.py` implements stages 0–7 of `03-graph-pipeline.md`
- [ ] `build-graph.py --check` is byte-deterministic across two runs
- [ ] All ERROR gates in `04-validation-gates.md` pass
- [ ] Coverage: C1 ≥ 95%, C2 ≥ 90%, C3 = 0, C5 ≥ 25 km
- [ ] Route quality: R1 ≤ 1.30, R2 ≤ 1.45, R3 ≤ 3.00
- [ ] **G3 = 0 edges through footprints**
- [ ] `build/report.md` lists the provisional-entrance work queue ordered by gsf
- [ ] Dropped connected components each reviewed and either fixed or allowlisted
      with a written reason

Expect this phase to take longer than estimated. Noding and entrance projection
are where the real work is, and the first three graph builds will be wrong in
ways the gates will tell you about.

---

## Phase D — App (3–5 days)

Definition of done:
- [ ] Store hydrates from `build/graph.json` and `overlays/closures.json`
- [ ] Multi-entrance origin/destination search working; chosen door reported
- [ ] Typed `RouteResult`; every failure reason rendered as a distinct UI message
- [ ] Map sources all subscribe to the store; none set once at load
- [ ] `fitBounds` only on `activeRouteId` change; no camera move on graph toggle
- [ ] Building picker driven by UFRM `Type`, showing unroutable buildings greyed
      with a reason rather than hiding them
- [ ] Accessible profile selectable and producing a different route somewhere
      — a floor, not the finish line: at this point `requireAccessible` only
      excludes `stairs` edges, since `edge.accessible` is not yet populated
      from real data (T-034 series, Phase C.5/D backlog)
- [ ] Lighthouse PWA installable; works on a mid-range Android phone

---

## Phase E — Ground truth (ongoing; ≥2 weeks before soft launch)

The only phase that makes the graph trustworthy. It never finishes.

Definition of done for soft launch:
- [ ] PMTiles basemap self-hosted (D-004 resolved)
- [ ] 10 routes walked with a GPS trace recorded
- [ ] `scripts/trace-diff.py` comparing a GPX trace against the computed route,
      reporting max lateral deviation and length error
- [ ] Every deviation over 15 m turned into an `overlays/` edit
- [ ] `tests/fixtures/golden-routes.json` committed; gate R5 enabled
- [ ] Provisional entrances promoted to verified for the top 40 buildings by
      student traffic (not by gsf)
- [ ] "Report a problem" button live (D-008)
- [ ] 10–20 real freshmen or orientation volunteers using it

---

## Phase F — Differentiators (ongoing)

Ordered by defensibility, not by ease. **Accessibility ground-truth moved to
the top of this list** (repositioning, see `00-product-brief.md` "Problem" and
`08-decisions.md`): it was previously absent from this list entirely, tracked
only as a Phase D profile checkbox — that undersold it. It stays gated on data
the owner is collecting in person (D-010), not on more code.

1. **Accessible-entrance ground truth (D-010).** Walk/photograph doors campus-wide,
   record which are wheelchair-accessible (ramp, level threshold) vs not, and
   which crossings have real curb cuts. Land the survey through `overlays/`
   once T-034.1's schema support exists. This is the one differentiator that is
   entirely data-bound, not code-bound — the pipeline changes (T-034 series) can
   land before or independent of the survey, but the survey is what makes
   `walk-accessible` a real product claim instead of "excludes stairs."
2. **Schedule import.** Paste an ASU class schedule, get "next class" routing.
   This is the feature that makes the app a daily habit rather than a one-off.
3. **Shade routing surfaced in the UI** once `shadeIndex` is survey-backed for
   ≥60% of core edges (D-005).
4. **Entrance photos** from UFRM layer 0's `Image` field, shown at the final leg.
   The cheapest big win for the "familiarity" goal in the brief.
5. **Closures and construction**, student-reported, applied via runtime overlay.
6. **Selective indoor**, libraries and major lecture halls only, and only if a
   real data source appears. The MU and Hayden cut-throughs are genuinely useful
   and genuinely unavailable. Do not invent them.
7. **Camera / AR cues.** Last, because it competes directly with Google Live View
   and is the least defensible thing on this list.

---

## Risks

| Risk | Mitigation |
|---|---|
| Phase C takes three times the estimate | It is gated by objective numbers, so you will know where you are. Ship an honest smaller service area before a dishonest larger one |
| ODbL forces an architecture change late | Resolved 2026-08-28 (D-001, option A): graph ships under ODbL 1.0, UFRM attributes kept separate. No late architecture change |
| OSM coverage on campus is worse than expected | Phase B ends with a measured coverage number; if C5 cannot reach 25 km from OSM, that is a Phase-B finding, not a Phase-C surprise |
| Solo burnout | Phases A, B, D each end in something visible. Phase C does not, so break it into T-020…T-029 and land them individually |
| Building the graph and never validating it | This is what happened last time. The gates are not optional and the validator is written in Phase A, before there is data to validate |
