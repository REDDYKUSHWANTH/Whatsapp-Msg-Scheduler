# Single-stage build for better Render compatibility
FROM node:16-alpine

# Install build dependencies and Chromium
RUN apk add --no-cache --virtual .build-deps \
    python3 \
    make \
    g++ \
    && apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    tzdata \
    wget \
    # Needed for puppeteer
    dumb-init

# Set up browser environment with memory optimizations
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    NODE_ENV=production \
    PORT=3000 \
    # Browser flags for low resource usage
    PUPPETEER_ARGS="--disable-dev-shm-usage --disable-gpu --disable-software-rasterizer --disable-extensions --no-sandbox --disable-setuid-sandbox --no-zygote --single-process --disable-features=site-per-process"

# Create workdir
WORKDIR /app

# Copy package.json and package-lock.json first for better caching
COPY package*.json ./

# Install dependencies
RUN npm install --production=false \
    && npm install puppeteer-extra puppeteer-extra-plugin-stealth \
    # Clean up build dependencies to reduce image size
    && apk del .build-deps

# Copy application files
COPY . .

# Create uploads directory with proper permissions
RUN mkdir -p uploads \
    && chmod -R 777 uploads \
    && chmod -R 777 /app

# Add support for health checks
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

# Expose port
EXPOSE 3000

# Use dumb-init to properly handle signals
ENTRYPOINT ["dumb-init", "--"]

# Start the app with memory limit flag
CMD ["node", "--max-old-space-size=256", "sender.js"]
