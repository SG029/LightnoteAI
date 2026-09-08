# LightEdit

**Edit objects in a video by describing the change in plain English.**

Upload a clip, type *"Replace the Coca-Cola bottle with Pepsi"*, and get the
video back with the object swapped — tracked frame by frame. Removal
(*"Remove the bottle"*) works through the same pipeline.

---

## 1 · Clone the repository

```bash
git clone https://github.com/SG029/LightnoteAI.git
cd LightnoteAI
```

## 2 · Install the prerequisites

One command installs everything the project needs from the system: **Node 20+**,
**Python 3.10+**, **ffmpeg** and **MongoDB**.

**Windows** (uses winget — expect UAC prompts):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\bootstrap.ps1
```

**macOS / Linux** (uses Homebrew or apt):

```bash
bash scripts/bootstrap.sh
```

Already have Node? `npm run bootstrap` does the same thing. Only missing tools
are installed, so it is safe to re-run. Add `--skip-mongo` / `-SkipMongo` if you
are using Atlas or `docker compose up -d` instead.

> When it finishes, **open a new terminal**. PATH changes do not reach shells
> that are already running.

Two things the script cannot do for you:

| | |
|---|---|
| **Gemini API key** | Get a free one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — needed in step 4. |
| NVIDIA GPU, 6GB+ | *Optional.* Without one the pipeline runs on CPU, several minutes per clip. |

<details>
<summary>Prefer to install them by hand?</summary>

| Requirement | Windows | macOS |
|---|---|---|
| Node 20+ | `winget install OpenJS.NodeJS.LTS` | `brew install node` |
| Python 3.10+ | `winget install Python.Python.3.12` | `brew install python@3.12` |
| ffmpeg + ffprobe | `winget install Gyan.FFmpeg` | `brew install ffmpeg` |
| MongoDB | `winget install MongoDB.Server` | `brew tap mongodb/brew && brew install mongodb-community` |

`docker compose up -d` works in place of a local MongoDB install.

</details>

## 3 · Run the setup

```bash
npm install          # root only — just the dev launcher
npm run setup
```

This creates `.env`, installs the server and client dependencies, builds the
Python virtualenv, installs PyTorch with CUDA (~2.5GB — the slow part) and the
rest of `ml/requirements.txt`, and checks that MongoDB is reachable. It is safe
to re-run: anything already done is skipped.

## 4 · Add your API key

Open `.env` and fill in the one required value:

```env
GEMINI_API_KEY=your_key_here
```

Everything else in `.env` has a working default. The ones worth knowing:

| Variable | Default | |
|---|---|---|
| `FORCE_CPU` | `0` | set `1` to skip CUDA |
| `TARGET_HEIGHT` | `720` | lower to `480` if you run out of VRAM |
| `MAX_DURATION_SEC` | `15` | clips longer than this are rejected |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/lightedit` | |

## 5 · Start it

```bash
npm run doctor       # ✓ node ✓ python ✓ ffmpeg ✓ gpu ✓ mongodb ✓ .env
npm run dev          # starts all three services
```

| Service | URL |
|---|---|
| Web app | http://localhost:5173 |
| API | http://localhost:4000 |
| ML worker | http://localhost:8000 |

Open http://localhost:5173 and check that the **api** and **gpu worker** pills
in the top-right are green before submitting a job.

## 6 · Make an edit

1. **Source video** — drop in a clip (MP4/MOV/WebM, max 15s).
2. **Reference image** — *optional*, a photo of the product to insert. Recommended:
   image generation is unavailable on a free Gemini key, so without a reference
   the replacement is generated from text instead.
3. **Instruction** — describe the object by appearance: *"Replace the red soda
   can with a Pepsi can"*.

No footage handy?

```bash
npm run sample       # renders storage/uploads/sample-can.mp4
```

> **The first job downloads model weights** — SAM 2 (~180MB) and LaMa (~200MB),
> cached afterwards. Expect roughly 3 minutes for a 4s 720p clip on a laptop
> GPU, longer for larger sources.

---

## Scripts

