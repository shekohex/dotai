#!/usr/bin/env python3
"""Build and validate manifest-driven RGBA orb sprite sheets."""

from __future__ import annotations

import argparse
from collections import deque
import json
from pathlib import Path
import re
from statistics import median
import sys
from typing import Any


KEY = (255, 0, 255)
REQUIRED_STATES = (
    "idle",
    "syncing",
    "listening",
    "talking",
    "thinking",
    "working",
    "checkingSubagents",
    "waiting",
    "success",
    "failure",
    "muted",
    "ending",
)
MAX_GRID_AXIS = 32
MAX_FRAME_COUNT = 1024
MAX_SHEET_AXIS = 4096
MAX_SHEET_PIXELS = 16 * 1024 * 1024
MIN_CELL_AXIS = 32
MAX_CELL_AXIS = 2048


def die(message: str) -> None:
    raise SystemExit(f"Error: {message}")


def load_pillow():
    try:
        from PIL import Image
    except ImportError:
        die(
            "Pillow is required. Run with `uv run --with-requirements "
            "scripts/requirements.txt python scripts/orb_sheet.py ...`."
        )
    return Image


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        die(f"cannot read JSON {path}: {error}")
    if not isinstance(value, dict):
        die(f"JSON root must be an object: {path}")
    return value


def write_json(path: Path, value: dict[str, Any], force: bool) -> None:
    if path.exists() and not force:
        die(f"output already exists: {path} (use --force)")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def read_pack(path: Path, pack_id: str | None = None) -> dict[str, Any]:
    value = read_json(path)
    if "packs" not in value:
        return value
    packs = value.get("packs")
    if not isinstance(packs, list) or not pack_id:
        die("catalog input requires --pack-id")
    matches = [pack for pack in packs if isinstance(pack, dict) and pack.get("id") == pack_id]
    if len(matches) != 1:
        die(f"catalog must contain exactly one pack with id {pack_id!r}")
    return matches[0]


