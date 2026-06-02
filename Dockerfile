# Use official Node.js runtime as a base image
FROM node:20-slim

# Install system dependencies required for video/audio processing
# python-is-python3 fixes execution routing so Linux handles yt-dlp perfectly
RUN apt-get update && apt-get install -y \
    python3 \
    python-is-python3 \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install the latest Linux production release of yt-dlp directly to system binaries
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Establish workspace directory inside container
WORKDIR /usr/src/app

# Copy application configuration files
COPY package*.json ./

# Install production node dependencies
RUN npm ci --only=production

# Copy remaining source code files cleanly
COPY . .

# Explicitly copy cookies.txt if it exists (the * prevents build failure if missing locally)
COPY cookies.txt* ./

# Expose server port mapping
EXPOSE 3000

# Fire up application execution matching your entry point filename layout
CMD ["node", "node.js"]
