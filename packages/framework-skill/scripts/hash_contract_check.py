import json
from pathlib import Path

from kalki_runtime.schema_loader import MAX_SAFE_JSON_NUMBER, hash_json, validate_schema


def main() -> None:
    fixture_path = Path(__file__).resolve().parents[3] / "fixtures" / "hash-contract.json"
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    actual = hash_json(fixture["value"])
    if actual != fixture["sha256"]:
        raise SystemExit(f"hash mismatch: {actual} != {fixture['sha256']}")
    try:
        hash_json({"unsafe": 2**53})
    except TypeError:
        pass
    else:
        raise SystemExit("unsafe integer was accepted")
    schema = {
        "version": 1,
        "table": {
            "slug": "prices",
            "name": "Prices",
            "kind": "source",
            "description": "Price history",
            "primary_key": ["value"],
        },
        "columns": [
            {
                "name": "value",
                "type": "number",
                "nullable": False,
                "description": "A price",
            }
        ],
    }
    for bound in ("minimum", "maximum"):
        for value in (MAX_SAFE_JSON_NUMBER + 1, -(MAX_SAFE_JSON_NUMBER + 1)):
            invalid = {**schema, "columns": [{**schema["columns"][0], bound: value}]}
            try:
                validate_schema(invalid)
            except ValueError:
                continue
            raise SystemExit(f"unsafe schema {bound} was accepted")
    print("HASH_CONTRACT_OK")


if __name__ == "__main__":
    main()
