#!/usr/bin/env python3
"""Regenerate img/world-mini.svg: a Winkel-Tripel dot-matrix world map.

This is a DEV-TIME tool (unlike tools/update_leaderboard.py, it needs pyproj /
shapely / cartopy and is NOT run in CI). It draws the world's land in a true
Winkel-Tripel projection, lays a regular pixel grid over it, and emits one small
<circle> per land cell — a precise, programmatic replacement for the old map that
was traced from a JPG.

It also classifies each emitted dot into one of the six continents the app cares
about (using Natural Earth's admin-0 `CONTINENT` attribute) and prints a
copy-paste-ready CONTINENT_POS block for assets/score-app.js, where percentage
chips float over the map.

Render contract this MUST preserve (consumed by style.css + score-app.js):
  - viewBox stays "0 0 1198 653"  (style.css `.continent-map { aspect-ratio }`)
  - <style>circle{r:3.0px}</style> + a single <g fill="#f6f3ea"> of <circle>s
  - dots sorted row-major (cy, then cx) for stable diffs

Data: Natural Earth shapefiles from cartopy's local cache (offline-safe at 110m).

Usage (from the repo root, in the conda env with the geo stack):
    conda run -n genotox python tools/gen_dotmap.py
    conda run -n genotox python tools/gen_dotmap.py --spacing 9 --resolution 50m
"""

import argparse
from pathlib import Path

import cartopy.io.shapereader as shpreader
import numpy as np
import shapely
from pyproj import CRS, Transformer
from shapely.geometry import box
from shapely.ops import transform as shp_transform, unary_union
from shapely.prepared import prep

REPO_ROOT = Path(__file__).resolve().parent.parent

# The six continent buckets the app uses (geographic; Natural Earth already files
# Australia under "Oceania", matching TEAM_CONTINENT in bracket-data.js).
APP_CONTINENTS = ["North America", "South America", "Europe", "Africa", "Asia", "Oceania"]

WINKEL_TRIPEL = CRS.from_proj4("+proj=wintri")
WGS84 = CRS.from_epsg(4326)


def parse_args():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--resolution", choices=["110m", "50m"], default="110m",
                   help="Natural Earth resolution (110m is offline-safe; 50m needs the cache).")
    p.add_argument("--spacing", type=int, default=10,
                   help="Dot grid pitch in viewBox pixels (smaller = denser).")
    p.add_argument("--lat-min", type=float, default=-60.0,
                   help="Clip land below this latitude (drops Antarctica).")
    p.add_argument("--lon-min", type=float, default=-169.0,
                   help="Clip land west of this longitude. Default -169 drops the "
                        "antimeridian-wrapped sliver of far-east Russia (a lone dot "
                        "near -180 that otherwise stretches the bbox and shrinks the "
                        "whole map); no real land is lost (Alaska is east of -165).")
    p.add_argument("--viewbox-w", type=int, default=1198,
                   help="viewBox width (px). The HEIGHT is derived from the land's "
                        "true projected aspect so the map is cropped tight to content.")
    p.add_argument("--pad", type=int, default=6,
                   help="Uniform margin (px) around the land inside the viewBox.")
    p.add_argument("--radius", type=float, default=3.0, help="Circle radius (px).")
    p.add_argument("--color", default="#f6f3ea", help="Dot fill color.")
    p.add_argument("--output", default=str(REPO_ROOT / "img" / "world-mini.svg"))
    p.add_argument("--emit-pos-json", action="store_true",
                   help="Also print CONTINENT_POS as JSON.")
    return p.parse_args()


def _to_wintri(geom):
    """Project a lon/lat shapely geometry into Winkel-Tripel meters."""
    tf = Transformer.from_crs(WGS84, WINKEL_TRIPEL, always_xy=True)
    # shapely.ops.transform calls func(xs, ys[, zs]); accept extra positional
    # args so the callable matches the 3-arg signature it may be invoked with.
    return shp_transform(lambda xs, ys, *args: tf.transform(xs, ys), geom)


def load_land_union(resolution, lat_min, lon_min):
    """Natural Earth land, Antarctica + antimeridian sliver clipped, projected."""
    path = shpreader.natural_earth(resolution=resolution, category="physical", name="land")
    geoms = [rec.geometry for rec in shpreader.Reader(path).records()]
    land = unary_union(geoms)
    # Clip in lon/lat space (a clean rectangular cut) before projecting.
    land = land.intersection(box(lon_min, lat_min, 180.0, 90.0))
    return _to_wintri(land)


