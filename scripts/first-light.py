"""first-light — a throwaway map view of the graph in build/authoring.db.

T-025.5. Reads the final `node` / `edge` / `building` / `footprint` / `entrance`
tables, exports them as GeoJSON, and writes a self-contained MapLibre page to
`build/first-light/`. Not the real map (that is T-050) — no `src/` code, no
store, deliberately disposable. It exists to *look* at the builder's output and
to eyeball gate G3 (edges through footprints) before T-029 automates it.

    <spatialite-python> scripts/first-light.py [--db build/authoring.db] [--port 8000] [--no-serve]

Prefer `npm run first-light`, which finds the SpatiaLite-capable interpreter.
Requires `C:\\msys64\\ucrt64\\bin\\python3.exe` (mod_spatialite). Regenerate
after every `build-graph.py` run — it is a snapshot of whatever service area was
last built.
"""

from __future__ import annotations

import argparse
import functools
import http.server
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from scripts.build.common import BUILD_DIR  # noqa: E402
from scripts.lib.db import connect  # noqa: E402

OUT_DIR = BUILD_DIR / "first-light"
MAPLIBRE_VERSION = "5.24.0"
PRECISION = 7


def _feature(geom_json: str, props: dict) -> dict:
    return {
        "type": "Feature",
        "geometry": json.loads(geom_json),
        "properties": {k: v for k, v in props.items() if v is not None and v != ""},
    }


def _fc(features: list[dict]) -> dict:
    return {"type": "FeatureCollection", "features": features}


def _rows(con, sql: str) -> list[tuple]:
    return con.execute(sql).fetchall()


def _edges(con) -> dict:
    cols = (
        "edge_id, type, name, length_m, surface, stairs, step_count, covered, "
        "tunnel, bridge, layer, accessible, shade_index, shade_source, synthetic, osm_way_id"
    )
    names = [c.strip() for c in cols.split(",")]
    feats = [
        _feature(row[-1], dict(zip(names, row[:-1])))
        for row in _rows(con, f"SELECT {cols}, AsGeoJSON(geom, {PRECISION}) FROM edge")
    ]
    return _fc(feats)


def _nodes(con) -> dict:
    cols = (
        "n.node_id, n.type, n.osm_node_id, n.building_id, n.provisional, n.weak, "
        "n.signalized, n.cross_kind, e.ordinal AS entrance_ordinal, e.snap_m, e.side"
    )
    names = [c.split(" AS ")[-1].strip().split(".")[-1] for c in cols.split(",")]
    feats = [
        _feature(row[-1], dict(zip(names, row[:-1])))
        for row in _rows(
            con,
            f"SELECT {cols}, AsGeoJSON(n.geom, {PRECISION}) "
            "FROM node n LEFT JOIN entrance e ON e.node_id = n.node_id",
        )
    ]
    return _fc(feats)


def _footprints(con) -> dict:
    cols = (
        "f.footprint_id, f.code, f.area_m2, b.building_id, b.display_name, "
        "b.category, b.routable, b.footprint_src, b.unroutable_why"
    )
    names = [c.strip().split(".")[-1] for c in cols.split(",")]
    feats = [
        _feature(row[-1], dict(zip(names, row[:-1])))
        for row in _rows(
            con,
            f"SELECT {cols}, AsGeoJSON(f.geom, {PRECISION}) "
            "FROM footprint f LEFT JOIN building b ON b.footprint_id = f.footprint_id",
        )
    ]
    return _fc(feats)


def _buildings(con) -> dict:
    cols = (
        "building_id, code, display_name, category, routable, unroutable_why, "
        "gsf, footprint_src, in_service_area"
    )
    names = [c.strip() for c in cols.split(",")]
    feats = [
        _feature(row[-1], dict(zip(names, row[:-1])))
        for row in _rows(con, f"SELECT {cols}, AsGeoJSON(centroid, {PRECISION}) FROM building")
    ]
    return _fc(feats)


