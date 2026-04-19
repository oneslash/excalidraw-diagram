#!/usr/bin/env python3
"""
Validate the Excalidraw skill structure and run smoke tests.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

MAX_SKILL_NAME_LENGTH = 64


def run(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=cwd,
        text=True,
        capture_output=True,
        check=False,
    )


def assert_ok(result: subprocess.CompletedProcess[str], label: str) -> None:
    if result.returncode != 0:
        raise RuntimeError(
            f"{label} failed\n"
            f"stdout:\n{result.stdout}\n"
            f"stderr:\n{result.stderr}"
        )


def assert_failed(result: subprocess.CompletedProcess[str], label: str) -> None:
    if result.returncode == 0:
        raise RuntimeError(
            f"{label} unexpectedly succeeded\n"
            f"stdout:\n{result.stdout}\n"
            f"stderr:\n{result.stderr}"
        )


def load_json_output(result: subprocess.CompletedProcess[str], label: str) -> dict:
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(
            f"{label} did not emit valid JSON\n"
            f"stdout:\n{result.stdout}\n"
            f"stderr:\n{result.stderr}"
        ) from error


def load_frontmatter(skill_md_path: Path) -> dict:
    content = skill_md_path.read_text()
    if not content.startswith("---"):
        raise RuntimeError("SKILL.md is missing YAML frontmatter")
    match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
    if not match:
        raise RuntimeError("SKILL.md has invalid frontmatter format")
    return parse_simple_yaml_block(match.group(1))


def strip_wrapping_quotes(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def parse_simple_yaml_block(text: str) -> dict:
    result: dict[str, object] = {}
    stack: list[tuple[int, dict[str, object]]] = [(-1, result)]

    for raw_line in text.splitlines():
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" "))
        stripped = raw_line.strip()
        if ":" not in stripped:
            raise RuntimeError(f"Unsupported YAML line: {raw_line}")
        key, raw_value = stripped.split(":", 1)
        key = key.strip()
        value = raw_value.strip()

        while len(stack) > 1 and indent <= stack[-1][0]:
            stack.pop()

        current = stack[-1][1]
        if value == "":
            nested: dict[str, object] = {}
            current[key] = nested
            stack.append((indent, nested))
            continue

        current[key] = strip_wrapping_quotes(value)

    return result


def validate_skill_metadata(skill_root: Path) -> None:
    skill_md_path = skill_root / "SKILL.md"
    if not skill_md_path.exists():
        raise RuntimeError("SKILL.md not found")

    frontmatter = load_frontmatter(skill_md_path)
    expected_keys = {"name", "description"}
    actual_keys = set(frontmatter.keys())
    if actual_keys != expected_keys:
        raise RuntimeError(
            f"SKILL.md frontmatter must contain exactly {sorted(expected_keys)}; found {sorted(actual_keys)}"
        )

    name = str(frontmatter["name"]).strip()
    if not re.fullmatch(r"[a-z0-9-]+", name):
        raise RuntimeError("Skill name must be lowercase hyphen-case")
    if name.startswith("-") or name.endswith("-") or "--" in name:
        raise RuntimeError("Skill name cannot start/end with a hyphen or contain consecutive hyphens")
    if len(name) > MAX_SKILL_NAME_LENGTH:
        raise RuntimeError(f"Skill name exceeds {MAX_SKILL_NAME_LENGTH} characters")

    description = str(frontmatter["description"]).strip()
    if not description:
        raise RuntimeError("Skill description cannot be empty")
    if "<" in description or ">" in description:
        raise RuntimeError("Skill description cannot contain angle brackets")

    interface_path = skill_root / "agents" / "openai.yaml"
    if not interface_path.exists():
        raise RuntimeError("agents/openai.yaml not found")

    interface_doc = parse_simple_yaml_block(interface_path.read_text())
    interface = interface_doc.get("interface") or {}
    for key in ("display_name", "short_description", "default_prompt"):
        if not isinstance(interface.get(key), str) or not interface[key].strip():
            raise RuntimeError(f"agents/openai.yaml is missing interface.{key}")
    if "$excalidraw-diagram" not in interface["default_prompt"]:
        raise RuntimeError("interface.default_prompt must mention $excalidraw-diagram")


def validate_references(skill_root: Path) -> None:
    skill_md = (skill_root / "SKILL.md").read_text()
    for reference in re.findall(r"`(references/[^`]+)`", skill_md):
        if not (skill_root / reference).exists():
            raise RuntimeError(f"Missing referenced file: {reference}")


def smoke_test_scripts(skill_root: Path) -> None:
    scripts_dir = skill_root / "scripts"
    fixtures_dir = scripts_dir / "tests" / "fixtures"

    typecheck = run(["npm", "run", "typecheck"], scripts_dir)
    assert_ok(typecheck, "Typecheck")
    build_runtime = run(["npm", "run", "build_runtime"], scripts_dir)
    assert_ok(build_runtime, "Runtime bundle build")

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_path = Path(tmpdir)
        scene_path = tmp_path / "scene.excalidraw"
        edited_path = tmp_path / "scene-edited.excalidraw"
        svg_path = tmp_path / "scene.svg"
        mermaid_scene_path = tmp_path / "mermaid.excalidraw"
        repaired_path = tmp_path / "repaired.excalidraw"
        broken_repaired_path = tmp_path / "broken-repaired.excalidraw"

        create = run(
            [
                "npx",
                "tsx",
                "create_scene.ts",
                "--spec",
                str(fixtures_dir / "minimal_spec.json"),
                "--out",
                str(scene_path),
                "--verify",
            ],
            scripts_dir,
        )
        assert_ok(create, "create_scene.ts")
        if not scene_path.exists():
            raise RuntimeError("create_scene.ts did not produce the expected scene file")
        create_report = load_json_output(create, "create_scene.ts")
        if create_report["verification"]["screenshot"]["width"] <= 0:
            raise RuntimeError("create_scene.ts verification did not produce a usable screenshot")
        if create_report["verification"]["inspectSummary"]["qualityWarnings"]:
            raise RuntimeError("create_scene.ts produced quality warnings for the simple fixture")

        inspect = run(
            ["npx", "tsx", "inspect_scene.ts", "--scene", str(scene_path)],
            scripts_dir,
        )
        assert_ok(inspect, "inspect_scene.ts")
        inspect_report = load_json_output(inspect, "inspect_scene.ts")
        if inspect_report["duplicateIds"]:
            raise RuntimeError("Simple scene unexpectedly produced duplicate IDs")

        export_svg = run(
            ["npx", "tsx", "export_svg.ts", "--scene", str(scene_path), "--out", str(svg_path)],
            scripts_dir,
        )
        assert_ok(export_svg, "export_svg.ts")
        if not svg_path.exists():
            raise RuntimeError("export_svg.ts did not produce the expected SVG file")
        export_report = load_json_output(export_svg, "export_svg.ts")
        if export_report["summary"]["width"] <= 0:
            raise RuntimeError("export_svg.ts reported a non-positive SVG width")

        verify = run(
            ["npx", "tsx", "verify_scene.ts", "--scene", str(scene_path)],
            scripts_dir,
        )
        assert_ok(verify, "verify_scene.ts")
        verify_report = load_json_output(verify, "verify_scene.ts")
        if verify_report["screenshot"]["height"] <= 0:
            raise RuntimeError("verify_scene.ts did not produce a usable screenshot")

        edit = run(
            [
                "npx",
                "tsx",
                "edit_scene.ts",
                "--scene",
                str(scene_path),
                "--patch",
                str(fixtures_dir / "patch_spec.json"),
                "--out",
                str(edited_path),
                "--verify",
            ],
            scripts_dir,
        )
        assert_ok(edit, "edit_scene.ts")
        if not edited_path.exists():
            raise RuntimeError("edit_scene.ts did not produce the expected output scene")
        edit_report = load_json_output(edit, "edit_scene.ts")
        if "frame:backend-frame" not in edit_report["report"]["applied"]:
            raise RuntimeError("edit_scene.ts did not apply the expected frame operation")
        if edit_report["verification"]["inspectSummary"]["qualityWarnings"]:
            raise RuntimeError("edit_scene.ts produced quality warnings for the simple fixture")

        convert = run(
            [
                "npx",
                "tsx",
                "convert_mermaid.ts",
                "--input",
                str(fixtures_dir / "simple_flowchart.mmd"),
                "--out",
                str(mermaid_scene_path),
                "--verify",
            ],
            scripts_dir,
        )
        assert_ok(convert, "convert_mermaid.ts")
        convert_report = load_json_output(convert, "convert_mermaid.ts")
        if not convert_report["report"]["treatedAsFlowchart"]:
            raise RuntimeError("convert_mermaid.ts did not recognize the simple flowchart")
        if convert_report["verification"]["inspectSummary"]["qualityWarnings"]:
            raise RuntimeError("convert_mermaid.ts produced quality warnings for the simple flowchart")

        repair = run(
            [
                "npx",
                "tsx",
                "repair_scene.ts",
                "--input",
                str(fixtures_dir / "clipboard_fragment.json"),
                "--out",
                str(repaired_path),
                "--verify",
            ],
            scripts_dir,
        )
        assert_ok(repair, "repair_scene.ts")
        if not repaired_path.exists():
            raise RuntimeError("repair_scene.ts did not produce the expected repaired scene")
        repair_report = load_json_output(repair, "repair_scene.ts")
        if repair_report["kind"] != "clipboard":
            raise RuntimeError("repair_scene.ts should report clipboard input for clipboard repair")
        if repair_report["verification"]["inspectSummary"]["qualityWarnings"]:
            raise RuntimeError("repair_scene.ts produced quality warnings after clipboard normalization")

        broken_repair = run(
            [
                "npx",
                "tsx",
                "repair_scene.ts",
                "--input",
                str(fixtures_dir / "broken_scene.excalidraw"),
                "--out",
                str(broken_repaired_path),
                "--refresh-text-dimensions",
                "true",
            ],
            scripts_dir,
        )
        assert_ok(broken_repair, "repair_scene.ts on broken scene")
        if not broken_repaired_path.exists():
            raise RuntimeError("repair_scene.ts did not repair the broken scene fixture")
        broken_report = load_json_output(broken_repair, "repair_scene.ts on broken scene")
        if not broken_report["report"]["duplicateIds"]:
            raise RuntimeError("repair_scene.ts should report duplicate IDs on the broken scene fixture")
        repaired_broken_scene = json.loads(broken_repaired_path.read_text())
        if repaired_broken_scene.get("type") != "excalidraw":
            raise RuntimeError("repair_scene.ts should normalize the broken fixture back to a scene")
        if not isinstance(repaired_broken_scene.get("appState"), dict):
            raise RuntimeError("repair_scene.ts should restore appState on the broken scene fixture")

        missing_file_inspect = run(
            [
                "npx",
                "tsx",
                "inspect_scene.ts",
                "--scene",
                str(fixtures_dir / "image_missing_file.excalidraw"),
            ],
            scripts_dir,
        )
        assert_ok(missing_file_inspect, "inspect_scene.ts on missing image file fixture")
        missing_file_report = load_json_output(missing_file_inspect, "inspect_scene.ts on missing image file fixture")
        if "missing-file-id" not in missing_file_report["missingFileIds"]:
            raise RuntimeError("inspect_scene.ts should report missing image file IDs")

        complex_scene_path = tmp_path / "complex-scene.excalidraw"
        complex_edited_path = tmp_path / "complex-edited.excalidraw"
        complex_create = run(
            [
                "npx",
                "tsx",
                "create_scene.ts",
                "--spec",
                str(fixtures_dir / "complex_spec.json"),
                "--out",
                str(complex_scene_path),
                "--verify",
            ],
            scripts_dir,
        )
        assert_ok(complex_create, "complex create_scene.ts")
        complex_create_report = load_json_output(complex_create, "complex create_scene.ts")
        if complex_create_report["report"]["frameCount"] != 2:
            raise RuntimeError("complex create_scene.ts should create two frames")
        if complex_create_report["verification"]["screenshot"]["width"] < 1000:
            raise RuntimeError("complex create_scene.ts screenshot width is unexpectedly small")
        if complex_create_report["verification"]["inspectSummary"]["qualityWarnings"]:
            raise RuntimeError("complex create_scene.ts produced quality warnings for the clean complex fixture")

        rich_flowchart_path = tmp_path / "clean-flowchart.excalidraw"
        rich_flowchart_create = run(
            [
                "npx",
                "tsx",
                "create_scene.ts",
                "--spec",
                str(fixtures_dir / "clean_flowchart_spec.json"),
                "--out",
                str(rich_flowchart_path),
                "--verify",
            ],
            scripts_dir,
        )
        assert_ok(rich_flowchart_create, "clean flowchart create_scene.ts")
        rich_flowchart_report = load_json_output(rich_flowchart_create, "clean flowchart create_scene.ts")
        if not rich_flowchart_report["report"]["usesRichFlowchartPrimitives"]:
            raise RuntimeError("clean flowchart fixture should exercise the rich flowchart primitives")
        if rich_flowchart_report["report"]["swimlaneCount"] != 3:
            raise RuntimeError("clean flowchart fixture should create three swimlanes")
        if rich_flowchart_report["verification"]["inspectSummary"]["qualityWarnings"]:
            raise RuntimeError("clean flowchart fixture should verify cleanly")
        if rich_flowchart_report["report"]["preset"] != "clean-flowchart":
            raise RuntimeError("clean flowchart fixture should preserve the clean-flowchart preset")
        element_types = rich_flowchart_report["verification"]["inspectSummary"].get("elementTypeCounts")
        if not isinstance(element_types, dict):
            raise RuntimeError("clean flowchart fixture should report element type counts")
        if element_types.get("frame", 0) < 3:
            raise RuntimeError("clean flowchart fixture should create frame-backed swimlanes")
        rich_flowchart_metrics = rich_flowchart_report["verification"]["inspectSummary"].get("qualityMetrics")
        if not isinstance(rich_flowchart_metrics, dict):
            raise RuntimeError("clean flowchart fixture should report quality metrics")
        if rich_flowchart_metrics.get("edgeLabelOverlaps", 0) != 0:
            raise RuntimeError("clean flowchart fixture should not leave edge labels overlapping shapes")

        layered_graph_path = tmp_path / "layered-graph.excalidraw"
        layered_graph_create = run(
            [
                "npx",
                "tsx",
                "create_scene.ts",
                "--spec",
                str(fixtures_dir / "layered_graph_spec.json"),
                "--out",
                str(layered_graph_path),
                "--verify",
            ],
            scripts_dir,
        )
        assert_ok(layered_graph_create, "layered graph create_scene.ts")
        layered_graph_report = load_json_output(layered_graph_create, "layered graph create_scene.ts")
        if layered_graph_report["report"].get("layoutEngine") != "elk":
            raise RuntimeError("layered graph fixture should exercise the ELK layout engine")
        if layered_graph_report["verification"]["inspectSummary"]["qualityWarnings"]:
            raise RuntimeError("layered graph fixture should verify cleanly")
        layered_metrics = layered_graph_report["verification"]["inspectSummary"].get("qualityMetrics")
        if not isinstance(layered_metrics, dict):
            raise RuntimeError("layered graph fixture should report quality metrics")
        if layered_metrics.get("sameRankBentEdgeCount", 99) > 1:
            raise RuntimeError("layered graph fixture should avoid excessive bent same-rank edges")
        if layered_metrics.get("worstEdgeDetourRatio", 99) > 2.0:
            raise RuntimeError("layered graph fixture should keep edge detours bounded")

        complex_edit = run(
            [
                "npx",
                "tsx",
                "edit_scene.ts",
                "--scene",
                str(complex_scene_path),
                "--patch",
                str(fixtures_dir / "complex_patch.json"),
                "--out",
                str(complex_edited_path),
                "--verify",
            ],
            scripts_dir,
        )
        assert_ok(complex_edit, "complex edit_scene.ts")
        complex_edit_report = load_json_output(complex_edit, "complex edit_scene.ts")
        expected_ops = {
            "rename:db",
            "move:cache",
            "set-style:api",
            "add-node:retry-dlq",
            "connect:worker->retry-dlq",
            "connect:retry-dlq->alerts",
            "frame:ops-frame",
            "delete:ops-note",
        }
        if set(complex_edit_report["report"]["applied"]) != expected_ops:
            raise RuntimeError("complex edit_scene.ts did not apply the expected operations")
        if complex_edit_report["verification"]["inspectSummary"]["qualityWarnings"]:
            raise RuntimeError("complex edit_scene.ts produced quality warnings for the clean complex fixture")
        if complex_edit_report["verification"]["inspectSummary"].get("frameIssues"):
            raise RuntimeError("complex edit_scene.ts should end with all frame children contained")

        complex_mermaid_scene_path = tmp_path / "complex-mermaid.excalidraw"
        complex_convert = run(
            [
                "npx",
                "tsx",
                "convert_mermaid.ts",
                "--input",
                str(fixtures_dir / "complex_structured_flowchart.mmd"),
                "--out",
                str(complex_mermaid_scene_path),
                "--verify",
            ],
            scripts_dir,
        )
        assert_ok(complex_convert, "complex convert_mermaid.ts")
        complex_convert_report = load_json_output(complex_convert, "complex convert_mermaid.ts")
        if complex_convert_report["verification"]["inspectSummary"]["totalElements"] < 10:
            raise RuntimeError("complex convert_mermaid.ts produced fewer elements than expected")
        if complex_convert_report["verification"]["inspectSummary"]["qualityWarnings"]:
            raise RuntimeError("complex convert_mermaid.ts produced quality warnings for the structured flowchart")

        strict_image_fallback = run(
            [
                "npx",
                "tsx",
                "convert_mermaid.ts",
                "--input",
                str(fixtures_dir / "complex_flowchart.mmd"),
                "--out",
                str(tmp_path / "should-fail-image-fallback.excalidraw"),
            ],
            scripts_dir,
        )
        assert_failed(strict_image_fallback, "strict Mermaid image fallback conversion")
        strict_image_output = (strict_image_fallback.stdout + strict_image_fallback.stderr).lower()
        if "editable excalidraw geometry" not in strict_image_output and "embedded image" not in strict_image_output:
            raise RuntimeError("strict Mermaid image fallback should explain that editable geometry was rejected")

        strict_mermaid = run(
            [
                "npx",
                "tsx",
                "convert_mermaid.ts",
                "--input",
                str(fixtures_dir / "non_flowchart.mmd"),
                "--out",
                str(tmp_path / "should-not-exist.excalidraw"),
            ],
            scripts_dir,
        )
        assert_failed(strict_mermaid, "strict non-flowchart Mermaid conversion")
        strict_mermaid_output = strict_mermaid.stderr + strict_mermaid.stdout
        if "flowchart-only" not in strict_mermaid_output and "mermaid flowchart" not in strict_mermaid_output.lower():
            raise RuntimeError("strict non-flowchart Mermaid conversion failed without the expected flowchart-only explanation")

        removed_fallback = run(
            [
                "npx",
                "tsx",
                "convert_mermaid.ts",
                "--input",
                str(fixtures_dir / "non_flowchart.mmd"),
                "--strict-flowchart",
                "false",
                "--out",
                str(tmp_path / "should-not-exist-nonstrict.excalidraw"),
            ],
            scripts_dir,
        )
        assert_failed(removed_fallback, "removed Mermaid fallback conversion")
        removed_fallback_output = removed_fallback.stderr + removed_fallback.stdout
        if "best-effort mermaid fallback has been removed" not in removed_fallback_output.lower():
            raise RuntimeError("removed Mermaid fallback should explain that the escape hatch no longer exists")

        corrupted_scene_data = json.loads(complex_scene_path.read_text())
        corrupted_scene_data["elements"].append(dict(corrupted_scene_data["elements"][0]))
        corrupted_path = tmp_path / "corrupted.excalidraw"
        corrupted_path.write_text(json.dumps(corrupted_scene_data, indent=2))
        corrupted_inspect = run(
            ["npx", "tsx", "inspect_scene.ts", "--scene", str(corrupted_path)],
            scripts_dir,
        )
        assert_ok(corrupted_inspect, "inspect_scene.ts on corrupted scene")
        corrupted_report = load_json_output(corrupted_inspect, "inspect_scene.ts on corrupted scene")
        if not corrupted_report["duplicateIds"]:
            raise RuntimeError("inspect_scene.ts should report duplicate IDs on a corrupted scene")

        # Hard-case: edge references a nonexistent endpoint -> must fail loudly.
        bad_edge = run(
            [
                "npx",
                "tsx",
                "create_scene.ts",
                "--spec",
                str(fixtures_dir / "bad_edge_spec.json"),
                "--out",
                str(tmp_path / "bad-edge.excalidraw"),
            ],
            scripts_dir,
        )
        assert_failed(bad_edge, "create_scene.ts with missing edge endpoint")
        combined = (bad_edge.stdout + bad_edge.stderr).lower()
        if "nonexistent" not in combined:
            raise RuntimeError(
                "create_scene.ts should mention the missing endpoint id in its error message"
            )

        # Hard-case: duplicate node ids in the spec -> must fail loudly.
        dup_ids = run(
            [
                "npx",
                "tsx",
                "create_scene.ts",
                "--spec",
                str(fixtures_dir / "duplicate_ids_spec.json"),
                "--out",
                str(tmp_path / "dup-ids.excalidraw"),
            ],
            scripts_dir,
        )
        assert_failed(dup_ids, "create_scene.ts with duplicate ids")
        if "duplicate" not in (dup_ids.stdout + dup_ids.stderr).lower():
            raise RuntimeError(
                "create_scene.ts should mention 'duplicate' when the spec contains duplicate ids"
            )

        # Hard-case: two rectangles start overlapped, but manual-layout nudging should clean it up.
        overlap_scene_path = tmp_path / "overlap.excalidraw"
        overlap_create = run(
            [
                "npx",
                "tsx",
                "create_scene.ts",
                "--spec",
                str(fixtures_dir / "overlap_spec.json"),
                "--out",
                str(overlap_scene_path),
                "--verify",
            ],
            scripts_dir,
        )
        assert_ok(overlap_create, "overlap create_scene.ts")
        overlap_report = load_json_output(overlap_create, "overlap create_scene.ts")
        overlap_metrics = overlap_report["verification"]["inspectSummary"].get("qualityMetrics")
        if not isinstance(overlap_metrics, dict):
            raise RuntimeError("overlap fixture should report quality metrics")
        if overlap_metrics.get("nodeOverlaps", 0) != 0:
            raise RuntimeError(
                "overlap fixture should be auto-nudged into a clean layout"
            )
        overlap_warnings = overlap_report["verification"]["inspectSummary"]["qualityWarnings"]
        if overlap_warnings:
            raise RuntimeError("overlap fixture should not emit quality warnings after nudging")

        # Hard-case: long labels should now auto-widen cleanly instead of passing with a warning.
        long_label_create = run(
            [
                "npx",
                "tsx",
                "create_scene.ts",
                "--spec",
                str(fixtures_dir / "long_label_spec.json"),
                "--out",
                str(tmp_path / "long-label.excalidraw"),
                "--verify",
            ],
            scripts_dir,
        )
        assert_ok(long_label_create, "long label create_scene.ts")
        long_label_report = load_json_output(long_label_create, "long label create_scene.ts")
        long_label_metrics = long_label_report["verification"]["inspectSummary"].get("qualityMetrics")
        if not isinstance(long_label_metrics, dict):
            raise RuntimeError("long label fixture should report quality metrics")
        if long_label_metrics.get("nodeOverlaps", 0) != 0:
            raise RuntimeError(
                "long label fixture should no longer overlap after pre-sizing and nudging"
            )
        long_label_warnings = long_label_report["verification"]["inspectSummary"]["qualityWarnings"]
        if long_label_warnings:
            raise RuntimeError("long label fixture should auto-repair to a warning-free result")

        # Hard-case: moving a bound node far away should now fail verification instead of passing
        # with a warning budget of zero.
        moved_path = tmp_path / "moved.excalidraw"
        moved_edit = run(
            [
                "npx",
                "tsx",
                "edit_scene.ts",
                "--scene",
                str(scene_path),
                "--patch",
                str(fixtures_dir / "move_patch.json"),
                "--out",
                str(moved_path),
                "--verify",
            ],
            scripts_dir,
        )
        assert_failed(moved_edit, "move_patch edit_scene.ts with strict verification")
        moved_output = (moved_edit.stdout + moved_edit.stderr).lower()
        if "sparse" not in moved_output and "sprawl" not in moved_output:
            raise RuntimeError("move_patch edit_scene.ts should fail because of sparse / sprawled layout")

        moved_apply_only = run(
            [
                "npx",
                "tsx",
                "edit_scene.ts",
                "--scene",
                str(scene_path),
                "--patch",
                str(fixtures_dir / "move_patch.json"),
                "--out",
                str(moved_path),
            ],
            scripts_dir,
        )
        assert_ok(moved_apply_only, "move_patch edit_scene.ts without verification")
        moved_scene = json.loads(moved_path.read_text())
        moved_db = next(
            (e for e in moved_scene["elements"] if e.get("id") == "db"),
            None,
        )
        if moved_db is None:
            raise RuntimeError("move_patch edit_scene.ts lost the moved node 'db'")
        if moved_db.get("x") != 2000 or moved_db.get("y") != 2000:
            raise RuntimeError(
                f"moved node 'db' should be at (2000, 2000), got ({moved_db.get('x')}, {moved_db.get('y')})"
            )
        api_db_arrow = next(
            (
                e
                for e in moved_scene["elements"]
                if e.get("type") == "arrow" and (e.get("endBinding") or {}).get("elementId") == "db"
            ),
            None,
        )
        if api_db_arrow is None:
            raise RuntimeError(
                "arrow bound to moved node 'db' lost its endBinding after the move"
            )


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: python3 quick_validate.py <skill_root>")
        return 1

    skill_root = Path(sys.argv[1]).resolve()
    try:
        validate_skill_metadata(skill_root)
        validate_references(skill_root)
        smoke_test_scripts(skill_root)
    except Exception as error:  # pylint: disable=broad-except
        print(str(error))
        return 1

    print("Skill validation passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