def load_continent_unions(resolution, lat_min, lon_min):
    """Per-continent projected unions, keyed by the app's six bucket names."""
    path = shpreader.natural_earth(resolution=resolution, category="cultural",
                                   name="admin_0_countries")
    by_cont = {name: [] for name in APP_CONTINENTS}
    for rec in shpreader.Reader(path).records():
        cont = str(rec.attributes.get("CONTINENT") or "")
        if cont in by_cont:
            by_cont[cont].append(rec.geometry)
    clip = box(lon_min, lat_min, 180.0, 90.0)
    out = {}
    for name, geoms in by_cont.items():
        if not geoms:
            continue
        merged = unary_union(geoms).intersection(clip)
        out[name] = _to_wintri(merged)
    return out


def compute_fit(bounds, vb_w, pad):
    """Scale + offset for a viewBox cropped tight to the projected land bbox.

    The viewBox width is fixed (vb_w, a stable coordinate anchor) and its HEIGHT
    is derived from the land's true Winkel-Tripel aspect, so the dots fill the box
    edge-to-edge with only a uniform `pad`-px margin — no letterbox bands. Returns
    (scale, off_x, off_y, x_min, y_max, vb_h).
    """
    x_min, y_min, x_max, y_max = bounds
    land_w = x_max - x_min
    land_h = y_max - y_min
    scale = (vb_w - 2 * pad) / land_w
    vb_h = int(round(land_h * scale + 2 * pad))
    off_x = pad
    off_y = pad
    return scale, off_x, off_y, x_min, y_max, vb_h


def px_to_proj(px, py, fit):
    """Inverse of the pixel mapping: viewBox px -> projected meters (Y flipped)."""
    scale, off_x, off_y, x_min, y_max = fit[:5]
    X = x_min + (px - off_x) / scale
    Y = y_max - (py - off_y) / scale
    return X, Y