def _dropped() -> dict:
    path = BUILD_DIR / "components-dropped.json"
    if not path.is_file():
        return _fc([])
    feats = []
    for i, c in enumerate(json.loads(path.read_text(encoding="utf-8"))):
        cx, cy = c["bbox_centre"]
        feats.append(
            _feature(
                json.dumps({"type": "Point", "coordinates": [cx, cy]}),
                {"idx": i, "nodes": c.get("nodes"), "edges": c.get("edges"), "length_m": c.get("length_m")},
            )
        )
    return _fc(feats)


def _bbox(con):
    row = con.execute(
        "SELECT min(MbrMinX(geom)), min(MbrMinY(geom)), max(MbrMaxX(geom)), max(MbrMaxY(geom)) FROM edge"
    ).fetchone()
    return list(row) if row and row[0] is not None else [-111.9365, 33.4155, -111.928, 33.4248]


def export(db_path: Path) -> tuple[dict, dict]:
    con = connect(db_path)
    try:
        data = {
            "footprints": _footprints(con),
            "edges": _edges(con),
            "nodes": _nodes(con),
            "buildings": _buildings(con),
            "dropped": _dropped(),
        }
        meta = {
            "db": str(db_path),
            "db_mtime": datetime.fromtimestamp(Path(db_path).stat().st_mtime, tz=timezone.utc).isoformat()
            if Path(db_path).exists()
            else None,
            "generated": datetime.now(tz=timezone.utc).isoformat(),
            "bbox": _bbox(con),
            "counts": {k: len(v["features"]) for k, v in data.items()},
            "edge_types": dict(con.execute("SELECT type, count(*) FROM edge GROUP BY type")),
            "node_types": dict(con.execute("SELECT type, count(*) FROM node GROUP BY type")),
            "footprint_src": dict(con.execute("SELECT footprint_src, count(*) FROM building GROUP BY footprint_src")),
            "routable": con.execute("SELECT count(*) FROM building WHERE routable = 1").fetchone()[0],
        }
    finally:
        con.close()
    return data, meta


_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sun Walk - first light</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/__VER__/maplibre-gl.css">
<style>
  :root {
    --maroon:#8C1D40; --ink:#16130F; --ink-3:#7C746A; --paper:#FBF9F5;
    --card:#FFFFFF; --line:#E4DED3;
    --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
    --ui:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  }
  html,body { margin:0; height:100%; font-family:var(--ui); color:var(--ink); }
  #map { position:absolute; inset:0; background:var(--paper); }
  .panel {
    position:absolute; top:12px; left:12px; z-index:2; background:var(--card);
    border:1px solid var(--line); border-radius:10px; padding:12px 14px;
    font-size:12.5px; max-width:260px; box-shadow:0 2px 10px rgba(0,0,0,.08);
  }
  .panel h1 { font-size:13px; margin:0 0 8px; color:var(--maroon);
    font-family:var(--mono); letter-spacing:.08em; text-transform:uppercase; }
  .panel label { display:flex; gap:7px; align-items:center; padding:3px 0; cursor:pointer; }
  .panel .meta { margin-top:9px; padding-top:9px; border-top:1px solid var(--line);
    color:var(--ink-3); font-family:var(--mono); font-size:11px; line-height:1.5; }
  .swatch { width:11px; height:11px; border-radius:3px; flex:none; }
  .maplibregl-popup-content { font-family:var(--mono); font-size:11.5px; max-width:320px; }
  .maplibregl-popup-content dl { margin:0; display:grid; grid-template-columns:auto 1fr; gap:2px 10px; }
  .maplibregl-popup-content dt { color:var(--ink-3); }
  .maplibregl-popup-content dd { margin:0; overflow-wrap:anywhere; }
