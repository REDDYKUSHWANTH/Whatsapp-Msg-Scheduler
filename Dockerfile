# Use an official Node.js runtime as a parent image
FROM node:18-slim

# Install Chromium and its dependencies
RUN apt-get update \
    && apt-get install -y chromium fonts-liberation libasound2 \
    libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
    libgbm1 libgtk-3-0 libnspr4 libnss3 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 xdg-utils --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Tell whatsapp-web.js / Puppeteer where to find the browser
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    PORT=3000

# Create app directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install app dependencies
RUN npm install --production

# Copy app source
COPY . .

# Create uploads directory for media files
RUN mkdir -p uploads

# Expose port
EXPOSE 3000

# Start the app
CMD ["node", "sender.js"]
