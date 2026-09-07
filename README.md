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