def positive_int(value: Any, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        die(f"{label} must be a positive integer")
    return value


def validate_grid(columns: int, rows: int, cell_width: int, cell_height: int) -> None:
    if columns > MAX_GRID_AXIS or rows > MAX_GRID_AXIS:
        die(f"grid axes must not exceed {MAX_GRID_AXIS}")
    if columns * rows > MAX_FRAME_COUNT:
        die(f"grid must not exceed {MAX_FRAME_COUNT} cells")
    if not MIN_CELL_AXIS <= cell_width <= MAX_CELL_AXIS:
        die(f"cell width must be {MIN_CELL_AXIS}...{MAX_CELL_AXIS}")
    if not MIN_CELL_AXIS <= cell_height <= MAX_CELL_AXIS:
        die(f"cell height must be {MIN_CELL_AXIS}...{MAX_CELL_AXIS}")
    width = columns * cell_width
    height = rows * cell_height
    if width > MAX_SHEET_AXIS or height > MAX_SHEET_AXIS or width * height > MAX_SHEET_PIXELS:
        die("sheet exceeds safe decoded-size bounds")


def required_frames(pack: dict[str, Any]) -> set[int]:
    columns = positive_int(pack.get("columns"), "pack columns")
    rows = positive_int(pack.get("rows"), "pack rows")
    capacity = columns * rows
    states = pack.get("states")
    fallback = pack.get("fallbackState")
    if not isinstance(states, dict) or not isinstance(fallback, str):
        die("pack requires states and fallbackState")
    required: set[int] = set()
    for original_state in REQUIRED_STATES:
        state = original_state
        visited: set[str] = set()
        while state not in visited:
            visited.add(state)
            sequence = states.get(state)
            if not isinstance(sequence, dict):
                state = fallback
                continue
            frames = sequence.get("frames")
            if isinstance(frames, list) and frames:
                if not all(isinstance(frame, int) and not isinstance(frame, bool) for frame in frames):
                    die(f"state {original_state} contains a non-integer frame")
                if not all(0 <= frame < capacity for frame in frames):
                    die(f"state {original_state} contains an out-of-bounds frame")
                duration = sequence.get("frameDurationMilliseconds")
                reduced = sequence.get("reducedMotionFrame")
                if not isinstance(duration, int) or duration <= 0 or reduced not in frames:
                    die(f"state {original_state} has invalid timing or reduced-motion frame")
                required.update(frames)
                break
            next_state = sequence.get("fallbackState", fallback)
            if not isinstance(next_state, str):
                die(f"state {original_state} has invalid fallback")
            state = next_state
        else:
            die(f"state {original_state} has a fallback cycle")
    return required


def alpha_estimate(rgb: tuple[int, int, int], key: tuple[int, int, int]) -> float:
    red, green, blue = rgb
    key_red, key_green, key_blue = key
    return max(
        max(0, key_red - red) / max(1, key_red),
        max(0, green - key_green) / max(1, 255 - key_green),
        max(0, key_blue - blue) / max(1, key_blue),
    )


def key_distance(rgb: tuple[int, int, int], key: tuple[int, int, int] = KEY) -> int:
    return max(abs(rgb[index] - key[index]) for index in range(3))


def spill_channel_indices(key: tuple[int, int, int]) -> list[int]:
    key_minimum = min(key)
    return [index for index, value in enumerate(key) if value >= 128 and value - key_minimum >= 64]


def looks_key_colored(rgb: tuple[int, int, int], key: tuple[int, int, int]) -> bool:
    if key_distance(rgb, key) <= 32:
        return True
    spill_channels = spill_channel_indices(key)
    retained_channels = [index for index in range(3) if index not in spill_channels]
    if not spill_channels or not retained_channels:
        return False
    spill_strength = min(rgb[index] for index in spill_channels)
    retained_strength = max(rgb[index] for index in retained_channels)
    return spill_strength - retained_strength >= 8


def decontaminate(
    rgb: tuple[int, int, int], alpha: float, key: tuple[int, int, int]
) -> tuple[int, int, int]:
    if alpha <= 0.0:
        return (0, 0, 0)
    if alpha >= 0.99:
        return rgb
    spill_channels = spill_channel_indices(key)
    retained_channels = [index for index in range(3) if index not in spill_channels]
    if not retained_channels:
        return rgb
    channels = list(rgb)
    neutral_edge = max(channels[index] for index in retained_channels)
    for index in spill_channels:
        channels[index] = min(channels[index], neutral_edge)
    return (channels[0], channels[1], channels[2])


def cell_edges(left: int, top: int, right: int, bottom: int):
    for x in range(left, right):
        yield (x, top)
        yield (x, bottom - 1)
    for y in range(top + 1, bottom - 1):
        yield (left, y)
        yield (right - 1, y)


def estimate_cell_key(source, points: list[tuple[int, int]]) -> tuple[int, int, int]:
    samples = [source[point] for point in points if key_distance(source[point]) <= 64]
    if not samples:
        die("cell edge has no magenta chroma background")
    return tuple(int(median(channel)) for channel in zip(*samples, strict=True))


def remove_chroma(
    image,
    columns: int,
    rows: int,
    alpha_mode: str,
    seed_tolerance: int,
    flood_alpha: float,
    hard_threshold: float,
):
    Image = load_pillow()
    rgb_image = image.convert("RGB")
    width, height = rgb_image.size
    source = rgb_image.load()
    output = Image.new("RGBA", rgb_image.size, (0, 0, 0, 0))
    destination = output.load()
    for row in range(rows):
        for column in range(columns):
            left = round(column * width / columns)
            top = round(row * height / rows)
            right = round((column + 1) * width / columns)
            bottom = round((row + 1) * height / rows)
            edge_points = list(cell_edges(left, top, right, bottom))
            cell_key = estimate_cell_key(source, edge_points)
            connected: set[tuple[int, int]] = set()
            queue: deque[tuple[int, int]] = deque()
            for point in edge_points:
                if key_distance(source[point], cell_key) <= seed_tolerance and point not in connected:
                    connected.add(point)
                    queue.append(point)
            if not queue:
                die(f"cell {row * columns + column} has no #FF00FF-connected edge background")
            while queue:
                x, y = queue.popleft()
                for next_x, next_y in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                    point = (next_x, next_y)
                    if (
                        point in connected
                        or next_x < left
                        or next_x >= right
                        or next_y < top
                        or next_y >= bottom
                    ):
                        continue
                    if (
                        looks_key_colored(source[point], cell_key)
                        and alpha_estimate(source[point], cell_key) <= flood_alpha
                    ):
                        connected.add(point)
                        queue.append(point)
            for y in range(top, bottom):
                for x in range(left, right):
                    rgb = source[x, y]
                    alpha = alpha_estimate(rgb, cell_key)
                    keyed_interior = looks_key_colored(rgb, cell_key) and alpha <= flood_alpha
                    if (x, y) not in connected and not keyed_interior:
                        destination[x, y] = (*rgb, 255)
                        continue
                    foreground = decontaminate(rgb, alpha, cell_key)
                    if alpha_mode == "hard":
                        destination[x, y] = (*foreground, 255) if alpha >= hard_threshold else (0, 0, 0, 0)
                    else:
                        value = max(0, min(255, int(round(alpha * 255))))
                        destination[x, y] = (*foreground, value) if value else (0, 0, 0, 0)
    return output


def crop_source(entry: dict[str, Any], base: Path):
    Image = load_pillow()
    source_path = base / str(entry.get("path", ""))
    if not source_path.is_file():
        die(f"frame source not found: {source_path}")
    with Image.open(source_path) as source:
        image = source.convert("RGB")
    columns = positive_int(entry.get("sourceColumns", 1), "sourceColumns")
    rows = positive_int(entry.get("sourceRows", 1), "sourceRows")
    frame = entry.get("sourceFrame", 0)
    if not isinstance(frame, int) or not 0 <= frame < columns * rows:
        die(f"invalid sourceFrame for {source_path}")
    column = frame % columns
    row = frame // columns
    left = round(column * image.width / columns)
    top = round(row * image.height / rows)
    right = round((column + 1) * image.width / columns)
    bottom = round((row + 1) * image.height / rows)
    return image.crop((left, top, right, bottom))


def harden_alpha(image, threshold: int = 128):
    alpha = image.getchannel("A").point(lambda value: 255 if value >= threshold else 0)
    image.putalpha(alpha)
    pixels = image.load()
    for y in range(image.height):
        for x in range(image.width):
            red, green, blue, value = pixels[x, y]
            if value and key_distance((red, green, blue)) <= 32:
                pixels[x, y] = (0, 0, 0, 0)
    return image


def crop_subject(image):
    bounds = image.getchannel("A").getbbox()
    if bounds is None:
        die("frame contains no subject after chroma removal")
    return image.crop(bounds)


def remove_edge_connected_artwork(image):
    pixels = image.load()
    width, height = image.size
    visited: set[tuple[int, int]] = set()
    components: list[tuple[list[tuple[int, int]], bool]] = []
    for y in range(height):
        for x in range(width):
            start = (x, y)
            if pixels[start][3] == 0 or start in visited:
                continue
            points: list[tuple[int, int]] = []
            touches_edge = False
            queue: deque[tuple[int, int]] = deque([start])
            visited.add(start)
            while queue:
                point = queue.popleft()
                point_x, point_y = point
                points.append(point)
                touches_edge = touches_edge or point_x in {0, width - 1} or point_y in {0, height - 1}
                for neighbor in (
                    (point_x - 1, point_y),
                    (point_x + 1, point_y),
                    (point_x, point_y - 1),
                    (point_x, point_y + 1),
                ):
                    next_x, next_y = neighbor
                    if (
                        neighbor in visited
                        or next_x < 0
                        or next_x >= width
                        or next_y < 0
                        or next_y >= height
                        or pixels[neighbor][3] == 0
                    ):
                        continue
                    visited.add(neighbor)
                    queue.append(neighbor)
            components.append((points, touches_edge))
    largest_component = max((len(points) for points, _ in components), default=0)
    for points, touches_edge in components:
        if not touches_edge or len(points) == largest_component:
            continue
        for point in points:
            pixels[point] = (0, 0, 0, 0)
    return image


def resize_frame(image, scale: float):
    Image = load_pillow()
    if scale <= 0:
        die("frame scale must remain positive")
    size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    resized = image.resize(size, Image.Resampling.LANCZOS)
    return harden_alpha(resized)


def frame_groups(pack: dict[str, Any]) -> dict[int, tuple[str, int]]:
    groups: dict[int, tuple[str, int]] = {}
    states = pack.get("states")
    if not isinstance(states, dict):
        return groups
    for state, sequence in states.items():
        if not isinstance(sequence, dict) or not isinstance(sequence.get("frames"), list):
            continue
        state_frames: dict[int, int] = {}
        for frame in sequence["frames"]:
            if isinstance(frame, int) and frame not in state_frames:
                state_frames[frame] = len(state_frames)
        for frame, source_frame in state_frames.items():
            if isinstance(frame, int) and frame not in groups:
                groups[frame] = (state, source_frame)
    return groups


def init_spec(args: argparse.Namespace) -> None:
    pack = read_pack(Path(args.pack_manifest), args.pack_id)
    columns = positive_int(pack.get("columns"), "pack columns")
    rows = positive_int(pack.get("rows"), "pack rows")
    validate_grid(columns, rows, args.cell_width, args.cell_height)
    if (args.state_batch_columns is None) != (args.state_batch_rows is None):
        die("state batch columns and rows must be provided together")
    if args.state_batch_columns is not None:
        positive_int(args.state_batch_columns, "state batch columns")
        positive_int(args.state_batch_rows, "state batch rows")
        if args.state_batch_columns > MAX_GRID_AXIS or args.state_batch_rows > MAX_GRID_AXIS:
            die(f"source batch axes must not exceed {MAX_GRID_AXIS}")
    groups = frame_groups(pack)
    frames = []
    for index in sorted(required_frames(pack)):
        group, source_frame = groups.get(index, ("default", 0))
        if args.state_batch_columns and args.state_batch_rows:
            if source_frame >= args.state_batch_columns * args.state_batch_rows:
                die(f"state {group} exceeds configured source batch grid")
            path = Path(args.frames_dir) / f"{group}.png"
            entry = {
                "index": index,
                "path": str(path),
                "sourceColumns": args.state_batch_columns,
                "sourceRows": args.state_batch_rows,
                "sourceFrame": source_frame,
                "normalizationGroup": group,
                "offsetX": 0,
                "offsetY": 0,
            }
        else:
            entry = {
                "index": index,
                "path": str(Path(args.frames_dir) / f"{index:03d}.png"),
                "normalizationGroup": group,
                "offsetX": 0,
                "offsetY": 0,
            }
        frames.append(entry)
    write_json(
        Path(args.out),
        {
            "version": 1,
            "packId": pack.get("id"),
            "columns": columns,
            "rows": rows,
            "cellWidth": args.cell_width,
            "cellHeight": args.cell_height,
            "padding": args.padding,
            "alphaMode": pack.get("alphaMode", "hard"),
            "frames": frames,
        },
        args.force,
    )


def remove_command(args: argparse.Namespace) -> None:
    Image = load_pillow()
    source_path = Path(args.input)
    if not source_path.is_file():
        die(f"input not found: {source_path}")
    output_path = Path(args.out)
    if output_path.exists() and not args.force:
        die(f"output already exists: {output_path} (use --force)")
    with Image.open(source_path) as source:
        output = remove_chroma(
            source,
            args.columns,
            args.rows,
            args.alpha_mode,
            args.seed_tolerance,
            args.flood_alpha,
            args.hard_threshold,
        )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output.save(output_path, format="PNG", optimize=True)
    print(f"Wrote {output_path}")


def assemble(args: argparse.Namespace) -> None:
    Image = load_pillow()
    spec_path = Path(args.spec)
    spec = read_json(spec_path)
    columns = positive_int(spec.get("columns"), "spec columns")
    rows = positive_int(spec.get("rows"), "spec rows")
    cell_width = positive_int(spec.get("cellWidth"), "spec cellWidth")
    cell_height = positive_int(spec.get("cellHeight"), "spec cellHeight")
    validate_grid(columns, rows, cell_width, cell_height)
    padding = positive_int(spec.get("padding", 12), "spec padding")
    alpha_mode = spec.get("alphaMode", "hard")
    if alpha_mode not in {"hard", "soft"}:
        die("alphaMode must be hard or soft")
    entries = spec.get("frames")
    if not isinstance(entries, list) or not entries:
        die("spec frames must be a nonempty array")
    capacity = columns * rows
    indices: set[int] = set()
    prepared: list[tuple[dict[str, Any], Any, float]] = []
    for raw_entry in entries:
        if not isinstance(raw_entry, dict):
            die("each frame entry must be an object")
        index = raw_entry.get("index")
        if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < capacity:
            die("frame index is invalid")
        if index in indices:
            die(f"duplicate frame index: {index}")
        indices.add(index)
        source = crop_source(raw_entry, spec_path.parent)
        keyed = remove_chroma(source, 1, 1, alpha_mode, 16, 0.995, 0.5)
        scale_adjustment = float(raw_entry.get("scale", 1.0))
        if not 0.5 <= scale_adjustment <= 1.5:
            die(f"frame {index} scale must be 0.5...1.5")
        prepared.append(
            (raw_entry, crop_subject(remove_edge_connected_artwork(keyed)), scale_adjustment)
        )
    available_width = cell_width - 2 * padding
    available_height = cell_height - 2 * padding
    maximum_width = max(frame.width * scale for _, frame, scale in prepared)
    maximum_height = max(frame.height * scale for _, frame, scale in prepared)
    canonical_scale = min(available_width / maximum_width, available_height / maximum_height)
    processed = [
        (entry, resize_frame(frame, canonical_scale * scale_adjustment))
        for entry, frame, scale_adjustment in prepared
    ]
    sheet = Image.new("RGBA", (columns * cell_width, rows * cell_height), (0, 0, 0, 0))
    frame_metadata: list[dict[str, Any]] = []
    center_x = cell_width // 2
    baseline_y = cell_height - padding
    for entry, frame in processed:
        index = entry["index"]
        offset_x = int(entry.get("offsetX", 0))
        offset_y = int(entry.get("offsetY", 0))
        local_x = center_x - frame.width // 2 + offset_x
        local_y = baseline_y - frame.height + offset_y
        if local_x < padding or local_y < padding or local_x + frame.width > cell_width - padding or local_y + frame.height > cell_height - padding:
            die(f"frame {index} violates safe cell padding after offsets")
        column = index % columns
        row = index // columns
        sheet.alpha_composite(frame, (column * cell_width + local_x, row * cell_height + local_y))
        frame_metadata.append(
            {
                "index": index,
                "offsetX": offset_x,
                "offsetY": offset_y,
                "normalizationGroup": entry.get("normalizationGroup", "default"),
                "scale": canonical_scale * float(entry.get("scale", 1.0)),
                "bounds": [local_x, local_y, local_x + frame.width, local_y + frame.height],
            }
        )
    output_path = Path(args.out)
    if output_path.exists() and not args.force:
        die(f"output already exists: {output_path} (use --force)")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output_path, format="PNG", optimize=True)
    write_json(
        Path(args.metadata_out),
        {
            "version": 1,
            "packId": spec.get("packId"),
            "columns": columns,
            "rows": rows,
            "cellWidth": cell_width,
            "cellHeight": cell_height,
            "padding": padding,
            "alphaMode": alpha_mode,
            "anchor": {"centerX": center_x, "baselineY": baseline_y, "tolerance": 1},
            "frames": frame_metadata,
        },
        args.force,
    )
    print(f"Wrote {output_path}")


