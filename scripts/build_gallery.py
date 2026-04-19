#!/usr/bin/env python3
"""
Build a coherent gallery manifest, preview contact sheet, and example assets
for the Excalidraw skill fixtures.
"""

from __future__ import annotations

import json
import math
import shutil
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


@dataclass(frozen=True)
class FixtureSpec:
    fixture_id: str
    file_base: str
    command: list[str]
    expected_fail: bool = False
    setup_commands: tuple[tuple[str, ...], ...] = ()
    scene_path: str | None = None
    verification_path: str | None = None


def run(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=cwd,
        text=True,
        capture_output=True,
        check=False,
    )


def ensure_clean_dir(directory: Path) -> None:
    if directory.exists():
        shutil.rmtree(directory)
    directory.mkdir(parents=True, exist_ok=True)


def repo_relative(repo_root: Path, target: Path | None) -> str | None:
    if target is None:
        return None
    try:
        return target.resolve().relative_to(repo_root.resolve()).as_posix()
    except ValueError:
        return target.as_posix()


def read_json_if_exists(file_path: Path | None) -> dict | None:
    if file_path is None or not file_path.exists():
        return None
    return json.loads(file_path.read_text())


def try_parse_json(text: str) -> dict | None:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def summarize_failure(result: subprocess.CompletedProcess[str]) -> str:
    combined = "\n".join(
        part.strip() for part in (result.stdout, result.stderr) if part.strip()
    ).strip()
    if not combined:
        return f"command exited with code {result.returncode}"
    lines = [line.strip() for line in combined.splitlines() if line.strip()]
    non_stack = [line for line in lines if not line.startswith("at ") and not line.startswith("file://")]
    prioritized = [
        line
        for line in non_stack
        if "verification failed" in line.lower()
        or "verification exceeded" in line.lower()
        or "image fallback" in line.lower()
        or "strict-flowchart" in line.lower()
        or line.startswith("- ")
    ]
    if prioritized:
        if prioritized[0].startswith("- "):
            return prioritized[0]
        bullet_lines = [line for line in prioritized[1:] if line.startswith("- ")]
        if bullet_lines:
            return f"{prioritized[0]} {' '.join(bullet_lines[:2])}"
        return prioritized[0]
    return non_stack[0] if non_stack else lines[-1]


def portable_command(repo_root: Path, command: list[str] | tuple[str, ...]) -> list[str]:
    portable: list[str] = []
    for token in command:
        token_path = Path(token)
        if token_path.is_absolute():
            portable.append(repo_relative(repo_root, token_path) or token)
        else:
            portable.append(token)
    return portable


def count_repeated_reroutes(auto_fixes: list[str]) -> int:
    reroutes = [entry for entry in auto_fixes if entry.startswith("reroute-edge:")]
    counts = Counter(reroutes)
    return sum(count - 1 for count in counts.values() if count > 1)


def derive_status(
    return_code: int,
    warnings: list[str],
    hard_failures: list[str],
    expected_fail: bool,
    metadata: dict,
) -> str:
    if return_code != 0:
        return "failed"
    if expected_fail:
        return "passed_degraded"
    if warnings or hard_failures:
        return "passed_degraded"
    if metadata.get("fellBackToImage") or metadata.get("treatedAsFlowchart") is False:
        return "passed_degraded"
    if metadata.get("status") == "passed_degraded":
        return "passed_degraded"
    return "passed"