def generate_dots(land_proj, fit, vb_w, vb_h, spacing):
    """A row-major list of (cx, cy) integer dot centers over land."""
    cols = np.arange(spacing // 2, vb_w, spacing)
    rows = np.arange(spacing // 2, vb_h, spacing)
    gx, gy = np.meshgrid(cols, rows)            # pixel grid
    gx = gx.ravel()
    gy = gy.ravel()
    Xs, Ys = px_to_proj(gx.astype(float), gy.astype(float), fit)
    mask = shapely.contains_xy(land_proj, Xs, Ys)
    dots = [(int(x), int(y)) for x, y in zip(gx[mask], gy[mask])]
    dots.sort(key=lambda d: (d[1], d[0]))       # row-major: cy, then cx
    return dots


def trim_outliers(tagged, spacing, gap_cells=4):
    """Drop isolated edge dots so the viewBox can crop tight to the main cloud.

    Tiny far-flung land (e.g. Hawaii, sitting ~100px west of the mainland in the
    projection) would otherwise stretch the bounding box and leave a blank gap.
    Any leading/trailing grid column or row separated from its neighbour by more
    than `gap_cells` empty cells is pruned — a geography-agnostic "crop to
    content" that also catches any future stray speck.
    """
    gap = gap_cells * spacing

    def keep_range(vals):
        vals = sorted(set(vals))
        lo, hi = 0, len(vals) - 1
        while lo < hi and vals[lo + 1] - vals[lo] > gap:
            lo += 1
        while hi > lo and vals[hi] - vals[hi - 1] > gap:
            hi -= 1
        return vals[lo], vals[hi]

    x_lo, x_hi = keep_range(cx for cx, _, _ in tagged)
    y_lo, y_hi = keep_range(cy for _, cy, _ in tagged)
    return [(cx, cy, c) for cx, cy, c in tagged if x_lo <= cx <= x_hi and y_lo <= cy <= y_hi]


def classify_dots(dots, fit, cont_unions):
    """Tag each dot with its continent (or None), tested in projected space."""
    prepared = {name: prep(geom) for name, geom in cont_unions.items()}
    from shapely.geometry import Point
    tagged = []
    for cx, cy in dots:
        X, Y = px_to_proj(float(cx), float(cy), fit)
        pt = Point(X, Y)
        cont = None
        for name, pg in prepared.items():
            if pg.contains(pt):
                cont = name
                break
        tagged.append((cx, cy, cont))
    return tagged


def continent_positions(tagged, vb_w, vb_h):
    """Mean dot position per continent, as viewBox-% {left, top}."""
    sums = {name: [0.0, 0.0, 0] for name in APP_CONTINENTS}  # sx, sy, count
    for cx, cy, cont in tagged:
        if cont in sums:
            s = sums[cont]
            s[0] += cx
            s[1] += cy
            s[2] += 1
    pos = {}
    for name in APP_CONTINENTS:
        s = sums.get(name)
        if not s or s[2] == 0:
            continue
        left = round(s[0] / s[2] / vb_w * 100)
        top = round(s[1] / s[2] / vb_h * 100)
        pos[name] = {"left": left, "top": top}
    return pos


def recrop(tagged, pad):
    """Shift tagged dots so the content sits at `pad` from the origin, and return
    (shifted_tagged, vb_w, vb_h) cropped tight to the dot cloud on both axes."""
    xs = [cx for cx, _, _ in tagged]
    ys = [cy for _, cy, _ in tagged]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    shifted = [(cx - min_x + pad, cy - min_y + pad, cont) for cx, cy, cont in tagged]
    vb_w = max_x - min_x + 2 * pad
    vb_h = max_y - min_y + 2 * pad
    return shifted, vb_w, vb_h


def render_svg(dots, vb_w, vb_h, radius, color):
    circles = "".join(f'<circle cx="{cx}" cy="{cy}"/>' for cx, cy in dots)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {vb_w} {vb_h}" '
        'role="img" aria-label="World map (dot matrix)">\n'
        "  <!-- Dot-matrix world map, Winkel-Tripel projection, generated by "
        "tools/gen_dotmap.py from Natural Earth land. Decorative backdrop for the "
        '"Title picks by continent" card; chalk dots, opacity set in CSS. -->\n'
        f"  <style>circle{{r:{radius}px}}</style>"
        f'<g fill="{color}">{circles}</g>\n'
        "</svg>\n"
    )


def format_continent_pos_block(pos):
    lines = ["  const CONTINENT_POS = {"]
    rows = []
    for name in APP_CONTINENTS:
        if name in pos:
            rows.append(f'    "{name}":{" " * (16 - len(name))}'
                        f'{{ left: {pos[name]["left"]}, top: {pos[name]["top"]} }}')
    lines.append(",\n".join(rows))
    lines.append("  };")
    return "\n".join(lines)


def write_if_changed(path, content):
    p = Path(path)
    if p.exists() and p.read_text(encoding="utf-8") == content:
        print(f"no change: {p}")
        return False
    p.write_text(content, encoding="utf-8")
    print(f"wrote: {p}")
    return True


def main():
    args = parse_args()
    print(f"resolution={args.resolution} spacing={args.spacing}px "
          f"lat_min={args.lat_min} lon_min={args.lon_min}")

    land_proj = load_land_union(args.resolution, args.lat_min, args.lon_min)
    cont_unions = load_continent_unions(args.resolution, args.lat_min, args.lon_min)

    # An over-tall scratch viewBox to sample on; the real box is cropped to the
    # surviving dots below, so this height just needs to be generous.
    fit = compute_fit(land_proj.bounds, args.viewbox_w, args.pad)
    raw = generate_dots(land_proj, fit, args.viewbox_w, fit[5], args.spacing)

    # Classify (in projected space, before any re-crop shift), then trim isolated
    # edge specks (e.g. Hawaii) and crop the viewBox tight to what remains.
    tagged = classify_dots(raw, fit, cont_unions)
    n_before = len(tagged)
    tagged = trim_outliers(tagged, args.spacing)
    tagged, vb_w, vb_h = recrop(tagged, args.pad)
    dropped = n_before - len(tagged)
    print(f"{len(tagged)} dots (trimmed {dropped}) · viewBox {vb_w}x{vb_h} "
          f"(aspect {vb_w / vb_h:.3f})")

    dots = [(cx, cy) for cx, cy, _ in tagged]
    svg = render_svg(dots, vb_w, vb_h, args.radius, args.color)
    write_if_changed(args.output, svg)

    pos = continent_positions(tagged, vb_w, vb_h)
    print("\n--- paste over CONTINENT_POS in assets/score-app.js ---")
    print(format_continent_pos_block(pos))
    print(f"\n--- update style.css `.continent-map`: aspect-ratio: {vb_w} / {vb_h}; ---")
    if args.emit_pos_json:
        import json
        print("\nJSON:", json.dumps(pos))


if __name__ == "__main__":
    main()
