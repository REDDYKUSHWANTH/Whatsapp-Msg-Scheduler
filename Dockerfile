# Use an official Node.js runtime as a parent image
FROM node:18-slim

# ─── Install Chrome and its dependencies ───────────────────────────────────────
RUN apt-get update \
 && apt-get install -y wget gnupg2 ca-certificates --no-install-recommends \
 && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub \
      | apt-key add - \
 && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google.list \
 && apt-get update \
 && apt-get install -y google-chrome-stable --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer (whatsapp-web.js) where to find Chrome
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    NODE_ENV=production \
    PORT=3000

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm install --production

# Bundle app source
COPY . .

# Expose the port and start the app
EXPOSE 3000
CMD ["node", "sender.js"]
