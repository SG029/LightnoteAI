# LightEdit

**Edit objects in a video by describing the change in plain English.**

Upload a clip, type *"Replace the Coca-Cola bottle with Pepsi"*, and get the
video back with the object swapped — tracked frame by frame, not pasted on.
Removal (*"Remove the bottle"*) works through the same pipeline.

```
"Replace the Coca-Cola bottle with Pepsi"
                  │
                  ▼
      { operation:   "replace",
        target:      "Coca-Cola bottle",
        replacement: "Pepsi" }
                  │
   ┌──────────────┴───────────────┐
   │  locate → track → erase →    │
   │  composite → encode          │
   └──────────────┬───────────────┘
                  ▼
              output.mp4
```

---

## Contents

- [Quick start](#quick-start)
- [Architecture](#architecture)
- [The pipeline](#the-pipeline)
- [Engineering decisions](#engineering-decisions)
- [API](#api)
- [Configuration](#configuration)
- [Project structure](#project-structure)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)

---

## Quick start

### Prerequisites

| Requirement | Notes |
|---|---|
| **Node 20+** | |
| **Python 3.10+** | |
| **ffmpeg + ffprobe** | on `PATH` — `winget install Gyan.FFmpeg` / `brew install ffmpeg` |
| **MongoDB** | `winget install MongoDB.Server` — installs and runs as a Windows service. `docker compose up -d` also works. |
| **Gemini API key** | free at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| NVIDIA GPU, 6GB+ | *optional* — without one it falls back to CPU, several minutes per clip |

### Setup

```bash
git clone <your-repo-url> LightnoteAI
cd LightnoteAI

npm install
npm run setup          # checks tools, builds the venv, installs everything
```

Then open `.env` and add your key:

```env
GEMINI_API_KEY=your_key_here
```

Verify the environment, then start all three services:

```bash
npm run doctor         # ✓ node ✓ python ✓ ffmpeg ✓ gpu ✓ mongodb ✓ .env
npm run dev
```

| Service | URL |
|---|---|
| Web app | http://localhost:5173 |
| API | http://localhost:4000 |
| ML worker | http://localhost:8000 |

### No test footage handy?

```bash
npm run sample
```

Renders `storage/uploads/sample-can.mp4` — a red soda can sliding across a
desk. Upload it and try *"Replace the red soda can with a Pepsi can"* or
*"Remove the red can"*.

> **First run downloads model weights** — SAM 2 (~180MB) and LaMa (~200MB),
> cached afterwards. The first job is slower than every job after it.

---

## Architecture

Three processes, each doing what its language is good at.

```
┌──────────────────────────────────────────────────────────────────┐
│  React + Vite                                              :5173 │
│  Landing · Studio · History                                      │
└───────────────────────────┬──────────────────────────────────────┘
                            │  REST + Server-Sent Events
┌───────────────────────────▼──────────────────────────────────────┐
│  Express 5 + Mongoose                                      :4000 │
│                                                                  │
│  • multipart upload, ffprobe validation                          │
│  • Gemini intent parsing  ← runs BEFORE dispatch                 │
│  • job lifecycle + queue (concurrency 1)                         │
│  • SSE fan-out to the browser                                    │
└──────────┬────────────────────────────────▲──────────────────────┘
           │ POST /process                  │ POST /internal/…/progress
           │ (blocking, holds the render)   │ (per-stage updates)
┌──────────▼────────────────────────────────┴──────────────────────┐
│  FastAPI + PyTorch CUDA                                    :8000 │
│  models stay warm in VRAM between jobs                           │
│                                                                  │
│  Gemini grounding → SAM 2 → LaMa → composite → ffmpeg            │
└──────────────────────────────────────────────────────────────────┘
                            │
                     ┌──────▼──────┐
                     │  MongoDB    │  jobs · plans · stages · history
                     └─────────────┘
```

**Why intent parsing lives in Express.** It is a text-only call that takes
about a second. Running it before dispatch means the API can return the parsed
plan immediately — the UI renders it while the job is still queued — and an
unusable instruction is rejected with a `400` instead of consuming three
minutes of GPU time. The Gemini calls that need pixels (grounding, asset
generation) live in the worker, where the frames are.

---

## The pipeline

| # | Stage | What runs | Why this and not the obvious alternative |
|---|---|---|---|
| 1 | **Understand** | Gemini, JSON-schema constrained | Structured output means no JSON repair and no regex parsing. Low-confidence instructions are rejected up front. |
| 2 | **Locate** | Gemini spatial grounding | *Not* OWLv2/GroundingDINO. Those are CLIP-derived: strong on `bottle`, weak on `Coca-Cola bottle`. Brand-level identity is exactly what this product is asked for. Gemini also returns a polygon outline, not just a box. |
| 3 | **Track** | SAM 2 (`Sam2VideoModel`) | A video model with streaming memory, so one box on one frame becomes a mask on every frame that survives motion and partial occlusion. Falls back to an OpenCV CSRT tracker if SAM 2 cannot load. |
| 4 | **Erase** | LaMa (TorchScript) | *Not* a diffusion inpainter. LaMa is one feed-forward pass (tens of ms/frame vs tens of seconds) and **deterministic** — consecutive frames reconstruct the background identically instead of visibly boiling. |
| 5 | **Composite** | Generate once, track everywhere | The replacement is rendered a single time and follows the tracked path. See below. |
| 6 | **Encode** | ffmpeg → H.264 | Original audio carried across untouched. |

A `remove` job is stages 1–4 and stops.

### The core idea: generate once, track everywhere

The tempting approach is to run a generative edit on every frame. It produces
strobing garbage — each frame is sampled independently, so the replacement
object's shape, colour and branding drift from frame to frame.

Instead the replacement is generated **once**, then composited along the mask
path that SAM 2 produced. Temporal coherence is structural rather than
something the model has to be coaxed into. Gemini does the creative work; the
tracker does the temporal work.

The honest trade-off: the asset is a 2D billboard following a 2D path. It does
not relight, rotate, or reveal another face as the scene moves. For a bottle
held on a table this reads fine. For an object that turns around, it does not.

### Graceful degradation

Each replacement tier falls through to the next rather than failing the job:

| Tier | Method | When |
|---|---|---|
| `gemini_keyframe` | Gemini's image model renders the replacement, conditioned on a crop of the real scene for lighting and angle — plus your reference image if supplied | best quality, but **unavailable on a free API key** (see below) |
| `reference_composite` | Your reference image, background removed, used directly | whenever you supply a reference image |
| `generated_composite` | Pollinations renders the replacement from text — keyless, no quota | no reference image supplied |
| `removal_only` | No asset — the object is erased and the background reconstructed | nothing else worked |

> **On the free Gemini tier, image generation is not available.** Both
> `gemini-2.5-flash-image` and `gemini-3.1-flash-image` return `429` with
> `limit: 0` — which is "not available to this tier", not throttling. That is
> precisely why tier 3 exists: Pollinations needs no key, so replacement still
> works end to end without billing. Text generation and grounding are
> unaffected and run on Gemini as normal.

The tier that actually ran is recorded on the job and shown in the UI, so a
degraded result is labelled rather than passed off as a full success.

---

## Engineering decisions

**Two services instead of one.** The video work is Python — SAM 2, LaMa and
PyTorch have no credible Node equivalent. The alternative, spawning a Python
subprocess per job, would reload ~2GB of weights every time (~20s of dead time
per render). An HTTP boundary keeps the models warm and lets Node stay
non-blocking.

**`/process` blocks on purpose.** The worker holds the connection open for the
whole render and returns the terminal result. The alternative — `202 Accepted`
plus a completion webhook — duplicates success and failure handling across two
code paths. Blocking means a crashed worker surfaces as a rejected promise with
the stack intact. Live progress streams independently over the webhook, so the
UI never waits on it.

**Queue concurrency is 1.** There is one GPU. Running two renders concurrently
on 6GB of VRAM causes CUDA OOM, not throughput. The queue exists so the API can
accept work instantly and report a position rather than blocking the request.

It is an in-process queue backed by MongoDB — the right size for a single-GPU
deployment, and honest about it. Every consumer goes through `enqueue()` /
`getQueuePosition()`, so moving to BullMQ or Redis is a change to
[`dispatcher.ts`](server/src/services/dispatcher.ts) alone.

**SSE with a polling fallback.** Stage transitions should appear the instant
they happen. But an `EventSource` can drop for reasons unrelated to the job — a
suspended laptop, a proxy restart — and a frozen progress bar is worse than
being a second behind, so a failed stream degrades to polling instead of
erroring.

**LaMa is vendored, not installed.** `simple-lama-inpainting` pins `pillow<10`
while torchvision requires pillow 12 — unresolvable, and it has not been
released since 0.1.2. [`lama.py`](ml/app/pipeline/lama.py) runs the same
published TorchScript checkpoint directly. One less dependency, and the mask
preprocessing (which LaMa is sensitive to) is explicit.

**Masks are written to disk, not held in memory.** A 15s 720p clip is ~450
frames; keeping every full-resolution mask resident costs hundreds of megabytes
for no benefit, since later stages read them one at a time. Intermediates are
deleted once the video is encoded.

---

## API

```http
POST   /api/jobs              multipart: video, referenceImage?, prompt
                              → 201 { job, queuePosition }   ← plan returned immediately
GET    /api/jobs              → paginated history
GET    /api/jobs/:id          → full job document
GET    /api/jobs/:id/stream   → SSE: snapshot | stage | status | done | error
GET    /api/jobs/:id/output   → MP4, supports HTTP Range (seeking)
GET    /api/jobs/:id/mask     → PNG mask overlay
DELETE /api/jobs/:id          → removes the job and its files
GET    /api/health            → dependency status; ?deep=1 also verifies the Gemini key
```

Every failure returns the same shape:

```json
{ "error": { "code": "target_not_found", "message": "Could not find \"Coca-Cola bottle\" in the video." } }
```

Errors are named so the client can branch on `code` while showing `message`:
`instruction_unclear`, `video_too_long`, `target_not_found`, `tracking_failed`,
`gemini_rate_limited`, `ml_unreachable`, and others.

### Example

```bash
curl -X POST http://localhost:4000/api/jobs \
  -F "video=@storage/uploads/sample-can.mp4" \
  -F "prompt=Replace the red soda can with a Pepsi can"
```

---

## Configuration

All three services read one `.env` at the repository root.

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | — | **Required.** |
| `GEMINI_TEXT_MODEL` | `gemini-3.5-flash` | Intent parsing + object grounding |
| `GEMINI_IMAGE_MODEL` | `gemini-2.5-flash-image` | Replacement asset generation (tier 1; needs a paid key) |
| `MONGODB_URI` | `mongodb://localhost:27017/lightedit` | |
| `PORT` | `4000` | Express |
| `ML_SERVICE_URL` | `http://localhost:8000` | FastAPI worker |
| `INTERNAL_SECRET` | generated | Authenticates the worker's progress webhook |
| `MAX_VIDEO_MB` | `100` | Rejected above this |
| `MAX_DURATION_SEC` | `15` | Rejected above this |
| `TARGET_HEIGHT` | `720` | Frames downscaled to this before processing |
| `FORCE_CPU` | `0` | Set `1` to skip CUDA |

`gemini-2.5-flash` also works if you hit quota limits, though brand-level
grounding is noticeably weaker on it.

---

## Project structure

```
client/src/
  pages/            Landing.tsx · Studio.tsx
  components/studio/  PipelineTimeline · PlanCard · CompareSlider · HistoryList
  hooks/            useJobStream.ts      SSE with polling fallback
  lib/              api.ts · types.ts · utils.ts

server/src/
  routes/           jobs.ts · internal.ts · health.ts
  services/         gemini.ts · dispatcher.ts · mlClient.ts
  models/Job.ts     job schema — status, plan, stages[], artifacts
  middleware/       upload.ts · errorHandler.ts

ml/app/
  main.py           FastAPI surface
  gemini_client.py  shared client + response helpers
  progress.py       stage timing + webhook emitter
  memory.py         CUDA thread binding + inter-stage cleanup
  pipeline/
    orchestrator.py  the six stages, in order
    grounding.py     Gemini spatial grounding
    segment.py       SAM 2, with OpenCV fallback
    lama.py          LaMa TorchScript runner
    pollinations.py  keyless fallback image generation
    inpaint.py       per-frame erasure
    assets.py        the replacement strategy ladder
    compose.py       tracked compositing + mask preview
    video.py         ffmpeg wrappers
```

---

## Known limitations

Stated plainly, because these are design boundaries rather than bugs:

- **No relighting or shadow synthesis.** The replacement's brightness is nudged
  toward its surroundings, but it casts no shadow and does not pick up coloured
  light from the scene.
- **Rigid, planar compositing.** The asset is a billboard on a tracked path. It
  does not rotate in 3D or deform.
- **One instance per prompt.** If three bottles are visible, the
  highest-confidence one is edited. `targetHint` disambiguates, but only among
  what grounding returned.
- **Heavy occlusion breaks tracking.** SAM 2 recovers from partial occlusion;
  an object that leaves the frame and returns will usually lose its mask.
- **15 seconds, 720p.** Not an algorithmic limit — a VRAM and patience limit.
  Both are configurable.
- **Text replacement is not implemented.** *"Replace Coca-Cola with Pepsi"* is
  handled as an object swap of the branded item, not OCR-level text editing.
- **Fast motion softens mask edges**, which shows as a faint halo where the
  original object was.
- **Audio is copied, never edited.**

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `ffmpeg is not installed or not on PATH` | Install it, then **open a new terminal** — PATH changes do not reach already-running shells. |
| `Could not reach MongoDB` | `winget install MongoDB.Server`, or `docker compose up -d`. Check with `npm run doctor`. |
| `Gemini rejected the API key` | `GEMINI_API_KEY` missing or wrong in `.env`. Verify with `curl "localhost:4000/api/health?deep=1"`. |
| `The video processing service is unreachable` | The Python worker isn't running. `npm run dev:ml`, and check port 8000. |
| `Could not find "X" in the video` | Grounding found nothing confidently. Describe the object by appearance, or use a clip where it's larger and unoccluded. |
| Result is a removal, not a replacement | The ladder fell all the way to `removal_only` — both the reference image and Pollinations were unavailable. Supply a reference image. |
| `mongod` dies mid-render, API exits with `ECONNREFUSED` | The host ran out of **commit** memory, not RAM. Windows with the page file disabled caps commit at physical RAM, and Mongo + Node + a CUDA process will not fit. Set the page file to system-managed (`sysdm.cpl` → Advanced → Performance → Advanced → Virtual memory) and reboot. Lowering `TARGET_HEIGHT` to `480` also helps. |
| `CUDA error: unknown error` right after "SAM 2 loaded" | A CUDA context established on one thread being used from another. Handled by `memory.bind_cuda_thread()`; if you add a new GPU stage, call it first. |
| CUDA out of memory | Lower `TARGET_HEIGHT` to `480`, or set `FORCE_CPU=1`. |
| Tracking quality is poor | Check `/api/jobs/:id/mask`. A `backend: opencv-csrt` in the stage detail means SAM 2 failed to load — see the worker log. |

Run `npm run doctor` first for anything environment-related; it checks every
dependency in one shot and names the fix.

---

## Scripts

| Command | |
|---|---|
| `npm run setup` | Guided first-time setup |
| `npm run dev` | Start all three services |
| `npm run doctor` | Verify every dependency |
| `npm run sample` | Render a test clip |
| `npm run build` | Production build of client + server |
