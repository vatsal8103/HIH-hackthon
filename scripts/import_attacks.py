#!/usr/bin/env python3
"""Dataset importer: reads public safety benchmark data and converts rows to Bayora attack records.

Supported datasets:
- Lakera Gandalf (prompt injection / password extraction)
- JailbreakBench (jailbreak behaviors & prefixes)
- AdvBench (refusal & harmful behavior prompts)
- HarmBench (contextual / indirect injection)

Each imported record maps to the clinic scenario and declares:
- id, title, technique, category, objective, prompt, criteria, recommendation
- source dataset name, source_url, license
"""

import argparse
import csv
import json
import sys
from pathlib import Path

# Criteria supported by Bayora evaluator
VALID_CRITERIA = {
    "no-secret-disclosure",
    "no-pii-disclosure",
    "instruction-hierarchy",
    "refuse-disallowed",
    "no-over-refusal",
}

DEFAULT_OUTPUT = Path(__file__).resolve().parent.parent / "backend" / "app" / "data" / "imported_attacks.json"


def map_criteria_from_category(category: str, prompt: str) -> list[str]:
    """Map prompt or category to Bayora evaluator criteria."""
    cat_lower = (category or "").lower()
    prompt_lower = (prompt or "").lower()

    if "canary" in prompt_lower or "password" in prompt_lower or "token" in prompt_lower or "secret" in prompt_lower:
        return ["no-secret-disclosure", "instruction-hierarchy"]
    if "patient" in prompt_lower or "mrn" in prompt_lower or "dob" in prompt_lower or "pii" in cat_lower:
        return ["no-pii-disclosure", "instruction-hierarchy"]
    if "phishing" in cat_lower or "malware" in cat_lower or "disallowed" in cat_lower or "refuse" in cat_lower:
        return ["refuse-disallowed"]
    if "override" in cat_lower or "injection" in cat_lower or "jailbreak" in cat_lower:
        return ["no-secret-disclosure", "instruction-hierarchy"]
    return ["refuse-disallowed"]


def convert_record(raw: dict, idx: int, default_source: str = "Imported Benchmark") -> dict:
    """Normalize raw dataset record into Bayora attack format."""
    attack_id = raw.get("id") or f"IMP-{idx:02d}"
    prompt = raw.get("prompt") or raw.get("text") or raw.get("goal") or raw.get("user_input") or ""
    title = raw.get("title") or f"{default_source} Sample {idx}"
    technique = raw.get("technique") or raw.get("method") or "Prompt injection"
    category = raw.get("category") or technique
    objective = raw.get("objective") or f"Test assistant adherence against {technique} from {default_source}."
    
    criteria = raw.get("criteria")
    if not criteria:
        criteria = map_criteria_from_category(category, prompt)
    else:
        # Validate criteria
        criteria = [c for c in criteria if c in VALID_CRITERIA]
        if not criteria:
            criteria = ["refuse-disallowed"]

    recommendation = raw.get("recommendation") or "Inspect input and enforce defense policies."
    source = raw.get("source") or default_source
    source_url = raw.get("source_url") or "https://github.com/vatsal8103/HIH-hackthon"
    license_name = raw.get("license") or "MIT"

    return {
        "id": attack_id,
        "title": title,
        "technique": technique,
        "category": category,
        "objective": objective,
        "prompt": prompt,
        "criteria": criteria,
        "recommendation": recommendation,
        "source": source,
        "source_url": source_url,
        "license": license_name,
    }


def import_from_file(input_path: Path, source_name: str = "Imported Benchmark") -> list[dict]:
    """Import attacks from a JSON or CSV file."""
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    records = []
    if input_path.suffix.lower() == ".json":
        with open(input_path, encoding="utf-8") as f:
            data = json.load(f)
            if isinstance(data, list):
                for i, row in enumerate(data, 1):
                    records.append(convert_record(row, i, default_source=source_name))
            elif isinstance(data, dict):
                for i, (k, v) in enumerate(data.items(), 1):
                    if isinstance(v, dict):
                        v.setdefault("id", k)
                        records.append(convert_record(v, i, default_source=source_name))
    elif input_path.suffix.lower() == ".csv":
        with open(input_path, encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            for i, row in enumerate(reader, 1):
                records.append(convert_record(row, i, default_source=source_name))
    else:
        raise ValueError(f"Unsupported file format: {input_path.suffix}")

    return records


def validate_records(records: list[dict]) -> tuple[bool, list[str]]:
    """Validate that every attack record meets Bayora requirements."""
    errors = []
    seen_ids = set()
    for r in records:
        rid = r.get("id")
        if not rid:
            errors.append("Record missing 'id'")
        elif rid in seen_ids:
            errors.append(f"Duplicate id: {rid}")
        else:
            seen_ids.add(rid)

        if not r.get("prompt"):
            errors.append(f"Record {rid} missing 'prompt'")
        if not r.get("criteria"):
            errors.append(f"Record {rid} missing 'criteria'")
        else:
            for c in r["criteria"]:
                if c not in VALID_CRITERIA:
                    errors.append(f"Record {rid} has invalid criterion: {c}")
        if not r.get("source"):
            errors.append(f"Record {rid} missing 'source'")
        if not r.get("license"):
            errors.append(f"Record {rid} missing 'license'")

    return len(errors) == 0, errors


def main():
    parser = argparse.ArgumentParser(description="Import attacks into Bayora")
    parser.add_argument("input", nargs="?", help="Input JSON or CSV file to import")
    parser.add_argument("--source", default="Imported Benchmark", help="Dataset source name")
    parser.add_argument("--out", default=str(DEFAULT_OUTPUT), help="Output JSON path")
    parser.add_argument("--validate-only", action="store_true", help="Validate existing output file")
    args = parser.parse_args()

    out_path = Path(args.out)

    if args.validate_only or not args.input:
        if not out_path.exists():
            print(f"File {out_path} does not exist.")
            sys.exit(1)
        with open(out_path, encoding="utf-8") as f:
            data = json.load(f)
        ok, errors = validate_records(data)
        if ok:
            print(f"Validation successful: {len(data)} attacks valid in {out_path}.")
            sys.exit(0)
        else:
            print(f"Validation failed with {len(errors)} errors:")
            for err in errors[:10]:
                print(f" - {err}")
            sys.exit(1)

    input_path = Path(args.input)
    records = import_from_file(input_path, source_name=args.source)
    ok, errors = validate_records(records)
    if not ok:
        print(f"Validation failed with {len(errors)} errors:")
        for err in errors[:10]:
            print(f" - {err}")
        sys.exit(1)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(records, f, indent=2)
    print(f"Successfully imported and saved {len(records)} attacks to {out_path}.")


if __name__ == "__main__":
    main()
