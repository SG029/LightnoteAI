"""FastAPI wrapper around the video pipeline.

Deliberately thin: authenticate, hand off to the orchestrator, translate
failures into a stable error shape. All the interesting logic lives in
`app/pipeline/`, which has no web dependencies and can be exercised directly.
"""

from __future__ import annotations

import logging
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from .config import resolve_device, settings
from .gemini_client import GeminiError
from .memory import init_cuda
from .pipeline import lama, video
from .pipeline.orchestrator import PipelineError, run
from .progress import ProgressReporter
from .schemas import ProcessRequest, ProcessResult

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s %(name)-24s %(message)s",
    datefmt="%H:%M:%S",
    stream=sys.stdout,
)
log = logging.getLogger("lightedit")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    device = resolve_device()
    log.info("ML worker starting — device=%s", device)

    if device == "cpu":
        log.warning("Running on CPU. Expect several minutes per clip.")
    else:
        # Create the CUDA context here, on the main thread. Jobs run in a
        # threadpool worker, and letting the context be created there fails
        # on Windows with an opaque "CUDA error: unknown error".
        init_cuda()

    # Model weights still load lazily on first use: startup stays fast, and a
    # machine that only ever serves /health never downloads 2GB it won't use.
    yield
    log.info("ML worker stopped")


app = FastAPI(title="LightEdit ML Worker", version="1.0.0", lifespan=lifespan)


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


@app.get("/health")
async def health() -> dict:
    """Reports what the worker can actually do right now."""
    device = resolve_device()

    gpu: dict[str, object] = {"available": device == "cuda"}
    if device == "cuda":
        try:
            import torch

            free, total = torch.cuda.mem_get_info()
            gpu.update(
                name=torch.cuda.get_device_name(0),
                vramFreeMb=round(free / 1_048_576),
                vramTotalMb=round(total / 1_048_576),
            )
        except Exception as exc:  # noqa: BLE001
            gpu["error"] = str(exc)

    # Import-only checks: cheap, and they surface a broken install before a
    # user waits three minutes to discover it.
    def importable(module: str) -> bool:
        try:
            __import__(module)
            return True
        except Exception:  # noqa: BLE001
            return False

    ffmpeg_ok = True
    try:
        video._run(["ffmpeg", "-version"], what="ffmpeg check")
    except Exception:  # noqa: BLE001
        ffmpeg_ok = False

    return {
        "ok": ffmpeg_ok,
        "device": device,
        "gpu": gpu,
        "ffmpeg": ffmpeg_ok,
        "capabilities": {
            "sam2": importable("transformers"),
            "lama": lama.available(),
            "lamaWeights": (settings.weights_dir / lama.MODEL_FILE).exists(),
            "rembg": importable("rembg"),
            "gemini": bool(settings.gemini_api_key),
        },
        "models": {
            "text": settings.gemini_text_model,
            "image": settings.gemini_image_model,
        },
    }


@app.post("/process", response_model=ProcessResult)
async def process(
    request: ProcessRequest,
    x_internal_secret: str = Header(default=""),
) -> ProcessResult | JSONResponse:
    """Runs a job to completion.

    Blocking by design — Express holds this connection for the whole render
    and treats the response as the job's terminal outcome. Live progress goes
    out-of-band via the callback webhook, so the UI is never waiting on this.
    """
    if x_internal_secret != settings.internal_secret:
        return _error(401, "unauthorized", "Invalid internal secret.")

    reporter = ProgressReporter(request.jobId, request.callbackUrl, settings.internal_secret)
    log.info("job %s — %s %r", request.jobId, request.plan.operation, request.plan.target)

    try:
        # The pipeline is synchronous and CPU/GPU-bound. Running it in a
        # threadpool keeps the event loop free so /health stays responsive
        # while a render is in flight.
        result = await run_in_threadpool(run, request, reporter)
        log.info("job %s complete — strategy=%s", request.jobId, result.strategy)
        return result

    except PipelineError as exc:
        log.warning("job %s failed: %s", request.jobId, exc)
        return _error(422, exc.code, str(exc))

    except GeminiError as exc:
        log.error("job %s — Gemini error: %s", request.jobId, exc)
        return _error(502, "gemini_failed", str(exc))

    except video.VideoError as exc:
        log.error("job %s — ffmpeg error: %s", request.jobId, exc)
        return _error(422, "video_failed", str(exc))

    except Exception as exc:  # noqa: BLE001 — anything else is a bug
        log.exception("job %s — unhandled error", request.jobId)
        return _error(500, "internal_error", f"{type(exc).__name__}: {exc}")

    finally:
        reporter.close()


@app.exception_handler(Exception)
async def unhandled(_request: Request, exc: Exception) -> JSONResponse:
    log.exception("unhandled request error")
    return _error(500, "internal_error", str(exc))
