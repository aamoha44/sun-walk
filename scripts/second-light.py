"""second-light -- first-light plus a field-work layer: which buildings still
need an in-person entrance survey.

Builds on T-025.5's first-light (scripts/first-light.py), whose GeoJSON
helpers this module reuses directly rather than re-deriving the same SQL.
Same throwaway-viewer contract: no src/ code, no store, disposable,
regenerate after every build-graph.py run.

The new thing: a yellow-pin layer at every routable building that has no
*specific* (ground-truthed) entrance yet -- every door the builder found for
it is provisional or weak (the 60/120 m projection ladder, 03-graph-pipeline.md
section 5.3), not a real OSM entrance=* tag or a promoted overlay. Sourced
from build/entrance-queue.json (the builder's own gsf-ordered work queue,
T-025's done-note), not recomputed -- one source of truth. This is the map to
carry into the field for the D-010 accessible-entrance survey
(the accessible-entrance ground-truth survey): every yellow pin is a building still worth a
visit.

    <spatialite-python> scripts/second-light.py [--db build/authoring.db] [--port 8001] [--no-serve]

Prefer `npm run second-light`, which finds the SpatiaLite-capable interpreter.
"""

from __future__ import annotations

import argparse
import functools
import http.server
import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from scripts.build.common import BUILD_DIR  # noqa: E402
from scripts.lib.db import connect  # noqa: E402

# first-light.py has a hyphen in its filename, so it can't be imported by
# name -- load it by path and reuse its GeoJSON helpers (same queries, one
# source of truth for the shared layers).
_spec = importlib.util.spec_from_file_location("_first_light", _REPO_ROOT / "scripts" / "first-light.py")
_first_light = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_first_light)

OUT_DIR = BUILD_DIR / "second-light"
MAPLIBRE_VERSION = "5.24.0"
PRECISION = 7

_QUEUE_LABEL = {
    "provisional": "no ground-truthed door (60 m projection)",
    "weak": "no ground-truthed door (120 m fallback, low confidence)",
    "no_walkway_within_120m": "unroutable -- no walkway found within 120 m",
}


def _entrance_gaps(con) -> dict:
    """Every building in build/entrance-queue.json, as a point layer."""
    queue_path = BUILD_DIR / "entrance-queue.json"
    queue = json.loads(queue_path.read_text(encoding="utf-8")) if queue_path.is_file() else []
    by_id = {row["building_id"]: row for row in queue}
    if not by_id:
        return _first_light._fc([])

    cols = "building_id, code, display_name, category, gsf, routable, unroutable_why"
    col_names = [c.strip() for c in cols.split(",")]
    feats = []
    for row in _first_light._rows(con, f"SELECT {cols}, AsGeoJSON(centroid, {PRECISION}) FROM building"):
        *vals, geom_json = row
        props = dict(zip(col_names, vals))
        q = by_id.get(props["building_id"])
        if not q:
            continue
        props["entrance_status"] = q["status"]
        props["entrance_status_label"] = _QUEUE_LABEL.get(q["status"], q["status"])
        props["doors_found"] = q.get("doors")
        feats.append(_first_light._feature(geom_json, props))
    return _first_light._fc(feats)


def export(db_path: Path) -> tuple[dict, dict]:
    con = connect(db_path)
    try:
        data = {
            "footprints": _first_light._footprints(con),
            "edges": _first_light._edges(con),
            "nodes": _first_light._nodes(con),
            "buildings": _first_light._buildings(con),
            "dropped": _first_light._dropped(),
            "entranceGaps": _entrance_gaps(con),
        }
        queue_path = BUILD_DIR / "entrance-queue.json"
        queue = json.loads(queue_path.read_text(encoding="utf-8")) if queue_path.is_file() else []
        by_status: dict[str, int] = {}
        for row in queue:
            by_status[row["status"]] = by_status.get(row["status"], 0) + 1
        meta = {
            "db": str(db_path),
            "generated": datetime.now(tz=timezone.utc).isoformat(),
            "bbox": _first_light._bbox(con),
            "counts": {k: len(v["features"]) for k, v in data.items()},
            "routable": con.execute("SELECT count(*) FROM building WHERE routable = 1").fetchone()[0],
            "totalBuildings": con.execute("SELECT count(*) FROM building").fetchone()[0],
            "entranceGapsByStatus": by_status,
        }
    finally:
        con.close()
    return data, meta


