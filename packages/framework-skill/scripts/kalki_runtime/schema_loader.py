import hashlib
import json
import math
import re
import struct
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urlparse

import yaml

SCHEMA_KEYS = {"version", "table", "columns"}
TABLE_KEYS = {"slug", "name", "kind", "description", "primary_key"}
COLUMN_KEYS = {"name", "type", "nullable", "description", "minimum", "maximum", "pattern", "values"}
TYPES = {"string", "integer", "number", "boolean", "date", "datetime", "url", "enum"}
SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
COLUMN_NAME = re.compile(r"^[a-z][a-z0-9_]*$")
MAX_SAFE_JSON_NUMBER = 2**53 - 1


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True)


def _utf16_hex(value: str) -> str:
    return value.encode("utf-16-be", "surrogatepass").hex()


def _hash_tree(value: object) -> object:
    if value is None:
        return {"t": "null"}
    if isinstance(value, bool):
        return {"t": "boolean", "v": value}
    if isinstance(value, (int, float)):
        try:
            if isinstance(value, int) and abs(value) > MAX_SAFE_JSON_NUMBER:
                raise ValueError
            number = float(value)
            if not math.isfinite(number) or abs(number) > MAX_SAFE_JSON_NUMBER:
                raise ValueError
            if number == 0:
                number = 0.0
            encoded = struct.pack(">d", number).hex()
        except (OverflowError, ValueError, struct.error) as error:
            raise TypeError("Value is not JSON serializable") from error
        return {"t": "number", "v": encoded}
    if isinstance(value, str):
        return {"t": "string", "v": _utf16_hex(value)}
    if isinstance(value, list):
        return {"t": "array", "v": [_hash_tree(item) for item in value]}
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise TypeError("Value is not JSON serializable")
        entries = [
            [_utf16_hex(key), _hash_tree(value[key])]
            for key in sorted(value, key=lambda item: item.encode("utf-16-be", "surrogatepass"))
        ]
        return {"t": "object", "v": entries}
    raise TypeError("Value is not JSON serializable")


def hash_json(value: object) -> str:
    return hashlib.sha256(canonical_json(_hash_tree(value)).encode("utf-8")).hexdigest()


def load_yaml(path: Path) -> dict[str, object]:
    value = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a YAML object")
    return value


def validate_schema(schema: dict[str, object]) -> dict[str, object]:
    if set(schema) != SCHEMA_KEYS or schema.get("version") != 1:
        raise ValueError("schema must contain only version, table, and columns")
    table = schema.get("table")
    columns = schema.get("columns")
    if not isinstance(table, dict) or set(table) != TABLE_KEYS:
        raise ValueError("table metadata is invalid")
    if not isinstance(columns, list) or not columns:
        raise ValueError("schema requires at least one column")
    if not isinstance(table.get("slug"), str) or not SLUG.fullmatch(table["slug"]):
        raise ValueError("table slug is invalid")
    if table.get("kind") not in {"source", "derived"}:
        raise ValueError("table kind must be source or derived")
    if not isinstance(table.get("name"), str) or not table["name"].strip():
        raise ValueError("table name is required")
    if not isinstance(table.get("description"), str) or not table["description"].strip():
        raise ValueError("table description is required")
    primary_key = table.get("primary_key")
    if not isinstance(primary_key, list) or not primary_key or len(set(primary_key)) != len(primary_key):
        raise ValueError("primary_key must contain unique column names")

    by_name: dict[str, dict[str, object]] = {}
    for column in columns:
        if not isinstance(column, dict) or not set(column).issubset(COLUMN_KEYS):
            raise ValueError("column definition is invalid")
        if not {"name", "type", "nullable", "description"}.issubset(column):
            raise ValueError("column is missing a required field")
        name = column["name"]
        kind = column["type"]
        if not isinstance(name, str) or not COLUMN_NAME.fullmatch(name) or name in by_name:
            raise ValueError("column names must be unique snake_case identifiers")
        if kind not in TYPES or not isinstance(column["nullable"], bool):
            raise ValueError(f"column '{name}' has an invalid type or nullable value")
        if not isinstance(column["description"], str) or not column["description"].strip():
            raise ValueError(f"column '{name}' requires a description")
        for bound in ("minimum", "maximum"):
            if bound not in column:
                continue
            value = column[bound]
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"column '{name}' has an invalid {bound}")
            try:
                numeric = float(value)
            except (OverflowError, ValueError):
                raise ValueError(f"column '{name}' has an invalid {bound}") from None
            if not math.isfinite(numeric) or abs(numeric) > MAX_SAFE_JSON_NUMBER:
                raise ValueError(f"column '{name}' has an invalid {bound}")
        if kind == "enum" and not isinstance(column.get("values"), list):
            raise ValueError(f"enum column '{name}' requires values")
        if kind != "enum" and "values" in column:
            raise ValueError(f"values are only valid for enum columns: {name}")
        by_name[name] = column

    for key in primary_key:
        if key not in by_name or by_name[key]["nullable"]:
            raise ValueError(f"primary-key column '{key}' must exist and be non-nullable")
    return schema


def load_schema(path: Path) -> dict[str, object]:
    return validate_schema(load_yaml(path))


def schema_hash(schema: dict[str, object]) -> str:
    return hash_json(schema)


def aggregate_schema_hash(entries: list[tuple[str, str]]) -> str:
    return hash_json([{"path": path, "sha256": sha256} for path, sha256 in sorted(entries)])


def _valid_value(value: object, column: dict[str, object]) -> bool:
    kind = column["type"]
    if value is None:
        return bool(column["nullable"])
    if kind == "string":
        valid = isinstance(value, str)
    elif kind == "integer":
        valid = isinstance(value, int) and not isinstance(value, bool)
    elif kind == "number":
        valid = isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    elif kind == "boolean":
        valid = isinstance(value, bool)
    elif kind == "date":
        valid = isinstance(value, str) and _parses_date(value)
    elif kind == "datetime":
        valid = isinstance(value, str) and _parses_datetime(value)
    elif kind == "url":
        valid = isinstance(value, str) and urlparse(value).scheme in {"http", "https"}
    else:
        valid = isinstance(value, str) and value in column.get("values", [])
    if not valid:
        return False
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in column and value < column["minimum"]:
            return False
        if "maximum" in column and value > column["maximum"]:
            return False
    if isinstance(value, str) and "pattern" in column and not re.search(str(column["pattern"]), value):
        return False
    return True


def _parses_date(value: str) -> bool:
    try:
        date.fromisoformat(value)
        return True
    except ValueError:
        return False


def _parses_datetime(value: str) -> bool:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.tzinfo is not None
    except ValueError:
        return False


def validate_data(schema: dict[str, object], data: dict[str, object]) -> None:
    columns = schema["columns"]
    expected = {column["name"] for column in columns}
    if set(data) != expected:
        raise ValueError(f"row columns do not match schema '{schema['table']['slug']}'")
    for column in columns:
        if not _valid_value(data[column["name"]], column):
            raise ValueError(f"invalid value for column '{column['name']}'")


def dedupe_key(schema: dict[str, object], data: dict[str, object]) -> str:
    values = [data[name] for name in schema["table"]["primary_key"]]
    return str(values[0]) if len(values) == 1 else canonical_json(values)
