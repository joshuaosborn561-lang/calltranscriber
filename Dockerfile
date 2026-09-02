FROM node:20-bookworm-slim

# Cube ACR writes AMR; OpenAI needs MP3. ffmpeg (+ ffprobe) must be on PATH.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  && ffmpeg -version \
  && ffprobe -version

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
# Fail the image build if the worker cannot see ffmpeg.
RUN node src/ffmpegBin.js

CMD ["npm", "start"]