_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sun Walk - second light</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/__VER__/maplibre-gl.css">
<style>
  :root {
    --maroon:#8C1D40; --ink:#16130F; --ink-3:#7C746A; --paper:#FBF9F5;
    --card:#FFFFFF; --line:#E4DED3; --yellow:#F2C744;
    --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
    --ui:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  }
  html,body { margin:0; height:100%; font-family:var(--ui); color:var(--ink); }
  #map { position:absolute; inset:0; background:var(--paper); }
  .panel {
    position:absolute; top:12px; left:12px; z-index:2; background:var(--card);
    border:1px solid var(--line); border-radius:10px; padding:12px 14px;
    font-size:12.5px; max-width:280px; box-shadow:0 2px 10px rgba(0,0,0,.08);
  }
  .panel h1 { font-size:13px; margin:0 0 8px; color:var(--maroon);
    font-family:var(--mono); letter-spacing:.08em; text-transform:uppercase; }
  .panel label { display:flex; gap:7px; align-items:center; padding:3px 0; cursor:pointer; }
  .panel .meta { margin-top:9px; padding-top:9px; border-top:1px solid var(--line);
    color:var(--ink-3); font-family:var(--mono); font-size:11px; line-height:1.5; }
  .swatch { width:11px; height:11px; border-radius:3px; flex:none; }
  .pin-note { margin-top:9px; padding-top:9px; border-top:1px solid var(--line);
    font-size:11px; line-height:1.4; color:var(--ink-3); }
  .maplibregl-popup-content { font-family:var(--mono); font-size:11.5px; max-width:320px; }
  .maplibregl-popup-content dl { margin:0; display:grid; grid-template-columns:auto 1fr; gap:2px 10px; }
  .maplibregl-popup-content dt { color:var(--ink-3); }
  .maplibregl-popup-content dd { margin:0; overflow-wrap:anywhere; }
</style>
</head>
<body>
<div id="map"></div>
<div class="panel">
  <h1>Sun Walk &middot; second light</h1>
  <label><input type="checkbox" data-layer="footprints" checked><span class="swatch" style="background:#9E9486"></span>footprints</label>
  <label><input type="checkbox" data-layer="edges" checked><span class="swatch" style="background:#4A443C"></span>edges (path / steps / link)</label>
  <label><input type="checkbox" data-layer="nodes"><span class="swatch" style="background:#C8901A"></span>nodes (walkway / crossing / entrance)</label>
  <label><input type="checkbox" data-layer="buildings"><span class="swatch" style="background:#2F6B45"></span>building centroids</label>
  <label><input type="checkbox" data-layer="entranceGaps" checked><span class="swatch" style="background:#F2C744;border:1px solid #16130F"></span><strong>needs entrance survey</strong></label>
  <label><input type="checkbox" data-layer="dropped"><span class="swatch" style="background:#A32020"></span>dropped components</label>
  <div class="pin-note">Yellow pin = no ground-truthed door yet (D-010).
    Every builder-found entrance is a projected guess (60/120 m ladder), not a
    surveyed door. Click a pin for the building and its projection status.</div>
  <div class="meta" id="meta">loading&hellip;</div>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/__VER__/maplibre-gl.js"></script>