</style>
</head>
<body>
<div id="map"></div>
<div class="panel">
  <h1>Sun Walk &middot; first light</h1>
  <label><input type="checkbox" data-layer="footprints" checked><span class="swatch" style="background:#9E9486"></span>footprints</label>
  <label><input type="checkbox" data-layer="edges" checked><span class="swatch" style="background:#4A443C"></span>edges (path / steps / link)</label>
  <label><input type="checkbox" data-layer="nodes" checked><span class="swatch" style="background:#C8901A"></span>nodes (walkway / crossing / entrance)</label>
  <label><input type="checkbox" data-layer="buildings"><span class="swatch" style="background:#2F6B45"></span>building centroids</label>
  <label><input type="checkbox" data-layer="dropped" checked><span class="swatch" style="background:#A32020"></span>dropped components</label>
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

const CLICKABLE = ["footprints-fill", "edges", "edges-link", "nodes", "buildings", "dropped"];

Promise.all([
  fetch("./graph.geojson").then(r => r.json()),
  fetch("./meta.json").then(r => r.json()),
]).then(([g, meta]) => {
  for (const k of ["footprints", "edges", "nodes", "buildings", "dropped"]) {
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

  map.addLayer({ id: "nodes", type: "circle", source: "nodes", paint: {
    "circle-radius": ["match", ["get", "type"], "entrance", 4, "crossing", 3.5, 2],
    "circle-color": ["match", ["get", "type"],
      "entrance", ["case", ["==", ["get", "provisional"], 1], "#A32020", "#2F6B45"],
      "crossing", "#C8901A", "#7C746A"],
    "circle-stroke-color": "#FFFFFF", "circle-stroke-width": 0.6 } });

  map.addLayer({ id: "buildings", type: "circle", source: "buildings",
    layout: { visibility: "none" },
    paint: { "circle-radius": 5,
      "circle-color": ["case", ["==", ["get", "routable"], 1], "#2F6B45", "#A32020"],
      "circle-stroke-color": "#FFFFFF", "circle-stroke-width": 1.2 } });

  map.addLayer({ id: "dropped", type: "circle", source: "dropped", paint: {
    "circle-radius": 9, "circle-color": "#A32020", "circle-opacity": 0.06,
    "circle-stroke-color": "#A32020", "circle-stroke-width": 2 } });

  if (meta.bbox) map.fitBounds([[meta.bbox[0], meta.bbox[1]], [meta.bbox[2], meta.bbox[3]]], { padding: 48, duration: 0 });

  const c = meta.counts || {};
  document.getElementById("meta").innerHTML =
    `${c.edges||0} edges &middot; ${c.nodes||0} nodes<br>` +
    `${c.footprints||0} footprints &middot; ${meta.routable||0}/${c.buildings||0} routable<br>` +
    `${(c.dropped||0)} dropped components<br>` +
    `built ${(meta.db_mtime||"?").slice(0,16).replace("T"," ")}Z`;

  for (const box of document.querySelectorAll("input[data-layer]")) {
    box.addEventListener("change", () => {
      const on = box.checked ? "visible" : "none";
      const ids = { footprints: ["footprints-fill", "footprints-outline"], edges: ["edges", "edges-link"],
        nodes: ["nodes"], buildings: ["buildings"], dropped: ["dropped"] }[box.dataset.layer];
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
map.on("mouseenter", "edges", () => map.getCanvas().style.cursor = "pointer");
map.on("mouseleave", "edges", () => map.getCanvas().style.cursor = "");
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
    print(f"\nfirst light: http://127.0.0.1:{port}/   (Ctrl+C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")
    finally:
        httpd.server_close()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Throwaway MapLibre view of build/authoring.db (T-025.5).")
    ap.add_argument("--db", type=Path, default=BUILD_DIR / "authoring.db")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-serve", action="store_true", help="write build/first-light/ and exit")
    args = ap.parse_args(argv)

    if not Path(args.db).exists():
        raise SystemExit(f"{args.db} not found — run build-graph.py first.")

    data, meta = export(args.db)
    write_viewer(data, meta)
    print(json.dumps({"out": str(OUT_DIR), **meta["counts"], "routable": meta["routable"]}, indent=2))
    if not args.no_serve:
        serve(args.port)
    return 0


if __name__ == "__main__":
    sys.exit(main())
