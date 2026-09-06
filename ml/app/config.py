"""Configuration for the ML worker, read from the repository-root .env."""

from __future__ import annotations

import os
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Must be set before torch initialises its allocator. Without it, repeated
# allocate/free cycles across pipeline stages fragment the CUDA heap badly
# enough that a 96MB request fails with gigabytes reportedly free.
# Unsupported on Windows, where setting it only emits a warning per process.
if os.name != "nt":
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

# ml/app/config.py -> ml/app -> ml -> repo root
ROOT_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    """One .env at the repo root feeds Express and this worker alike."""

    model_config = SettingsConfigDict(
        env_file=ROOT_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    gemini_api_key: str = ""
    gemini_text_model: str = "gemini-3.5-flash"
    gemini_image_model: str = "gemini-3.1-flash-image"

    internal_secret: str = "change-me-to-anything"

    target_height: int = 720
    max_duration_sec: float = 15.0
    force_cpu: bool = False

    @property
    def storage(self) -> Path:
        return ROOT_DIR / "storage"

    @property
    def frames_dir(self) -> Path:
        return self.storage / "frames"

    @property
    def outputs_dir(self) -> Path:
        return self.storage / "outputs"

    @property
    def weights_dir(self) -> Path:
        return ROOT_DIR / "ml" / "weights"


settings = Settings()

for _directory in (settings.frames_dir, settings.outputs_dir, settings.weights_dir):
    _directory.mkdir(parents=True, exist_ok=True)


def resolve_device() -> str:
    """CUDA when available and not overridden, else CPU."""
    if settings.force_cpu:
        return "cpu"
    try:
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"
    except ImportError:
        return "cpu"
