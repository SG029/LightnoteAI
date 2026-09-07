"""Keyless text-to-image generation via Pollinations.

Exists to close a real gap. Gemini's image models return `limit: 0` on a free
API tier — not throttling, but "not available to you at all". Without a second
generator, a replacement request with no reference image has nothing to
composite and degrades to a plain removal.

Pollinations needs no API key and no SDK: the image endpoint is a single GET
whose path *is* the prompt. That makes it a dependency-free fallback, at the
cost of being an unauthenticated third-party service with no availability
guarantee — so every failure path here returns None and lets the caller drop
to the next tier.
"""

from __future__ import annotations

import logging
from urllib.parse import quote

import httpx

log = logging.getLogger("lightedit.pollinations")

ENDPOINT = "https://image.pollinations.ai/prompt"

# flux gives the most photographic product renders of the free models.
MODEL = "flux"

# Square keeps the subject centred and un-cropped; the compositor rescales to
# the tracked box anyway, so the aspect here does not need to match the target.
SIZE = 768

TIMEOUT_SEC = 120.0


def generate(prompt: str, *, seed: int = 7, size: int = SIZE) -> bytes | None:
    """Renders `prompt` and returns image bytes, or None if unavailable.

    `seed` is fixed by default so the same instruction produces the same
    replacement across runs — the pipeline is otherwise deterministic, and a
    render that changes every attempt is impossible to debug.
    """
    # The prompt travels in the URL path, so "/" and "?" must not survive
    # unescaped or they will truncate it into a different request.
    url = f"{ENDPOINT}/{quote(prompt, safe='')}"

    params = {
        "width": size,
        "height": size,
        "seed": seed,
        "model": MODEL,
        "nologo": "true",
        # Suppresses the public feed; these frames come from a user's video.
        "private": "true",
    }

    try:
        response = httpx.get(url, params=params, timeout=TIMEOUT_SEC, follow_redirects=True)
    except httpx.HTTPError as exc:
        log.warning("pollinations unreachable: %s", exc)
        return None

    if response.status_code != 200:
        log.warning("pollinations returned %s", response.status_code)
        return None

    content_type = response.headers.get("content-type", "")
    if not content_type.startswith("image/"):
        # An error page served with a 200 would otherwise be written to disk
        # as a "png" and fail much later, in the decoder.
        log.warning("pollinations returned %r, not an image", content_type)
        return None

    data = response.content
    if len(data) < 1024:
        log.warning("pollinations returned %d bytes — too small to be an image", len(data))
        return None

    log.info("pollinations rendered %.0f KB", len(data) / 1024)
    return data


def build_prompt(replacement: str) -> str:
    """Wraps the user's replacement text in product-shot framing.

    The compositor needs a clean silhouette it can matte out, so the prompt
    asks for exactly that rather than an artistic scene.
    """
    return (
        f"{replacement}, professional product photograph, centred, "
        f"filling the frame, isolated on a plain flat white background, "
        f"soft even studio lighting, no shadow, no reflection, no text overlay, "
        f"no other objects, photorealistic, sharp focus"
    )