def frame_bounds(image, index: int, columns: int, rows: int):
    cell_width = image.width // columns
    cell_height = image.height // rows
    column = index % columns
    row = index // columns
    cell = image.crop(
        (column * cell_width, row * cell_height, (column + 1) * cell_width, (row + 1) * cell_height)
    )
    return cell, cell.getchannel("A").getbbox()


def validate(args: argparse.Namespace) -> None:
    Image = load_pillow()
    input_path = Path(args.input)
    pack = read_pack(Path(args.catalog), args.pack_id)
    columns = positive_int(pack.get("columns"), "pack columns")
    rows = positive_int(pack.get("rows"), "pack rows")
    if Path(str(pack.get("sheet", ""))).name != input_path.name:
        die("manifest sheet does not reference input filename")
    if not input_path.is_file():
        die(f"input not found: {input_path}")
    with Image.open(input_path) as source:
        image = source.convert("RGBA")
    if image.width % columns or image.height % rows:
        die("sheet dimensions must divide evenly by manifest grid")
    cell_width = image.width // columns
    cell_height = image.height // rows
    validate_grid(columns, rows, cell_width, cell_height)
    metadata = read_json(Path(args.metadata)) if args.metadata else None
    if metadata:
        expected_size = (
            positive_int(metadata.get("columns"), "metadata columns")
            * positive_int(metadata.get("cellWidth"), "metadata cellWidth"),
            positive_int(metadata.get("rows"), "metadata rows")
            * positive_int(metadata.get("cellHeight"), "metadata cellHeight"),
        )
        if image.size != expected_size or metadata.get("packId") != pack.get("id"):
            die("sheet dimensions or pack id do not match assembly metadata")
    pixels = image.load()
    for row in range(rows):
        for column in range(columns):
            left = column * cell_width
            top = row * cell_height
            corners = (
                pixels[left, top][3],
                pixels[left + cell_width - 1, top][3],
                pixels[left, top + cell_height - 1][3],
                pixels[left + cell_width - 1, top + cell_height - 1][3],
            )
            if any(corners):
                die(f"cell {row * columns + column} has a nontransparent corner")
    required = required_frames(pack)
    alpha_mode = pack.get("alphaMode", "hard")
    partial = 0
    residue = 0
    for red, green, blue, alpha in image.getdata():
        if 0 < alpha < 255:
            partial += 1
        if alpha and key_distance((red, green, blue)) <= args.residue_tolerance:
            residue += 1
    if alpha_mode == "hard" and partial:
        die(f"hard-alpha pack contains {partial} partially transparent pixels")
    if alpha_mode not in {"hard", "soft"}:
        die("manifest alphaMode must be hard or soft")
    if residue:
        die(f"sheet contains {residue} visible pixels within key-color tolerance")
    metadata_frames = {
        entry["index"]: entry
        for entry in (metadata.get("frames", []) if metadata else [])
        if isinstance(entry, dict) and isinstance(entry.get("index"), int)
    }
    padding = positive_int(metadata.get("padding", args.padding) if metadata else args.padding, "padding")
    anchor = metadata.get("anchor") if metadata else None
    for index in sorted(required):
        cell, bounds = frame_bounds(image, index, columns, rows)
        alpha_histogram = cell.getchannel("A").histogram()
        visible_pixels = sum(alpha_histogram[1:])
        if bounds is None or visible_pixels < args.minimum_content_pixels:
            die(f"required frame {index} is empty")
        left, top, right, bottom = bounds
        if left < padding or top < padding or right > cell_width - padding or bottom > cell_height - padding:
            die(f"required frame {index} violates safe padding")
        if metadata:
            expected = metadata_frames.get(index)
            if expected is None or expected.get("bounds") != [left, top, right, bottom]:
                die(f"frame {index} does not match assembly metadata bounds")
            if isinstance(anchor, dict):
                tolerance = int(anchor.get("tolerance", 1))
                expected_center = int(anchor["centerX"]) + int(expected.get("offsetX", 0))
                expected_baseline = int(anchor["baselineY"]) + int(expected.get("offsetY", 0))
                if abs((left + right) / 2 - expected_center) > tolerance or abs(bottom - expected_baseline) > tolerance:
                    die(f"frame {index} violates canonical anchor or baseline")
    print(
        f"Valid {image.width}x{image.height} RGBA sheet: {columns}x{rows}, "
        f"{cell_width}x{cell_height} cells, {len(required)} required frames, alphaMode={alpha_mode}"
    )


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    subcommands = root.add_subparsers(dest="command", required=True)
    init = subcommands.add_parser("init-spec")
    init.add_argument("--pack-manifest", required=True)
    init.add_argument("--pack-id")
    init.add_argument("--frames-dir", required=True)
    init.add_argument("--out", required=True)
    init.add_argument("--cell-width", type=int, default=256)
    init.add_argument("--cell-height", type=int, default=256)
    init.add_argument("--padding", type=int, default=12)
    init.add_argument("--state-batch-columns", type=int)
    init.add_argument("--state-batch-rows", type=int)
    init.add_argument("--force", action="store_true")
    init.set_defaults(handler=init_spec)
    remove = subcommands.add_parser("remove")
    remove.add_argument("--input", required=True)
    remove.add_argument("--out", required=True)
    remove.add_argument("--columns", type=int, default=1)
    remove.add_argument("--rows", type=int, default=1)
    remove.add_argument("--alpha-mode", choices=["hard", "soft"], default="hard")
    remove.add_argument("--seed-tolerance", type=int, default=16)
    remove.add_argument("--flood-alpha", type=float, default=0.995)
    remove.add_argument("--hard-threshold", type=float, default=0.5)
    remove.add_argument("--force", action="store_true")
    remove.set_defaults(handler=remove_command)
    assembly = subcommands.add_parser("assemble")
    assembly.add_argument("--spec", required=True)
    assembly.add_argument("--out", required=True)
    assembly.add_argument("--metadata-out", required=True)
    assembly.add_argument("--force", action="store_true")
    assembly.set_defaults(handler=assemble)
    check = subcommands.add_parser("validate")
    check.add_argument("--input", required=True)
    check.add_argument("--catalog", required=True)
    check.add_argument("--pack-id", required=True)
    check.add_argument("--metadata")
    check.add_argument("--padding", type=int, default=8)
    check.add_argument("--minimum-content-pixels", type=int, default=64)
    check.add_argument("--residue-tolerance", type=int, default=32)
    check.set_defaults(handler=validate)
    return root


def main() -> None:
    args = parser().parse_args()
    if hasattr(args, "columns"):
        if args.columns <= 0 or args.rows <= 0:
            die("columns and rows must be positive")
        if not 0 <= args.seed_tolerance <= 255:
            die("seed tolerance must be 0...255")
        if not 0.0 < args.flood_alpha <= 1.0 or not 0.0 <= args.hard_threshold <= 1.0:
            die("alpha thresholds are invalid")
    args.handler(args)


if __name__ == "__main__":
    main()