def build_record(
    spec: FixtureSpec,
    result: subprocess.CompletedProcess[str],
    repo_root: Path,
    gallery_dir: Path,
) -> dict:
    payload = try_parse_json(result.stdout)
    scene_path = Path(spec.scene_path) if spec.scene_path else gallery_dir / f"{spec.file_base}.excalidraw"
    verification_path = Path(spec.verification_path) if spec.verification_path else gallery_dir / f"{spec.file_base}.verification.json"
    svg_path = gallery_dir / f"{spec.file_base}.svg"
    preview_path = gallery_dir / f"{spec.file_base}.preview.png"

    verification = None
    if isinstance(payload, dict):
        verification = payload.get("verification")
    if not isinstance(verification, dict):
        verification = read_json_if_exists(verification_path)

    report = payload.get("report") if isinstance(payload, dict) else None
    if not isinstance(report, dict):
        report = {}

    warnings: list[str] = []
    hard_failures: list[str] = []
    metadata: dict = {}
    metrics: dict = {}
    if isinstance(verification, dict):
        warnings = [warning for warning in verification.get("warnings", []) if isinstance(warning, str)]
        hard_failures = [failure for failure in verification.get("hardFailures", []) if isinstance(failure, str)]
        metadata = verification.get("metadata") if isinstance(verification.get("metadata"), dict) else {}
        inspect_summary = verification.get("inspectSummary") if isinstance(verification.get("inspectSummary"), dict) else {}
        metrics = inspect_summary.get("qualityMetrics") if isinstance(inspect_summary.get("qualityMetrics"), dict) else {}

    auto_fixes = [entry for entry in report.get("autoFixes", []) if isinstance(entry, str)]
    repeated_reroutes = count_repeated_reroutes(auto_fixes)
    merged_metrics = {
        **metrics,
        "autoFixCount": len(auto_fixes),
        "repeatedRerouteCount": repeated_reroutes,
    }
    if auto_fixes:
        merged_metrics["uniqueReroutedEdgeCount"] = len({entry for entry in auto_fixes if entry.startswith("reroute-edge:")})

    failure = None
    expectation_met = (result.returncode != 0) == spec.expected_fail
    if result.returncode != 0 or not expectation_met:
        failure = summarize_failure(result)
        if not expectation_met and result.returncode == 0 and spec.expected_fail:
            failure = "fixture unexpectedly succeeded"

    status = derive_status(result.returncode, warnings, hard_failures, spec.expected_fail, metadata)
    if spec.expected_fail and result.returncode == 0:
        status = "passed_degraded"

    return {
        "fixtureId": spec.fixture_id,
        "fileBase": spec.file_base,
        "title": spec.fixture_id,
        "command": portable_command(repo_root, spec.command),
        "setupCommands": [portable_command(repo_root, command) for command in spec.setup_commands],
        "returnCode": result.returncode,
        "expectedFail": spec.expected_fail,
        "status": status,
        "warnings": warnings,
        "hardFailures": hard_failures,
        "failure": failure,
        "outputPath": payload.get("outputPath") if isinstance(payload, dict) else repo_relative(repo_root, scene_path if scene_path.exists() else None),
        "scenePath": repo_relative(repo_root, scene_path if scene_path.exists() else None),
        "svgPath": repo_relative(repo_root, svg_path if svg_path.exists() else None),
        "previewPath": repo_relative(repo_root, preview_path if preview_path.exists() else None),
        "verificationPath": repo_relative(repo_root, verification_path if verification_path.exists() else None),
        "metrics": merged_metrics,
        "metadata": metadata,
        "report": {
            "autoFixes": auto_fixes,
            "qualityWarnings": [warning for warning in report.get("qualityWarnings", []) if isinstance(warning, str)],
            "treatedAsFlowchart": report.get("treatedAsFlowchart"),
            "fellBackToImage": report.get("fellBackToImage"),
            "strictFlowchart": report.get("strictFlowchart"),
            "layoutEngine": report.get("layoutEngine"),
            "layoutEngineReason": report.get("layoutEngineReason"),
        },
    }


def copy_example_assets(skill_root: Path, gallery_dir: Path, summary_path: Path, contact_sheet_path: Path) -> None:
    examples_dir = skill_root / "assets" / "examples"
    examples_dir.mkdir(parents=True, exist_ok=True)

    for existing in examples_dir.glob("*.preview.png"):
        existing.unlink()
    for removable in ("fixture-contact-sheet.png", "gallery-summary.json"):
        candidate = examples_dir / removable
        if candidate.exists():
            candidate.unlink()

    for preview in sorted(gallery_dir.glob("*.preview.png")):
        shutil.copy2(preview, examples_dir / preview.name)
    if contact_sheet_path.exists():
        shutil.copy2(contact_sheet_path, examples_dir / contact_sheet_path.name)
    shutil.copy2(summary_path, examples_dir / summary_path.name)


