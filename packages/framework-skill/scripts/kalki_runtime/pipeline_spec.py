import ast
import hashlib
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from .schema_loader import aggregate_schema_hash, hash_json, load_schema, load_yaml, schema_hash

TOP_KEYS = {"version", "pipeline", "source", "transforms", "execution"}
PIPELINE_KEYS = {"slug", "name", "task_path", "support_paths"}
SOURCE_KEYS = {"id", "table", "schema_path", "operator", "config"}
TRANSFORM_KEYS = {"id", "input_table", "output_table", "schema_path", "transformer", "config"}
EXECUTION_KEYS = {
    "test_limit",
    "publication_batch_size",
    "request_timeout_seconds",
    "request_max_attempts",
    "request_backoff_seconds",
    "max_response_bytes",
    "allowed_hosts",
}
DISALLOWED_IMPORTS = {"httpx", "requests", "socket", "subprocess", "urllib.request"}


@dataclass(frozen=True)
class LoadedPipeline:
    workspace: Path
    relative_path: str
    data: dict[str, object]
    schemas: dict[str, dict[str, object]]
    task_hash: str
    schema_hash: str
    pipeline_hash: str


def workspace_path(workspace: Path, relative: str) -> Path:
    segments = relative.split("/")
    path = PurePosixPath(relative)
    if path.is_absolute() or "\\" in relative or any(part in {"", ".", ".."} for part in segments):
        raise ValueError(f"invalid workspace-relative path: {relative}")
    resolved = workspace.joinpath(*path.parts).resolve()
    if resolved != workspace and workspace not in resolved.parents:
        raise ValueError(f"path escapes workspace: {relative}")
    return resolved


def _exact(value: object, keys: set[str], label: str) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError(f"{label} must contain exactly: {', '.join(sorted(keys))}")
    return value


def _class_reference(workspace: Path, reference: object, method: str) -> str:
    if not isinstance(reference, str) or reference.count(":") != 1:
        raise ValueError("class reference must use path.py:ClassName")
    relative, class_name = reference.split(":")
    path = workspace_path(workspace, relative)
    if path.suffix != ".py" or not path.is_file() or not class_name.isidentifier():
        raise ValueError(f"invalid class reference: {reference}")
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    target = next((node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == class_name), None)
    if target is None or not any(isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == method for node in target.body):
        raise ValueError(f"{reference} must define {method}()")
    for node in ast.walk(tree):
        names: list[str] = []
        if isinstance(node, ast.Import):
            names = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module:
            names = [node.module]
        if any(name in DISALLOWED_IMPORTS for name in names):
            raise ValueError(f"direct network or subprocess import is not allowed in {relative}")
    return relative


def _text_hash(path: Path) -> str:
    text = path.read_text(encoding="utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def load_pipeline(workspace: Path, relative_path: str) -> LoadedPipeline:
    workspace = workspace.resolve()
    pipeline_path = workspace_path(workspace, relative_path)
    data = load_yaml(pipeline_path)
    if set(data) != TOP_KEYS or data.get("version") != 1:
        raise ValueError("pipeline has invalid top-level keys or version")

    pipeline = _exact(data["pipeline"], PIPELINE_KEYS, "pipeline")
    source = _exact(data["source"], SOURCE_KEYS, "source")
    execution = _exact(data["execution"], EXECUTION_KEYS, "execution")
    transforms = data["transforms"]
    if not isinstance(transforms, list) or not transforms:
        raise ValueError("pipeline requires at least one transform")
    transforms = [_exact(item, TRANSFORM_KEYS, "transform") for item in transforms]

    task_path = pipeline["task_path"]
    if not isinstance(task_path, str) or not workspace_path(workspace, task_path).is_file():
        raise ValueError("pipeline task_path does not exist")
    support_paths = pipeline["support_paths"]
    if not isinstance(support_paths, list) or not all(isinstance(path, str) for path in support_paths):
        raise ValueError("support_paths must be a list of relative paths")

    source_file = _class_reference(workspace, source["operator"], "collect")
    implementation_files = {source_file, *support_paths}
    schemas: dict[str, dict[str, object]] = {}
    schema_entries: list[tuple[str, str]] = []

    source_schema_path = source["schema_path"]
    if not isinstance(source_schema_path, str):
        raise ValueError("source schema_path is required")
    source_schema = load_schema(workspace_path(workspace, source_schema_path))
    if source_schema["table"]["slug"] != source["table"] or source_schema["table"]["kind"] != "source":
        raise ValueError("source table does not match its schema")
    schemas[str(source["table"])] = source_schema
    schema_entries.append((source_schema_path, schema_hash(source_schema)))

    available = {str(source["table"])}
    step_ids = {source["id"]}
    for transform in transforms:
        if transform["id"] in step_ids or transform["input_table"] not in available:
            raise ValueError("transform order or step id is invalid")
        step_ids.add(transform["id"])
        relative = _class_reference(workspace, transform["transformer"], "transform")
        implementation_files.add(relative)
        schema_path = transform["schema_path"]
        if not isinstance(schema_path, str):
            raise ValueError("transform schema_path is required")
        schema = load_schema(workspace_path(workspace, schema_path))
        output = str(transform["output_table"])
        if schema["table"]["slug"] != output or schema["table"]["kind"] != "derived" or output in available:
            raise ValueError("transform output does not match a unique derived schema")
        schemas[output] = schema
        schema_entries.append((schema_path, schema_hash(schema)))
        available.add(output)

    if not isinstance(execution["test_limit"], int) or not 1 <= execution["test_limit"] <= 5:
        raise ValueError("test_limit must be between 1 and 5")
    if not isinstance(execution["allowed_hosts"], list) or not execution["allowed_hosts"]:
        raise ValueError("allowed_hosts must be non-empty")
    for relative in implementation_files:
        if not isinstance(relative, str) or not workspace_path(workspace, relative).is_file():
            raise ValueError(f"implementation file does not exist: {relative}")

    files = [
        {"path": relative, "sha256": _text_hash(workspace_path(workspace, relative))}
        for relative in sorted(implementation_files)
    ]
    task_hash = _text_hash(workspace_path(workspace, task_path))
    return LoadedPipeline(
        workspace=workspace,
        relative_path=relative_path,
        data=data,
        schemas=schemas,
        task_hash=task_hash,
        schema_hash=aggregate_schema_hash(schema_entries),
        pipeline_hash=hash_json({"pipeline": data, "files": files}),
    )
