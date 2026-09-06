"""Minimal LaMa inpainting runner.

The obvious dependency here is `simple-lama-inpainting`, but it pins
`pillow<10` while torchvision requires pillow 12, and it has not been released
since 0.1.2 — the two cannot coexist. Since that package is a thin wrapper over
a TorchScript export anyway, the wrapper is reimplemented here against the same
published checkpoint. That removes the conflict and makes the preprocessing
explicit, which matters: LaMa is sensitive to how the mask is prepared.
"""

from __future__ import annotations

import logging
import urllib.request
from pathlib import Path

import numpy as np

from ..config import resolve_device, settings

log = logging.getLogger("lightedit.lama")

MODEL_URL = (
    "https://github.com/enesmsahin/simple-lama-inpainting/"
    "releases/download/v0.1.0/big-lama.pt"
)
MODEL_FILE = "big-lama.pt"

# LaMa's architecture downsamples by 8; inputs must be a multiple of that or
# the skip connections will not line up.
PAD_MODULO = 8

_model = None
_load_failed = False


def _download(dest: Path) -> None:
    log.info("downloading LaMa weights (~200MB, one time) → %s", dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".part")

    # Download to a temp name and rename on success, so an interrupted download
    # cannot leave a truncated file that fails to load on every later run.
    urllib.request.urlretrieve(MODEL_URL, tmp)
    tmp.replace(dest)
    log.info("LaMa weights ready")


def available() -> bool:
    return not _load_failed


def load():
    """Loads the TorchScript model once, downloading weights on first use."""
    global _model, _load_failed
    if _model is not None or _load_failed:
        return _model

    try:
        import torch

        path = settings.weights_dir / MODEL_FILE
        if not path.exists():
            _download(path)

        device = resolve_device()
        model = torch.jit.load(str(path), map_location=device)
        model.eval()
        _model = model
        log.info("LaMa loaded on %s", device)
    except Exception as exc:  # noqa: BLE001 — caller degrades to OpenCV
        log.warning("LaMa unavailable (%s)", exc)
        _load_failed = True

    return _model


def _pad_to_modulo(array: np.ndarray, modulo: int = PAD_MODULO) -> np.ndarray:
    """Symmetric-pads H and W up to the next multiple of `modulo`."""
    height, width = array.shape[-2:]
    pad_h = (modulo - height % modulo) % modulo
    pad_w = (modulo - width % modulo) % modulo
    if pad_h == 0 and pad_w == 0:
        return array
    return np.pad(array, ((0, 0), (0, pad_h), (0, pad_w)), mode="symmetric")


def inpaint(image_rgb: np.ndarray, mask: np.ndarray) -> np.ndarray | None:
    """Fills the masked region.

    `image_rgb` is HxWx3 uint8; `mask` is HxW uint8 where non-zero marks the
    region to remove. Returns HxWx3 uint8, or None if the model is unavailable.
    """
    model = load()
    if model is None:
        return None

    import torch

    height, width = image_rgb.shape[:2]

    # CHW float in [0, 1]; the mask is hard-binarised because LaMa treats any
    # non-zero value as "inpaint here" and a soft edge leaves a visible seam.
    image_chw = np.transpose(image_rgb, (2, 0, 1)).astype(np.float32) / 255.0
    mask_chw = (mask[None, ...] > 127).astype(np.float32)

    image_chw = _pad_to_modulo(image_chw)
    mask_chw = _pad_to_modulo(mask_chw)

    device = resolve_device()
    image_t = torch.from_numpy(image_chw).unsqueeze(0).to(device)
    mask_t = torch.from_numpy(mask_chw).unsqueeze(0).to(device)

    with torch.inference_mode():
        result = model(image_t, mask_t)

    out = result[0].permute(1, 2, 0).detach().cpu().numpy()

    # The published export emits floats in [0, 1]. Clipping to [0, 255]
    # without scaling floors the entire frame to black — and it fails
    # silently, because a black frame is still a valid frame. The range is
    # sniffed rather than assumed so a 0-255 export would also work.
    if float(out.max()) <= 1.5:
        out = out * 255.0

    out = np.clip(out, 0, 255).astype(np.uint8)

    # Undo the padding.
    return out[:height, :width]
