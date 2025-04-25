# Use an official Node.js runtime as a parent image
FROM node:18-slim

# ─── Install Chromium (not google-chrome-stable) ───────────────────────
RUN apt-get update \
 && apt-get install -y chromium --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

# Tell whatsapp-web.js / Puppeteer where to find the browser
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    PORT=3000

# App setup
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --production
COPY . .

EXPOSE 3000
CMD ["node", "sender.js"]
