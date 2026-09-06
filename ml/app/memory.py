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