<script>
const map = new maplibregl.Map({
  container: "map",
  style: { version: 8, sources: {}, layers: [
    { id: "bg", type: "background", paint: { "background-color": "#FBF9F5" } }
  ] },
  center: [-111.9322, 33.4202], zoom: 15, dragRotate: false,
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
map.addControl(new maplibregl.ScaleControl({ unit: "metric" }));

const CLICKABLE = ["footprints-fill", "edges", "edges-link", "nodes", "buildings", "entrance-gaps-halo", "entrance-gaps", "dropped"];

Promise.all([
  fetch("./graph.geojson").then(r => r.json()),
  fetch("./meta.json").then(r => r.json()),
]).then(([g, meta]) => {
  for (const k of ["footprints", "edges", "nodes", "buildings", "dropped", "entranceGaps"]) {
    map.addSource(k, { type: "geojson", data: g[k] });
  }

  map.addLayer({ id: "footprints-fill", type: "fill", source: "footprints", paint: {
    "fill-color": ["match", ["get", "footprint_src"], "proxy", "#C8901A", "none", "#A32020", "#9E9486"],
    "fill-opacity": 0.12 } });
  map.addLayer({ id: "footprints-outline", type: "line", source: "footprints", paint: {
    "line-color": "#7C746A", "line-width": 0.8 } });

  map.addLayer({ id: "edges", type: "line", source: "edges",
    filter: ["!=", ["get", "type"], "link"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-width": ["interpolate", ["linear"], ["zoom"], 13, 0.8, 18, 2.4],
      "line-color": ["match", ["get", "type"],
        "steps", "#8C1D40", "crossing", "#C8901A", "plaza", "#2F6B45", "indoor", "#5B3C88", "#4A443C"] } });
  map.addLayer({ id: "edges-link", type: "line", source: "edges",
    filter: ["==", ["get", "type"], "link"],
    paint: { "line-color": "#2C4E7A", "line-width": 1, "line-dasharray": [2, 2] } });

  map.addLayer({ id: "nodes", type: "circle", source: "nodes",
    layout: { visibility: "none" },
    paint: { "circle-radius": ["match", ["get", "type"], "entrance", 4, "crossing", 3.5, 2],
    "circle-color": ["match", ["get", "type"],
      "entrance", ["case", ["==", ["get", "provisional"], 1], "#A32020", "#2F6B45"],
      "crossing", "#C8901A", "#7C746A"],
    "circle-stroke-color": "#FFFFFF", "circle-stroke-width": 0.6 } });

  map.addLayer({ id: "buildings", type: "circle", source: "buildings",
    layout: { visibility: "none" },
    paint: { "circle-radius": 5,
      "circle-color": ["case", ["==", ["get", "routable"], 1], "#2F6B45", "#A32020"],
      "circle-stroke-color": "#FFFFFF", "circle-stroke-width": 1.2 } });

  // Yellow pin layer: a soft halo plus a solid dot reads as a "pin" without a
  // sprite/glyph dependency -- first-light's own constraint (no symbol layers).
  map.addLayer({ id: "entrance-gaps-halo", type: "circle", source: "entranceGaps", paint: {
    "circle-radius": 12, "circle-color": "#F2C744", "circle-opacity": 0.28 } });
  map.addLayer({ id: "entrance-gaps", type: "circle", source: "entranceGaps", paint: {
    "circle-radius": ["match", ["get", "entrance_status"], "no_walkway_within_120m", 7, 5.5],
    "circle-color": "#F2C744",
    "circle-stroke-color": ["match", ["get", "entrance_status"], "no_walkway_within_120m", "#A32020", "#16130F"],
    "circle-stroke-width": 1.4 } });

  map.addLayer({ id: "dropped", type: "circle", source: "dropped",
    layout: { visibility: "none" },
    paint: { "circle-radius": 9, "circle-color": "#A32020", "circle-opacity": 0.06,
    "circle-stroke-color": "#A32020", "circle-stroke-width": 2 } });

  if (meta.bbox) map.fitBounds([[meta.bbox[0], meta.bbox[1]], [meta.bbox[2], meta.bbox[3]]], { padding: 48, duration: 0 });

  const c = meta.counts || {};
  const gaps = meta.entranceGapsByStatus || {};
  document.getElementById("meta").innerHTML =
    `${meta.routable||0}/${meta.totalBuildings||0} buildings routable<br>` +
    `<strong>${c.entranceGaps||0} need a specific entrance</strong><br>` +
    Object.entries(gaps).map(([k,v]) => `&nbsp;&nbsp;${v} ${k}`).join("<br>") +
    `<br>${c.edges||0} edges &middot; ${c.nodes||0} nodes<br>` +
    `built ${(meta.generated||"?").slice(0,16).replace("T"," ")}Z`;

  for (const box of document.querySelectorAll("input[data-layer]")) {
    box.addEventListener("change", () => {
      const on = box.checked ? "visible" : "none";
      const ids = { footprints: ["footprints-fill", "footprints-outline"], edges: ["edges", "edges-link"],
        nodes: ["nodes"], buildings: ["buildings"], entranceGaps: ["entrance-gaps-halo", "entrance-gaps"],
        dropped: ["dropped"] }[box.dataset.layer];
      ids.forEach(id => map.setLayoutProperty(id, "visibility", on));
    });
  }
});

map.on("click", (e) => {
  const hit = map.queryRenderedFeatures(e.point, { layers: CLICKABLE.filter(id => map.getLayer(id)) })[0];
  if (!hit) return;
  const rows = Object.entries(hit.properties)
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  new maplibregl.Popup({ maxWidth: "340px" }).setLngLat(e.lngLat)
    .setHTML(`<strong>${hit.layer.id}</strong><dl>${rows}</dl>`).addTo(map);
});
map.on("mouseenter", "entrance-gaps", () => map.getCanvas().style.cursor = "pointer");
map.on("mouseleave", "entrance-gaps", () => map.getCanvas().style.cursor = "");
</script>
</body>
</html>
"""


def write_viewer(data: dict, meta: dict) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "graph.geojson").write_text(json.dumps(data), encoding="utf-8")
    (OUT_DIR / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    (OUT_DIR / "index.html").write_text(_HTML.replace("__VER__", MAPLIBRE_VERSION), encoding="utf-8")


def serve(port: int) -> None:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(OUT_DIR))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    print(f"\nsecond light: http://127.0.0.1:{port}/   (Ctrl+C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")
    finally:
        httpd.server_close()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="first-light plus the entrance-survey gap layer.")
    ap.add_argument("--db", type=Path, default=BUILD_DIR / "authoring.db")
    ap.add_argument("--port", type=int, default=8001)
    ap.add_argument("--no-serve", action="store_true", help="write build/second-light/ and exit")
    args = ap.parse_args(argv)

    if not Path(args.db).exists():
        raise SystemExit(f"{args.db} not found -- run build-graph.py first.")

    data, meta = export(args.db)
    write_viewer(data, meta)
    print(json.dumps({"out": str(OUT_DIR), "counts": meta["counts"],
                       "routable": meta["routable"], "entranceGapsByStatus": meta["entranceGapsByStatus"]},
                      indent=2))
    if not args.no_serve:
        serve(args.port)
    return 0


if __name__ == "__main__":
    sys.exit(main())
