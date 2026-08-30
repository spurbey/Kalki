from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol, TypeAlias

from .provenance import Provenance

JsonValue: TypeAlias = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]


@dataclass(frozen=True)
class HttpJsonResponse:
    data: Any
    final_url: str
    status: int
    retrieved_at: str
    response_sha256: str


class SafeHttpClient(Protocol):
    def get_json(
        self,
        url: str,
        *,
        params: Mapping[str, str | int | float | bool] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> HttpJsonResponse: ...


@dataclass(frozen=True)
class RecordEnvelope:
    data: dict[str, Any]
    dedupe_key: str
    provenance: Provenance


@dataclass(frozen=True)
class RunContext:
    workspace: Path
    run_id: str
    mode: Literal["test", "production"]
    step_id: str
    input_table: str | None
    output_table: str
    config: Mapping[str, JsonValue]
    limit: int | None
    http: SafeHttpClient


class SourceOperator(Protocol):
    def collect(self, context: RunContext) -> Iterable[RecordEnvelope]: ...


class Transformer(Protocol):
    def transform(self, records: Iterable[RecordEnvelope], context: RunContext) -> Iterable[RecordEnvelope]: ...