def build_contact_sheet(summary: dict, repo_root: Path, gallery_dir: Path) -> Path:
    records = summary["fixtures"]
    columns = 3
    padding = 16
    tile_width = 420
    tile_height = 280
    label_height = 56
    rows = max(1, math.ceil(len(records) / columns))
    canvas_width = padding + columns * (tile_width + padding)
    canvas_height = padding + rows * (tile_height + label_height + padding)

    image = Image.new("RGB", (canvas_width, canvas_height), "#f7f5ef")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default()

    for index, record in enumerate(records):
        row = index // columns
        column = index % columns
        left = padding + column * (tile_width + padding)
        top = padding + row * (tile_height + label_height + padding)
        frame_rect = [left, top, left + tile_width, top + tile_height]
        draw.rounded_rectangle(frame_rect, radius=14, outline="#2a2a2a", width=2, fill="#ffffff")

        preview_path = record.get("previewPath")
        if isinstance(preview_path, str):
            preview_file = repo_root / preview_path
        else:
            preview_file = None

        if preview_file and preview_file.exists():
            preview_image = Image.open(preview_file).convert("RGB")
            preview_image.thumbnail((tile_width - 20, tile_height - 20))
            paste_x = left + (tile_width - preview_image.width) // 2
            paste_y = top + (tile_height - preview_image.height) // 2
            image.paste(preview_image, (paste_x, paste_y))
        else:
            placeholder = [left + 18, top + 18, left + tile_width - 18, top + tile_height - 18]
            draw.rounded_rectangle(placeholder, radius=10, outline="#999999", width=1, fill="#fafafa")
            draw.text((left + 28, top + tile_height // 2 - 8), "No preview", fill="#666666", font=font)

        status = str(record.get("status", "unknown"))
        fixture_id = str(record.get("fixtureId", "fixture"))
        label_text = f"{fixture_id} [{status}]"
        status_color = {
            "passed": "#1f7a1f",
            "passed_degraded": "#9a6700",
            "failed": "#b42318",
        }.get(status, "#444444")
        draw.text((left, top + tile_height + 8), label_text, fill=status_color, font=font)

        failure = record.get("failure")
        if isinstance(failure, str) and failure:
            trimmed = failure if len(failure) <= 64 else f"{failure[:61]}..."
            draw.text((left, top + tile_height + 28), trimmed, fill="#444444", font=font)

    contact_sheet_path = gallery_dir / "fixture-contact-sheet.png"
    image.save(contact_sheet_path)
    return contact_sheet_path


def get_fixture_specs(skill_root: Path, gallery_dir: Path, repo_root: Path) -> list[FixtureSpec]:
    fixtures_dir = skill_root / "scripts" / "tests" / "fixtures"
    minimal_scene = gallery_dir / "minimal.excalidraw"
    complex_scene = gallery_dir / "complex.excalidraw"
    move_scene = gallery_dir / "move-patch.excalidraw"

    def artifact_args() -> list[str]:
        return ["--artifact-root", str(repo_root)]

    return [
        FixtureSpec(
            fixture_id="minimal",
            file_base="minimal",
            command=[
                "npx", "tsx", "create_scene.ts",
                "--spec", str(fixtures_dir / "minimal_spec.json"),
                "--out", str(minimal_scene),
                "--verify",
                *artifact_args(),
            ],
        ),
        FixtureSpec(
            fixture_id="patch_edit",
            file_base="patch-edit",
            command=[
                "npx", "tsx", "edit_scene.ts",
                "--scene", str(minimal_scene),
                "--patch", str(fixtures_dir / "patch_spec.json"),
                "--out", str(gallery_dir / "patch-edit.excalidraw"),
                "--verify",
                *artifact_args(),
            ],
        ),
        FixtureSpec(
            fixture_id="move_patch",
            file_base="move-patch",
            setup_commands=(
                (
                    "npx", "tsx", "edit_scene.ts",
                    "--scene", str(minimal_scene),
                    "--patch", str(fixtures_dir / "move_patch.json"),
                    "--out", str(move_scene),
                    *artifact_args(),
                ),
            ),
            command=[
                "npx", "tsx", "verify_scene.ts",
                "--scene", str(move_scene),
                *artifact_args(),
            ],
            expected_fail=True,
            scene_path=str(move_scene),
        ),
        FixtureSpec(
            fixture_id="simple_mermaid",
            file_base="simple-mermaid",
            command=[
                "npx", "tsx", "convert_mermaid.ts",
                "--input", str(fixtures_dir / "simple_flowchart.mmd"),
                "--out", str(gallery_dir / "simple-mermaid.excalidraw"),
                "--verify",
                *artifact_args(),
            ],
        ),
        FixtureSpec(
            fixture_id="complex_create",
            file_base="complex",
            command=[
                "npx", "tsx", "create_scene.ts",
                "--spec", str(fixtures_dir / "complex_spec.json"),
                "--out", str(complex_scene),
                "--verify",
                *artifact_args(),
            ],
        ),
        FixtureSpec(
            fixture_id="layered_graph",
            file_base="layered-graph",
            command=[
                "npx", "tsx", "create_scene.ts",
                "--spec", str(fixtures_dir / "layered_graph_spec.json"),
                "--out", str(gallery_dir / "layered-graph.excalidraw"),
                "--verify",
                *artifact_args(),
            ],
        ),
        FixtureSpec(
            fixture_id="clean_flowchart",
            file_base="clean-flowchart",
            command=[
                "npx", "tsx", "create_scene.ts",
                "--spec", str(fixtures_dir / "clean_flowchart_spec.json"),
                "--out", str(gallery_dir / "clean-flowchart.excalidraw"),
                "--verify",
                *artifact_args(),
            ],
        ),
        FixtureSpec(
            fixture_id="complex_edit",
            file_base="complex-edit",
            command=[
                "npx", "tsx", "edit_scene.ts",
                "--scene", str(complex_scene),
                "--patch", str(fixtures_dir / "complex_patch.json"),
                "--out", str(gallery_dir / "complex-edit.excalidraw"),
                "--verify",
                *artifact_args(),
            ],
        ),
        FixtureSpec(
            fixture_id="complex_structured_mermaid",
            file_base="complex-structured-mermaid",
            command=[
                "npx", "tsx", "convert_mermaid.ts",
                "--input", str(fixtures_dir / "complex_structured_flowchart.mmd"),
                "--out", str(gallery_dir / "complex-structured-mermaid.excalidraw"),
                "--verify",
                *artifact_args(),
            ],
        ),
        FixtureSpec(
            fixture_id="overlap",
            file_base="overlap",
            command=[
                "npx", "tsx", "create_scene.ts",
                "--spec", str(fixtures_dir / "overlap_spec.json"),
                "--out", str(gallery_dir / "overlap.excalidraw"),
                "--verify",
                *artifact_args(),
            ],
        ),
        FixtureSpec(
            fixture_id="long_label",
            file_base="long-label",
            command=[
                "npx", "tsx", "create_scene.ts",
                "--spec", str(fixtures_dir / "long_label_spec.json"),
                "--out", str(gallery_dir / "long-label.excalidraw"),
                "--verify",
                *artifact_args(),
            ],
        ),
        FixtureSpec(
            fixture_id="complex_flowchart_strict",
            file_base="complex-flowchart-strict",
            command=[
                "npx", "tsx", "convert_mermaid.ts",
                "--input", str(fixtures_dir / "complex_flowchart.mmd"),
                "--out", str(gallery_dir / "complex-flowchart-strict.excalidraw"),
                *artifact_args(),
            ],
            expected_fail=True,
        ),
    ]


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: python3 build_gallery.py <skill_root>")
        return 1

    skill_root = Path(sys.argv[1]).resolve()
    scripts_dir = skill_root / "scripts"
    repo_root = skill_root.parents[2]
    gallery_dir = repo_root / "test-artifacts" / "gallery"
    ensure_clean_dir(gallery_dir)

    fixtures = get_fixture_specs(skill_root, gallery_dir, repo_root)
    records: list[dict] = []
    mismatches: list[str] = []

    for fixture in fixtures:
        for setup_command in fixture.setup_commands:
            setup_result = run(list(setup_command), scripts_dir)
            if setup_result.returncode != 0:
                print(
                    f"Setup command failed for {fixture.fixture_id}\n"
                    f"stdout:\n{setup_result.stdout}\n"
                    f"stderr:\n{setup_result.stderr}"
                )
                return 1

        result = run(fixture.command, scripts_dir)
        record = build_record(fixture, result, repo_root, gallery_dir)
        records.append(record)
        expectation_met = (result.returncode != 0) == fixture.expected_fail
        if not expectation_met:
            mismatches.append(
                f"{fixture.fixture_id}: expected_fail={fixture.expected_fail} but return_code={result.returncode}"
            )

    summary = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "skillRoot": repo_relative(repo_root, skill_root),
        "galleryDir": repo_relative(repo_root, gallery_dir),
        "fixtures": records,
    }
    summary_path = gallery_dir / "gallery-summary.json"
    summary_path.write_text(json.dumps(summary, indent=2) + "\n")

    contact_sheet_path = build_contact_sheet(summary, repo_root, gallery_dir)
    copy_example_assets(skill_root, gallery_dir, summary_path, contact_sheet_path)

    if mismatches:
        print("Gallery build completed with fixture expectation mismatches:")
        for mismatch in mismatches:
            print(f"- {mismatch}")
        return 1

    print(json.dumps({
        "summaryPath": repo_relative(repo_root, summary_path),
        "contactSheetPath": repo_relative(repo_root, contact_sheet_path),
        "fixtureCount": len(records),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
