FROM node:20-bookworm-slim

# Cube ACR writes .amr; OpenAI needs MP3. ffmpeg (+ ffprobe) must be in PATH.
# This RUN must appear in Railway build logs. If it is absent, the service is
# still on Railpack / a cached image — not this Dockerfile.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# Fail the image build if ffmpeg is missing or broken. Do not rely on a
# later runtime check alone — a SUCCESS deploy without ffmpeg is useless.
RUN set -eux; \
  echo "=== verifying ffmpeg is on PATH ==="; \
  command -v ffmpeg; \
  command -v ffprobe; \
  test -x /usr/bin/ffmpeg; \
  test -x /usr/bin/ffprobe; \
  ffmpeg -version; \
  ffprobe -version; \
  echo "=== ffmpeg ok ==="

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production

# Same check the worker runs at boot (prints `ffmpeg: /usr/bin/ffmpeg`).
RUN node src/ffmpegBin.js

CMD ["npm", "start"]
