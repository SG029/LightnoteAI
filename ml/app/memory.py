"""Memory hygiene between pipeline stages.

Each stage allocates heavily and then stops needing any of it — SAM 2's
sessions, LaMa's activations, decoded frame buffers. Python will free those
eventually, but "eventually" is not good enough here for two reasons: the
next stage's peak lands on top of the previous stage's garbage, and ffmpeg
runs as a *subprocess*, so it needs headroom this process is still holding.

On Windows the binding constraint is usually the commit limit rather than
physical RAM. A machine with 12GB free can still fail a 96MB allocation when
the page file is small, and the error surfaces as a confusing CUDA OOM that
names plenty of free VRAM.
"""

from __future__ import annotations

import gc
import logging

log = logging.getLogger("lightedit.memory")


def bind_cuda_thread() -> None:
    """Binds the calling thread to the CUDA device.

    The pipeline runs in a uvicorn threadpool worker, not the main thread.
    On Windows a CUDA context established on one thread is not automatically
    current on another, and the symptom is a bare `RuntimeError: CUDA error:
    unknown error` from whatever kernel happens to launch first — with a
    stack trace pointing at an innocent op, because kernel errors surface
    asynchronously.

    Setting the device explicitly on entry makes the context current for this
    thread. Cheap enough to call at the top of every GPU stage.
    """
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.set_device(0)
    except Exception as exc:  # noqa: BLE001 — CPU path must still work
        log.debug("could not bind CUDA thread: %s", exc)


def init_cuda() -> None:
    """Creates the CUDA context up front, on the main thread.

    Called during startup so the first job does not pay context creation on a
    threadpool worker — which is exactly the situation that fails above.
    """
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.init()
            torch.cuda.set_device(0)
            # A trivial allocation forces the context to actually materialise;
            # is_available() alone does not create one.
            torch.zeros(1, device="cuda")
            log.info("CUDA context initialised on %s", torch.cuda.get_device_name(0))
    except Exception as exc:  # noqa: BLE001
        log.warning("CUDA init failed (%s) — pipeline will use CPU", exc)


def release() -> None:
    """Drops freed allocations back to the OS. Safe to call anywhere."""
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception:  # noqa: BLE001 — best-effort by design
        pass


def snapshot() -> str:
    """One-line memory summary for logs."""
    parts: list[str] = []

    try:
        import psutil  # type: ignore

        vm = psutil.virtual_memory()
        parts.append(f"ram {vm.available / 1_073_741_824:.1f}GB free")
    except Exception:  # noqa: BLE001 — psutil is optional
        pass

    try:
        import torch

        if torch.cuda.is_available():
            free, total = torch.cuda.mem_get_info()
            parts.append(f"vram {free / 1_073_741_824:.1f}/{total / 1_073_741_824:.1f}GB free")
    except Exception:  # noqa: BLE001
        pass

    return "  ".join(parts) or "unavailable"