| Command | |
|---|---|
| `npm run bootstrap` | Install the system prerequisites |
| `npm run setup` | Guided first-time setup |
| `npm run dev` | Start all three services |
| `npm run doctor` | Verify every dependency |
| `npm run sample` | Render a test clip |
| `npm run build` | Production build of client + server |
| `npm run mongo:up` / `mongo:down` | Start/stop MongoDB in Docker |

## Troubleshooting

Run `npm run doctor` first — it checks every dependency in one shot and names
the fix.

| Symptom | Cause and fix |
|---|---|
| `ffmpeg is not installed or not on PATH` | Install it, then **open a new terminal**. |
| `Could not reach MongoDB` | `winget install MongoDB.Server`, or `docker compose up -d`. |
| `Gemini rejected the API key` | `GEMINI_API_KEY` missing or wrong in `.env`. Check with `curl "localhost:4000/api/health?deep=1"`. |
| `429 ... quota exceeded` | Free-tier Gemini allows 20 requests/minute. Wait a minute and retry. |
| `The video processing service is unreachable` | The Python worker isn't running — `npm run dev:ml`, and check port 8000. |
| `Could not find "X" in the video` | Describe the object by appearance, or use a clip where it is larger and unoccluded. |
| CUDA out of memory | Lower `TARGET_HEIGHT` to `480`, or set `FORCE_CPU=1`. |
| `mongod` dies mid-render, API exits with `ECONNREFUSED` | The host ran out of **commit** memory. Set the page file to system-managed (`sysdm.cpl` → Advanced → Performance → Advanced → Virtual memory) and reboot. |

---

## Architecture

Three processes, each doing the thing it is best at, talking over HTTP.

```
                 ┌─────────────────────────────────────────┐
   browser  ───▶ │  client — React 18 + Vite + Tailwind 4  │
                 │  upload · plan review · live timeline    │
                 └────────────┬──────────────▲─────────────┘
                    multipart │              │ SSE (progress)
                              ▼              │
                 ┌─────────────────────────────────────────┐
                 │  server — Express 5 + TypeScript        │
                 │  intent (Gemini) · validation · queue   │◀──┐
                 │  job state · artifact serving           │   │ webhook
                 └────────────┬──────────────▲─────────────┘   │ /internal
                     MongoDB  │              │ POST /process   │
                              ▼              ▼                 │
                 ┌──────────────────┐  ┌─────────────────────┐ │
                 │  MongoDB         │  │  ml — FastAPI       │─┘
                 │  jobs, stages    │  │  SAM 2 · LaMa       │
                 └──────────────────┘  │  Gemini · ffmpeg    │
                                       └──────────┬──────────┘
                                                  │
                                        storage/  ▼  uploads · frames · outputs
```

### The six stages

A job is always the same sequence, and the UI names each one as it runs:

| # | Stage | Where | What happens |
|---|---|---|---|
| 1 | **intent** | Express | Gemini turns the sentence into a structured `EditPlan` — `operation`, `target`, `replacement`, `targetHint`, `confidence`. |
| 2 | **ground** | Python | ffmpeg probes and extracts frames; Gemini locates `target` in a keyframe and returns a box **and a polygon**. |
| 3 | **track** | Python | SAM 2 propagates that prompt forward and backward into a per-frame mask. |
| 4 | **clean** | Python | LaMa inpaints the masked region out of every frame — the *clean plate*. |
| 5 | **compose** | Python | A replacement cut-out is built and composited along the tracked path. Skipped for `remove`. |
| 6 | **encode** | Python | ffmpeg muxes the frames back to H.264, carrying the original audio. |

Grounding is attempted on up to four frames spread across the clip (weighted
toward the start) rather than only on frame 0, because the target is often
occluded or off-screen when the video opens.

### Request lifecycle

`POST /api/jobs` (multipart: video, optional reference image, prompt) →
Express probes the file with ffprobe, calls Gemini for the plan, persists a
`Job`, and returns immediately with a **queue position**. The browser opens
`GET /api/jobs/:id/stream` (SSE) and watches. The dispatcher pops the job and
`POST`s to the worker's `/process`, holding that connection for the whole
render — while the worker pushes stage-by-stage progress *out of band* to
`POST /internal/jobs/:id/progress`, which republishes onto an in-process event
bus and out to every open SSE connection. The `/process` response is only the
terminal outcome.

