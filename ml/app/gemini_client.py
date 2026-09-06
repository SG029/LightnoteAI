"""Shared Gemini client and response helpers.

Mirrors `server/src/services/gemini.ts`. Both sides target the same
`interactions.create` surface: `response_format` takes the JSON Schema
directly and `response_mime_type` is a sibling field, while the reply
arrives as a list of content blocks in `outputs`.
"""

from __future__ import annotations

import base64
import logging
import mimetypes
import time
from pathlib import Path
from typing import Any

from google import genai

from .config import settings

log = logging.getLogger("lightedit.gemini")


class GeminiError(RuntimeError):
    """Gemini was unreachable, refused the request, or returned junk."""


_client: genai.Client | None = None


def client() -> genai.Client:
    global _client
    if _client is None:
        if not settings.gemini_api_key:
            raise GeminiError("GEMINI_API_KEY is not set. Add it to the .env file at the repo root.")
        _client = genai.Client(api_key=settings.gemini_api_key)
    return _client


def image_part(path: Path) -> dict[str, Any]:
    """Inlines a local image as base64.

    Preferred over the Files API here: these frames are single-use, and an
    upload plus a delete per call would add two round trips per job for no
    benefit at keyframe resolution.
    """
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    return {"type": "image", "data": data, "mime_type": mime}


def _field(obj: Any, name: str) -> Any:
    """Reads a field whether the SDK gave us an object or a plain dict."""
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def _content_blocks(interaction: Any) -> list[Any]:
    """All content blocks of a response, across schema versions.

    The May 2026 change replaced the flat `outputs[]` array with `steps[]`,
    where each step has a type discriminator and its own content list. Both
    are walked so the worker keeps functioning across an SDK upgrade.
    """
    blocks: list[Any] = []

    for step in _field(interaction, "steps") or []:
        if _field(step, "type") == "model_output":
            blocks.extend(_field(step, "content") or [])

    if not blocks:
        blocks.extend(_field(interaction, "outputs") or [])

    return blocks


def extract_text(interaction: Any) -> str:
    """Concatenates the text blocks of a response, ignoring thought blocks."""
    convenience = _field(interaction, "output_text")
    if isinstance(convenience, str) and convenience.strip():
        return convenience.strip()

    chunks = [
        text
        for block in _content_blocks(interaction)
        if _field(block, "type") == "text" and (text := _field(block, "text"))
    ]
    return "".join(chunks).strip()


def extract_image(interaction: Any) -> bytes | None:
    """Returns the first generated image as raw bytes, if the response has one."""
    for block in _content_blocks(interaction):
        if _field(block, "type") != "image":
            continue
        data = _field(block, "data")
        if data:
            return base64.b64decode(data)

    return None


def call(
    *,
    model: str,
    inputs: Any,
    system_instruction: str | None = None,
    response_schema: dict[str, Any] | None = None,
    response_modalities: list[str] | None = None,
    temperature: float = 0.0,
    attempts: int = 3,
    label: str = "gemini",
) -> Any:
    """Calls Gemini with retry on transient failures.

    Non-retryable errors (bad key, malformed request) are surfaced on the
    first attempt rather than burning three round trips to fail identically.
    """
    kwargs: dict[str, Any] = {
        "model": model,
        "input": inputs,
        "generation_config": {"temperature": temperature},
    }
    if system_instruction:
        kwargs["system_instruction"] = system_instruction
    if response_schema is not None:
        # The schema nests inside response_format. Passing it flat with a
        # sibling response_mime_type — which the SDK's own docstring implies —
        # is rejected with "responseFormat must be set when responseMimeType
        # is set". Verified against the live API.
        kwargs["response_format"] = {
            "type": "text",
            "mime_type": "application/json",
            "schema": response_schema,
        }
    if response_modalities:
        kwargs["response_modalities"] = response_modalities

    last: Exception | None = None

    for attempt in range(1, attempts + 1):
        try:
            return client().interactions.create(**kwargs)
        except Exception as exc:  # noqa: BLE001 — classified below
            last = exc
            text = str(exc).lower()

            if any(marker in text for marker in ("api key", "unauthenticated", "permission denied", "401", "403")):
                raise GeminiError(
                    "Gemini rejected the API key. Check GEMINI_API_KEY in .env."
                ) from exc

            # "limit: 0" is not throttling — the model is not available to this
            # tier at all, which is the case for the image models on the free
            # tier. Retrying cannot help, and the caller has a fallback that
            # can, so surface it immediately instead of burning the backoff.
            if "limit: 0" in text:
                raise GeminiError(
                    f"Model '{model}' is not available on this API tier "
                    f"(quota limit is 0). Supply a reference image, or enable "
                    f"billing on your Google AI Studio account."
                ) from exc
            if "not found" in text and "model" in text:
                raise GeminiError(
                    f"Model '{model}' is not available to this key. "
                    f"Try a different value in .env."
                ) from exc

            if attempt == attempts:
                break

            backoff = 2 ** (attempt - 1) * 0.5
            log.warning("%s attempt %d failed (%s); retrying in %.1fs", label, attempt, exc, backoff)
            time.sleep(backoff)

    raise GeminiError(f"{label} failed after {attempts} attempts: {last}") from last
