# syntax=docker/dockerfile:1.7
#
# ClipForge on Linux (VPS / Docker). One image for both roles:
#   web app + in-process workers   docker run -p 127.0.0.1:4173:4173 clipforge
#   extra stage workers            docker run clipforge worker --stages render   (needs REDIS_URL)
# docker-compose.yml wires Redis, the app and a render worker together.
#
# Build args:
#   WITH_REMOTION=1  animated Remotion cards: Chromium's system libraries (apt) + Remotion's headless
#                    Chrome. 0 = cards fall back to the drawtext PNGs (no apt needed at all).
#   WITH_CUDA=0      1 = keep the NVIDIA cuBLAS / cuDNN wheels for GPU Whisper (several GB). Pair it
#                    with an NVENC-capable FFMPEG_IMAGE and `docker run --gpus all` (NVIDIA Container
#                    Toolkit). Without a GPU the app uses libx264 and Whisper on CPU automatically.
#   WITH_MANIM=0     1 = Manim for the technical-diagram fallback (compiles pycairo / manimpango).
#   WITH_PIPER=1     Piper (free, local TTS): the `piper` program; mount a voice and set PIPER_MODEL.
#   FFMPEG_IMAGE     where the pinned static FFmpeg / FFprobe come from (libass, freetype, x264).
#
# Behind a TLS-inspecting proxy, hand its CA to the pip / npm steps (used only while building,
# never stored in the image):  docker build --secret id=ca_bundle,src=/path/to/ca.pem .

ARG NODE_IMAGE=node:22-bookworm-slim
ARG PYTHON_IMAGE=python:3.11-slim-bookworm
ARG FFMPEG_IMAGE=mwader/static-ffmpeg:7.1.1

FROM ${NODE_IMAGE} AS node
FROM ${FFMPEG_IMAGE} AS ffmpeg

# Python 3.11 is what python/requirements.txt is tested with; Node and FFmpeg are copied in.
FROM ${PYTHON_IMAGE} AS app
ARG WITH_REMOTION=1
ARG WITH_CUDA=0
ARG WITH_MANIM=0
ARG WITH_PIPER=1

ENV NODE_ENV=production \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    HOST=0.0.0.0 \
    WHISPER_DEVICE=auto \
    VIDEO_ENCODER=auto

# Node (official build) and a pinned static FFmpeg: no distro FFmpeg, so every host renders with
# the same version. The static build has no fontconfig: captions and cards use the bundled fonts.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && node --version && npm --version
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
RUN ffmpeg -hide_banner -version | head -n 1

# System libraries: Chromium's for the Remotion cards (list from Remotion's Linux requirements),
# a compiler + cairo/pango only when Manim is wanted.
RUN set -eux; \
    pkgs="ca-certificates"; \
    if [ "$WITH_REMOTION" = "1" ]; then pkgs="$pkgs libnss3 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 libasound2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libpango-1.0-0 libcairo2"; fi; \
    if [ "$WITH_MANIM" = "1" ]; then pkgs="$pkgs build-essential pkg-config libcairo2-dev libpango1.0-dev"; fi; \
    if [ "$pkgs" != "ca-certificates" ]; then \
      apt-get update; \
      apt-get install -y --no-install-recommends $pkgs; \
      rm -rf /var/lib/apt/lists/*; \
    fi

WORKDIR /app
RUN groupadd --system --gid 10001 app && useradd --system --uid 10001 --gid app --home-dir /app app

# Python workers in /app/.venv (src/lib/paths.ts looks for .venv/bin/python). The NVIDIA wheels
# and Manim are filtered out unless asked for.
COPY python/requirements.txt python/requirements.txt
RUN --mount=type=secret,id=ca_bundle,required=false \
    set -eux; \
    if [ -f /run/secrets/ca_bundle ]; then export PIP_CERT=/run/secrets/ca_bundle; fi; \
    python -m venv /app/.venv; \
    grep -v -E '^\s*#' python/requirements.txt \
      | { if [ "$WITH_CUDA" = "1" ]; then cat; else grep -v -E '^nvidia-'; fi; } \
      | { if [ "$WITH_MANIM" = "1" ]; then cat; else grep -v -E '^manim'; fi; } > /tmp/requirements.txt; \
    if [ "$WITH_PIPER" = "1" ]; then echo "piper-tts==1.2.0" >> /tmp/requirements.txt; fi; \
    /app/.venv/bin/pip install --upgrade pip; \
    /app/.venv/bin/pip install -r /tmp/requirements.txt; \
    rm /tmp/requirements.txt
ENV PATH="/app/.venv/bin:${PATH}"

# Node dependencies (tsx runs the TypeScript sources; devDependencies are needed at runtime).
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=ca_bundle,required=false \
    if [ -f /run/secrets/ca_bundle ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca_bundle; fi; \
    npm ci --include=dev --no-audit --no-fund && npm cache clean --force
COPY cards/package.json cards/package-lock.json cards/
RUN --mount=type=secret,id=ca_bundle,required=false \
    if [ -f /run/secrets/ca_bundle ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca_bundle; fi; \
    if [ "$WITH_REMOTION" = "1" ]; then \
      cd cards && npm ci --no-audit --no-fund && npx remotion browser ensure && npm cache clean --force; \
    fi

COPY . .
RUN mkdir -p workspace output cache models inputs \
 && chown -R app:app workspace output cache models inputs channels \
 && node node_modules/typescript/bin/tsc --noEmit

USER app
EXPOSE 4173
VOLUME ["/app/workspace", "/app/output", "/app/cache", "/app/models"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/api/queue').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || exit 1

# `docker run clipforge` = web app; `docker run clipforge worker --stages render` = a worker;
# any other CLI command works the same way (doctor, render --project x, ...).
ENTRYPOINT ["node", "node_modules/tsx/dist/cli.mjs", "src/cli.ts"]
CMD ["serve", "--port", "4173"]