The rest of the API surface: `GET /api/jobs` (history), `GET /api/jobs/:id`,
`GET /api/jobs/:id/output` (the MP4), `GET /api/jobs/:id/mask` (the mask
preview), `DELETE /api/jobs/:id`, and `GET /api/health` — with `?deep=1`
fanning out to Mongo, Gemini and the worker so one call tells you which
dependency is broken.

### Storage

Artifacts are files on disk under `storage/`; MongoDB holds only job state and
paths. Intermediates (`storage/frames/<jobId>/{raw,masks,plates,comp,asset}`)
are deleted the moment the video is encoded — a 15s clip is ~450 frames at each
of four stages, well over a gigabyte per job. Only `storage/outputs/` survives:
the MP4, the mask preview, and the replacement asset.

---

## AI and models

| Role | Model | Where it runs | Why this one |
|---|---|---|---|
| Instruction → edit plan | **Gemini Flash** (`gemini-3.5-flash`) | Google API, from Express | Constrained JSON-schema output, so the plan is a validated object rather than parsed prose. Fast enough to sit in the request path. |
| Object grounding | **Gemini Flash** (vision) | Google API, from Python | Returns a box *and* a silhouette polygon, plus a confidence and label. |
| Segmentation + tracking | **SAM 2.1 Hiera-Small** (`facebook/sam2.1-hiera-small`, via `transformers`) | Local, CUDA or CPU | Video model with streaming memory — the mask stays attached through motion, rotation and partial occlusion. |
| Tracking fallback | **OpenCV CSRT** | Local, CPU | No weights, no GPU. Worse under deformation, but keeps the product working where SAM 2 cannot load. |
| Inpainting | **LaMa** (`big-lama.pt`, TorchScript) | Local, CUDA or CPU | Feed-forward and deterministic. |
| Inpainting fallback | **OpenCV Telea** | Local, CPU | Weightless last resort for small masks. |
| Replacement generation | **Gemini image model** (`gemini-3.1-flash-image`) | Google API | Conditioned on a crop of the actual scene, so lighting and camera angle match. Reports a quota of zero on a free key. |
| Replacement fallback | **FLUX via Pollinations** | Keyless HTTP GET | Closes the gap left by the free-tier image quota. No key, no SDK, no availability guarantee. |
| Background removal | **rembg** (U²-Net, ONNX Runtime) | Local, CPU | Turns any generated or supplied image into a tight RGBA cut-out. |

Weights download on first use into `ml/weights/` and are cached afterwards —
SAM 2 ~180MB, LaMa ~200MB. SAM 2 stays resident across jobs; its ~10s load
should not be paid per render.

### The replacement ladder

`compose` walks four tiers and stops at the first that produces a cut-out:

1. **`gemini_keyframe`** — Gemini renders the object conditioned on the scene
   crop *and* the user's reference image. Best result; needs paid image quota.
2. **`reference_composite`** — the reference image is cut out and used as-is.
   No harmonisation, but the user told us exactly what they wanted, so this
   outranks generating an approximation.
3. **`generated_composite`** — Pollinations renders it from text alone. No
   scene context, so no lighting match.
4. **none** — no asset. The job returns as `removal_only`: the object is still
   gone, which is a partial success worth shipping rather than a hard failure.

Every tier ends at the same artifact — a tight RGBA cut-out — so the
compositor never learns which one it came from.

---

## Why this approach

**Generate the object once, then track it — never per frame.**
This is the central decision. A per-frame generative edit has no memory of the
previous frame, so identity drifts and the result strobes. Rendering one fixed
asset and moving it along a tracked path is temporally stable *by
construction*. The honest cost is stated in Limitations: the asset is a 2D
billboard, so it does not re-light or turn with the scene.

**Erase first, composite second.** Splitting the edit into `clean` (LaMa
removes the object) and `compose` (the asset goes back on) means removal is
just the pipeline stopping early, and a failed replacement degrades gracefully
into a successful removal instead of an error page.

