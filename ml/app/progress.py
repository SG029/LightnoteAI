"""Streams stage-level progress back to the Express API.

The worker is deliberately fire-and-forget about these updates: a failed
webhook must never abort a render that is otherwise succeeding. Every send
is wrapped, and failures are logged and dropped.
"""

from __future__ import annotations

import logging
import time
from contextlib import contextmanager
from typing import Any, Iterator, Literal

import httpx

from .schemas import StageName

log = logging.getLogger("lightedit.progress")

StageStatus = Literal["running", "done", "skipped", "failed"]


class StageHandle:
    """Reports incremental progress within a single stage."""

    def __init__(self, reporter: ProgressReporter, name: StageName) -> None:
        self._reporter = reporter
        self._name = name
        self._last_sent = -1.0
        self.started = time.monotonic()

    def progress(self, fraction: float, detail: str | None = None) -> None:
        """Push a progress fraction (0-1).

        Per-frame loops call this hundreds of times; sending every call would
        generate more HTTP traffic than actual work. Updates are throttled to
        whole-percent changes, with the endpoints always sent.
        """
        fraction = max(0.0, min(1.0, fraction))
        if fraction not in (0.0, 1.0) and abs(fraction - self._last_sent) < 0.01:
            return
        self._last_sent = fraction
        self._reporter.update(self._name, "running", progress=fraction, detail=detail)

    def detail(self, text: str) -> None:
        self._reporter.update(self._name, "running", detail=text)


class ProgressReporter:
    def __init__(self, job_id: str, callback_url: str, secret: str) -> None:
        self.job_id = job_id
        self.callback_url = callback_url
        self._client = httpx.Client(
            timeout=5.0,
            headers={"x-internal-secret": secret, "content-type": "application/json"},
        )

    def update(
        self,
        stage: StageName,
        status: StageStatus,
        *,
        progress: float | None = None,
        detail: str | None = None,
        ms: int | None = None,
        **extra: Any,
    ) -> None:
        payload: dict[str, Any] = {"stage": stage, "status": status}
        if progress is not None:
            payload["progress"] = round(progress, 4)
        if detail is not None:
            payload["detail"] = detail
        if ms is not None:
            payload["ms"] = ms
        payload.update({k: v for k, v in extra.items() if v is not None})

        try:
            self._client.post(self.callback_url, json=payload)
        except Exception as exc:  # noqa: BLE001 — progress is best-effort
            log.warning("progress update dropped (%s %s): %s", stage, status, exc)

    @contextmanager
    def stage(self, name: StageName, detail: str | None = None) -> Iterator[StageHandle]:
        """Wraps a pipeline stage: marks it running, times it, closes it out.

        On exception the stage is marked failed before the error propagates,
        so the UI highlights exactly where the pipeline broke.
        """
        handle = StageHandle(self, name)
        self.update(name, "running", progress=0.0, detail=detail)
        try:
            yield handle
        except Exception as exc:  # noqa: BLE001 — re-raised after reporting
            elapsed = int((time.monotonic() - handle.started) * 1000)
            self.update(
                name,
                "failed",
                ms=elapsed,
                detail=str(exc)[:300],
                error={"code": type(exc).__name__, "message": str(exc)[:300]},
            )
            raise
        else:
            elapsed = int((time.monotonic() - handle.started) * 1000)
            self.update(name, "done", progress=1.0, ms=elapsed)

    def skip(self, name: StageName, reason: str) -> None:
        """Marks a stage skipped — e.g. compose during a removal-only job."""
        self.update(name, "skipped", progress=1.0, detail=reason)

    def close(self) -> None:
        self._client.close()
