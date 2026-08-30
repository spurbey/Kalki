import json
from pathlib import Path

from kalki_runtime.schema_loader import hash_json


def main() -> None:
    fixture_path = Path(__file__).resolve().parents[3] / "fixtures" / "hash-contract.json"
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    actual = hash_json(fixture["value"])
    if actual != fixture["sha256"]:
        raise SystemExit(f"hash mismatch: {actual} != {fixture['sha256']}")
    print("HASH_CONTRACT_OK")


if __name__ == "__main__":
    main()