**Gemini for grounding, not an open-vocabulary detector.** OWLv2 and
GroundingDINO are CLIP-derived: strong on generic categories ("bottle"),
markedly weaker on the brand-level targets this product is actually asked for
("the Coca-Cola bottle"). Gemini carries that world knowledge, and the polygon
it returns is a far better SAM 2 prompt than a rectangle alone.

**LaMa, not a diffusion inpainter.** One feed-forward pass — tens of
milliseconds a frame instead of tens of seconds — and deterministic, so
consecutive frames reconstruct the same background the same way. Diffusion
samples independently per frame and the background visibly boils.

**Every model has a fallback.** SAM 2 → CSRT, LaMa → Telea, Gemini image →
Pollinations → removal-only. A missing GPU, a free API key, or a third-party
outage degrades quality rather than breaking the product.

**A blocking `/process` with an out-of-band progress webhook.** The render is
one long synchronous call, which keeps the worker simple and stateless; live
progress travels separately, so the UI is never waiting on that connection.
(Node's global `fetch` caps the header wait at five minutes with no way to
raise it, so the client is `node:http` — every job over five minutes was
otherwise aborted mid-render and surfaced as a bare "fetch failed".)

**Concurrency fixed at 1.** There is one GPU. Two concurrent renders on 6GB of
VRAM produce CUDA OOM, not throughput. The queue exists so the API can accept
work instantly and hand back a position instead of blocking for the length of
a render.

**Masks and frames on disk, not in memory.** Later stages read them one at a
time; holding ~450 full-resolution masks resident costs hundreds of megabytes
for nothing.

**One `.env` at the repo root** feeds Express and the Python worker alike, so
`TARGET_HEIGHT` or `FORCE_CPU` cannot drift between the two.

---

## Known limitations

**The replacement is a 2D billboard.** It is scaled and positioned along the
tracked path, with the box smoothed over a 5-frame window and the alpha
feathered — but it does not rotate, re-pose, or re-light with the scene. A
handheld bottle on a table reads fine; an object that turns to show another
face does not.

**Image generation needs a paid key.** On a free Gemini key the image models
report a quota of zero, so tier 1 of the ladder is unavailable and results come
from the reference image or from Pollinations without scene harmonisation.
**Supplying a reference image is strongly recommended.**

**Grounding is single-instance.** The first, highest-confidence detection is
tracked. "Replace *the* bottle" in a frame with five bottles edits one of them;
`targetHint` disambiguates by position, but there is no multi-object or "all of
them" mode.

**15 seconds, 100MB, 720p.** Longer clips are rejected outright
(`MAX_DURATION_SEC`); frames are downscaled to `TARGET_HEIGHT` before
processing and the output is encoded at that height, so a 4K source comes back
at 720p. Audio is passed through untouched.

**Full occlusion breaks the track.** SAM 2 handles partial occlusion well, but
an object that leaves frame and returns generally comes back as an empty mask.
Coverage below 10% retries on CSRT; below 5% the job fails with a message
saying so.

**CPU mode is slow.** Roughly 3 minutes for a 4s 720p clip on a laptop GPU —
several times that on CPU, dominated by SAM 2 and LaMa.

**Single-node by design.** The queue is in-process and the SSE fan-out is an
in-process `EventEmitter`. Correct for one Express instance owning one GPU
worker; a second API replica would need BullMQ (or similar) and Redis pub/sub.
Both are deliberately isolated to one file each — `server/src/services/dispatcher.ts`
and `server/src/lib/eventBus.ts` — so the swap touches nothing else.

**No authentication or multi-tenancy.** Every job is visible to every visitor,
`/internal` is protected only by a shared secret, and uploads are trusted after
MIME and extension checks. This is a local-first demo, not a public-facing
deployment.

**No undo, no partial edits.** A job produces one output video. There is no
timeline scrubbing, no editing a range of frames, and no re-running a single
stage with different parameters — a changed instruction is a new job.

**Third-party dependence.** Pollinations is unauthenticated with no
availability guarantee; when it is down, replacement jobs without a reference
image fall through to removal-only. Free-tier Gemini allows 20 requests per
minute, and a job can spend several of them on grounding retries.
