"""Wire contracts between the Express API and this worker.

These mirror `server/src/types.ts`. The two are kept in sync by hand — a
shared codegen step would be over-engineering for two consumers, but the
field names must match exactly, so change them together.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Operation = Literal["replace", "remove"]
Strategy = Literal["gemini_keyframe", "reference_composite", "removal_only"]
StageName = Literal["intent", "ground", "track", "clean", "compose", "encode"]


class EditPlan(BaseModel):
    """Gemini's structured reading of the user's instruction."""

    operation: Operation
    target: str
    replacement: str | None = None
    targetHint: str | None = None
    confidence: float = 1.0
    reasoning: str = ""


class ProcessOptions(BaseModel):
    targetHeight: int = 720
    maxDurationSec: float = 15.0
    forceCpu: bool = False


class ProcessRequest(BaseModel):
    jobId: str
    plan: EditPlan
    videoPath: str
    refImagePath: str | None = None
    callbackUrl: str
    options: ProcessOptions = Field(default_factory=ProcessOptions)


class ProcessResult(BaseModel):
    outputPath: str
    maskPreviewPath: str | None = None
    assetPath: str | None = None
    strategy: Strategy


class ErrorBody(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorBody


# ── Gemini grounding response ────────────────────────────────────────────
# Gemini returns both a box and a polygon mask. The polygon seeds SAM 2 and
# doubles as the fallback mask when SAM 2 is unavailable.


class Detection(BaseModel):
    box_2d: list[int] = Field(
        description="Bounding box as [ymin, xmin, ymax, xmax], normalised to 0-1000."
    )
    mask: list[list[int]] | None = Field(
        default=None,
        description="Segmentation outline as a polygon of [x, y] points, normalised to 0-1000.",
    )
    label: str = Field(description="What was detected.")
    confidence: float = Field(
        default=1.0, description="0-1 confidence that this is the requested target."
    )


class DetectionResponse(BaseModel):
    detections: list[Detection]
