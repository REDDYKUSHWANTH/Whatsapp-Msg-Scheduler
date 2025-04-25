# Build stage
FROM node:18-alpine AS build

# Set up workdir and copy package files
WORKDIR /app
COPY package*.json ./

# Install dependencies for build
RUN npm ci --omit=dev

# Copy source files
COPY . .

# Final production stage
FROM node:18-alpine

# Install Chromium and minimal dependencies
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    # Use nano instead of full-size editors
    nano \
    # Add tzdata for timezone handling
    tzdata

# Set up browser environment with memory optimizations
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    NODE_ENV=production \
    PORT=3000 \
    # Browser flags for low resource usage
    PUPPETEER_ARGS="--disable-dev-shm-usage --disable-gpu --disable-software-rasterizer --disable-extensions --no-sandbox --disable-setuid-sandbox --no-zygote --single-process --disable-features=site-per-process"

# Create workdir and uploads directory
WORKDIR /app
RUN mkdir -p uploads

# Copy from build stage
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app .

# Add support for health checks
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

# Expose port
EXPOSE 3000

# Start the app with memory limit flag
CMD ["node", "--max-old-space-size=256", "sender.js"]
