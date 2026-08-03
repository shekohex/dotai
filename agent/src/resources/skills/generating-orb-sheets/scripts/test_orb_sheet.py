#!/usr/bin/env python3

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from PIL import Image, ImageDraw


SCRIPT = Path(__file__).with_name("orb_sheet.py")
MISS_MINUTES_TEMPLATE = SCRIPT.parent.parent / "templates" / "miss-minutes-pack.json"
STATES = (
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


class OrbSheetTests(unittest.TestCase):
    def run_tool(self, *arguments: str, expected: int = 0) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            [sys.executable, str(SCRIPT), *arguments],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, expected, result.stderr or result.stdout)
        return result

    def write_frame(self, path: Path, shift: int = 0) -> None:
        image = Image.new("RGB", (128, 128), (255, 0, 255))
        draw = ImageDraw.Draw(image)
        draw.ellipse((30, 18 + shift, 98, 86 + shift), fill=(255, 128, 24), outline=(20, 20, 20), width=4)
        draw.ellipse((47, 37 + shift, 57, 53 + shift), fill=(255, 255, 255))
        draw.ellipse((71, 37 + shift, 81, 53 + shift), fill=(255, 255, 255))
        draw.line((50, 88 + shift, 50, 108 + shift), fill=(20, 20, 20), width=4)
        draw.line((78, 88 + shift, 78, 108 + shift), fill=(20, 20, 20), width=4)
        image.save(path)

    def write_batch(self, path: Path) -> None:
        image = Image.new("RGB", (511, 255), (255, 0, 255))
        draw = ImageDraw.Draw(image)
        for frame in range(8):
            column = frame % 4
            row = frame // 4
            left = round(column * image.width / 4)
            top = round(row * image.height / 2)
            shift = frame % 3
            draw.ellipse(
                (left + 30, top + 18 + shift, left + 98, top + 86 + shift),
                fill=(255, 128, 24),
                outline=(20, 20, 20),
                width=4,
            )
            draw.line((left + 50, top + 88, left + 50, top + 108), fill=(20, 20, 20), width=4)
            draw.line((left + 78, top + 88, left + 78, top + 108), fill=(20, 20, 20), width=4)
        image.save(path)

    def test_remove_handles_nondivisible_batch_and_approximate_magenta_without_green_fringe(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source_path = root / "batch.png"
            output_path = root / "batch-rgba.png"
            image = Image.new("RGB", (127, 125))
            pixels = image.load()
            for y in range(image.height):
                for x in range(image.width):
                    pixels[x, y] = (242 + x % 5, 6 + y % 7, 202 + (x + y) % 6)
            draw = ImageDraw.Draw(image)
            for row in range(2):
                for column in range(2):
                    left = round(column * image.width / 2)
                    top = round(row * image.height / 2)
                    draw.ellipse((left + 12, top + 8, left + 45, top + 47), fill=(255, 128, 24))
            image.save(source_path)

            self.run_tool(
                "remove",
                "--input",
                str(source_path),
                "--out",
                str(output_path),
                "--columns",
                "2",
                "--rows",
                "2",
            )

            with Image.open(output_path) as output:
                self.assertEqual(set(output.getchannel("A").getdata()), {0, 255})
                opaque_pixels = [pixel for pixel in output.getdata() if pixel[3] == 255]
                self.assertTrue(opaque_pixels)
                self.assertFalse(
                    any(green > red + 20 and green > blue + 20 for red, green, blue, _ in opaque_pixels)
                )
                self.assertEqual(output.getpixel((28, 28))[:3], (255, 128, 24))

    def test_assembly_removes_adjacent_frame_artwork_touching_source_edge(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            frame_path = root / "frame.png"
            self.write_frame(frame_path)
            with Image.open(frame_path) as source:
                image = source.convert("RGB")
            ImageDraw.Draw(image).rectangle((118, 40, 127, 80), fill=(0, 255, 255))
            image.save(frame_path)
            sequence = {
                "frames": [0],
                "frameDurationMilliseconds": 100,
                "looping": True,
                "reducedMotionFrame": 0,
            }
            pack = {
                "id": "edge-bleed",
                "name": "Edge Bleed",
                "sheet": "edge-bleed.png",
                "columns": 1,
                "rows": 1,
                "accent": "FF8000",
                "alphaMode": "hard",
                "previewState": "idle",
                "fallbackState": "idle",
                "states": {state: sequence for state in STATES},
            }
            pack_path = root / "pack.json"
            pack_path.write_text(json.dumps(pack), encoding="utf-8")
            spec_path = root / "frames.json"
            self.run_tool(
                "init-spec",
                "--pack-manifest",
                str(pack_path),
                "--frames-dir",
                str(root),
                "--out",
                str(spec_path),
            )
            spec = json.loads(spec_path.read_text(encoding="utf-8"))
            spec["frames"][0]["path"] = str(frame_path)
            spec_path.write_text(json.dumps(spec), encoding="utf-8")
            sheet_path = root / "edge-bleed.png"
            metadata_path = root / "metadata.json"
            self.run_tool(
                "assemble",
                "--spec",
                str(spec_path),
                "--out",
                str(sheet_path),
                "--metadata-out",
                str(metadata_path),
            )

            with Image.open(sheet_path) as sheet:
                self.assertFalse(
                    any(
                        red == 0 and green == 255 and blue == 255 and alpha == 255
                        for red, green, blue, alpha in sheet.getdata()
                    )
                )

    def test_arbitrary_grid_assembly_hard_alpha_and_validation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            frames = root / "frames"
            frames.mkdir()
            for index in range(3):
                self.write_frame(frames / f"{index:03d}.png", index)
            states = {
                state: {
                    "frames": [index % 3],
                    "frameDurationMilliseconds": 100,
                    "looping": True,
                    "reducedMotionFrame": index % 3,
                }
                for index, state in enumerate(STATES)
            }
            pack = {
                "id": "test-pack",
                "name": "Test Pack",
                "sheet": "test-pack.png",
                "columns": 3,
                "rows": 2,
                "accent": "FF8000",
                "alphaMode": "hard",
                "previewState": "idle",
                "fallbackState": "idle",
                "states": states,
            }
            pack_path = root / "pack.json"
            pack_path.write_text(json.dumps(pack), encoding="utf-8")
            spec_path = root / "frames.json"
            self.run_tool(
                "init-spec",
                "--pack-manifest",
                str(pack_path),
                "--frames-dir",
                "frames",
                "--cell-width",
                "64",
                "--cell-height",
                "64",
                "--padding",
                "6",
                "--out",
                str(spec_path),
            )
            sheet_path = root / "test-pack.png"
            metadata_path = root / "test-pack.metadata.json"
            self.run_tool(
                "assemble",
                "--spec",
                str(spec_path),
                "--out",
                str(sheet_path),
                "--metadata-out",
                str(metadata_path),
            )
            self.run_tool(
                "validate",
                "--input",
                str(sheet_path),
                "--catalog",
                str(pack_path),
                "--pack-id",
                "test-pack",
                "--metadata",
                str(metadata_path),
                "--minimum-content-pixels",
                "16",
            )
            with Image.open(sheet_path) as sheet:
                self.assertEqual(sheet.size, (192, 128))
                self.assertEqual(set(sheet.getchannel("A").getdata()), {0, 255})
                for x, y in ((0, 0), (191, 0), (0, 127), (191, 127)):
                    self.assertEqual(sheet.getpixel((x, y))[3], 0)

    def test_validator_rejects_visible_key_color(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            sheet_path = root / "bad.png"
            image = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
            ImageDraw.Draw(image).rectangle((16, 16, 47, 47), fill=(255, 0, 255, 255))
            image.save(sheet_path)
            sequence = {
                "frames": [0],
                "frameDurationMilliseconds": 100,
                "looping": True,
                "reducedMotionFrame": 0,
            }
            pack = {
                "id": "bad",
                "name": "Bad",
                "sheet": "bad.png",
                "columns": 1,
                "rows": 1,
                "accent": "FFFFFF",
                "alphaMode": "hard",
                "previewState": "idle",
                "fallbackState": "idle",
                "states": {state: sequence for state in STATES},
            }
            pack_path = root / "pack.json"
            pack_path.write_text(json.dumps(pack), encoding="utf-8")
            result = self.run_tool(
                "validate",
                "--input",
                str(sheet_path),
                "--catalog",
                str(pack_path),
                "--pack-id",
                "bad",
                expected=1,
            )
            self.assertIn("key-color tolerance", result.stderr)

    def test_eight_by_twelve_sheet_uses_binary_alpha_and_one_state_per_row(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            frames = root / "frames"
            frames.mkdir()
            for state in STATES:
                self.write_batch(frames / f"{state}.png")
            pack_path = root / "miss-minutes-pack.json"
            pack_path.write_text(MISS_MINUTES_TEMPLATE.read_text(encoding="utf-8"), encoding="utf-8")
            spec_path = root / "frames.json"
            self.run_tool(
                "init-spec",
                "--pack-manifest",
                str(pack_path),
                "--frames-dir",
                "frames",
                "--state-batch-columns",
                "4",
                "--state-batch-rows",
                "2",
                "--out",
                str(spec_path),
            )
            spec = json.loads(spec_path.read_text(encoding="utf-8"))
            self.assertEqual(len(spec["frames"]), 96)
            for row, state in enumerate(STATES):
                entries = spec["frames"][row * 8 : (row + 1) * 8]
                self.assertEqual({entry["path"] for entry in entries}, {f"frames/{state}.png"})
                self.assertEqual([entry["sourceFrame"] for entry in entries], list(range(8)))
                self.assertEqual({entry["normalizationGroup"] for entry in entries}, {state})
            sheet_path = root / "miss-minutes.png"
            metadata_path = root / "miss-minutes.metadata.json"
            self.run_tool(
                "assemble",
                "--spec",
                str(spec_path),
                "--out",
                str(sheet_path),
                "--metadata-out",
                str(metadata_path),
            )
            self.run_tool(
                "validate",
                "--input",
                str(sheet_path),
                "--catalog",
                str(pack_path),
                "--pack-id",
                "miss-minutes",
                "--metadata",
                str(metadata_path),
            )
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            self.assertEqual(metadata["anchor"], {"centerX": 128, "baselineY": 244, "tolerance": 1})
            self.assertEqual(len({entry["scale"] for entry in metadata["frames"]}), 1)
            self.assertEqual(
                {entry["normalizationGroup"] for entry in metadata["frames"]}, set(STATES)
            )
            with Image.open(sheet_path) as sheet:
                self.assertEqual(sheet.size, (2048, 3072))
                self.assertEqual(set(sheet.getchannel("A").getdata()), {0, 255})
                for row in range(12):
                    for column in range(8):
                        frame = sheet.crop(
                            (column * 256, row * 256, (column + 1) * 256, (row + 1) * 256)
                        )
                        self.assertIsNotNone(frame.getchannel("A").getbbox())

    def test_partial_alpha_requires_soft_manifest_opt_in(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            sheet_path = root / "partial.png"
            image = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
            ImageDraw.Draw(image).rectangle((16, 16, 47, 47), fill=(255, 128, 24, 128))
            image.save(sheet_path)
            sequence = {
                "frames": [0],
                "frameDurationMilliseconds": 100,
                "looping": True,
                "reducedMotionFrame": 0,
            }
            pack = {
                "id": "partial",
                "name": "Partial",
                "sheet": "partial.png",
                "columns": 1,
                "rows": 1,
                "accent": "FF8000",
                "alphaMode": "hard",
                "previewState": "idle",
                "fallbackState": "idle",
                "states": {state: sequence for state in STATES},
            }
            pack_path = root / "pack.json"
            pack_path.write_text(json.dumps(pack), encoding="utf-8")
            result = self.run_tool(
                "validate",
                "--input",
                str(sheet_path),
                "--catalog",
                str(pack_path),
                "--pack-id",
                "partial",
                expected=1,
            )
            self.assertIn("partially transparent", result.stderr)
            pack["alphaMode"] = "soft"
            pack_path.write_text(json.dumps(pack), encoding="utf-8")
            self.run_tool(
                "validate",
                "--input",
                str(sheet_path),
                "--catalog",
                str(pack_path),
                "--pack-id",
                "partial",
            )


if __name__ == "__main__":
    unittest.main()
