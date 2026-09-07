#!/usr/bin/env bash
#
# Installs the system-level prerequisites LightEdit needs, on macOS and Linux.
#
# The macOS/Linux counterpart of scripts/bootstrap.ps1. It is a shell script
# rather than a Node one because Node is itself one of the things it installs.
# Everything downstream of Node — npm packages, the Python virtualenv, PyTorch —
# belongs to `npm run setup`.
#
# Only missing tools are installed, so it is safe to re-run.
#
#     bash scripts/bootstrap.sh [--skip-mongo]

set -euo pipefail

SKIP_MONGO=0
[ "${1:-}" = "--skip-mongo" ] && SKIP_MONGO=1

step() { printf '\n\033[36m%s\033[0m\n' "$1"; }
ok()   { printf '    \033[32m[ok]\033[0m   %s\n' "$1"; }
miss() { printf '    \033[33m[..]\033[0m   %s\n' "$1"; }
bad()  { printf '    \033[31m[!!]\033[0m   %s\n' "$1"; }

has() { command -v "$1" >/dev/null 2>&1; }

printf '\n  LightEdit prerequisites\n  ───────────────────────\n'

if [ "$(uname -s)" = "Darwin" ]; then
  PM=brew
  if ! has brew; then
    bad "Homebrew is not installed."
    echo '         Install it from https://brew.sh, then re-run this script.'
    exit 1
  fi
elif has apt-get; then
  PM=apt
  SUDO=""
  [ "$(id -u)" -ne 0 ] && SUDO=sudo
  $SUDO apt-get update -qq
else
  bad "Unsupported package manager."
  echo '         Install Node 20+, Python 3.10+, ffmpeg and MongoDB by hand — see the README.'
  exit 1
fi

install_pkg() { # install_pkg <label> <brew formula> <apt package>
  miss "$1 — installing"
  if [ "$PM" = brew ]; then brew install "$2"; else $SUDO apt-get install -y "$3"; fi
  ok "$1"
}

# ── Node ─────────────────────────────────────────────────────────────
step "Node 20+"
if has node && [ "$(node --version | sed 's/^v//' | cut -d. -f1)" -ge 20 ]; then
  ok "node $(node --version)"
else
  install_pkg node node nodejs
fi

# ── Python ───────────────────────────────────────────────────────────
step "Python 3.10+"
if has python3 && python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'; then
  ok "$(python3 --version | tr '[:upper:]' '[:lower:]')"
else
  install_pkg python python@3.12 "python3 python3-venv"
fi

# ── ffmpeg ───────────────────────────────────────────────────────────
step "ffmpeg"
if has ffmpeg && has ffprobe; then ok "ffmpeg"; else install_pkg ffmpeg ffmpeg ffmpeg; fi

# ── MongoDB ──────────────────────────────────────────────────────────
step "MongoDB"
if [ "$SKIP_MONGO" -eq 1 ]; then
  ok "skipped (--skip-mongo) — point MONGODB_URI at your own instance"
# Anything listening on 27017 counts: a service, a container, or a tunnel.
elif (exec 3<>/dev/tcp/127.0.0.1/27017) 2>/dev/null; then
  ok "something is already serving 127.0.0.1:27017"
elif [ "$PM" = brew ]; then
  brew tap mongodb/brew
  brew install mongodb-community
  brew services start mongodb-community
  ok "mongodb (started as a brew service)"
else
  # Mongo is not in Debian/Ubuntu's own repositories, and adding MongoDB's
  # needs a distro-specific key and sources file. Docker is the shorter path.
  miss "not in apt — start it with: docker compose up -d"
fi

# ── GPU (informational) ──────────────────────────────────────────────
step "GPU"
if has nvidia-smi; then
  ok "$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | head -n1)"
else
  miss "no NVIDIA GPU detected — the pipeline will run on CPU (minutes per clip)"
fi

printf '\n\033[32m  Prerequisites are in place.\033[0m\n'
printf '  Open a new terminal, then:\n\n'
printf '      npm install\n      npm run setup\n'
printf '\n  You will also need a free Gemini API key: https://aistudio.google.com/apikey\n\n'
