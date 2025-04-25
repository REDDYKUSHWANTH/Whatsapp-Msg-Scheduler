# Docker Setup for WhatsApp Message Scheduler

This document provides instructions for running the WhatsApp Message Scheduler application using Docker.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) installed on your system
- [Docker Compose](https://docs.docker.com/compose/install/) installed on your system
- Basic familiarity with Docker concepts

## Quick Start

1. Clone the repository and navigate to the project directory
2. Configure environment variables (see below)
3. Run the application:

```bash
docker-compose up -d
```

4. Access the application at http://localhost:3000
5. Scan the WhatsApp QR code when prompted

## Building and Running

### Option 1: Using Docker Compose (Recommended)

This will set up both the application and MongoDB:

```bash
# Start services in detached mode
docker-compose up -d

# View logs
docker-compose logs -f

# Stop all services
docker-compose down
```

### Option 2: Building and Running Only the Application Container

If you already have a MongoDB server:

```bash
# Build the container
docker build -t whatsapp-scheduler .

# Run the container
docker run -p 3000:3000 \
  -e MONGODB_URI=mongodb://your_mongo_host:27017/whatsapp-scheduler \
  -e SESSION_SECRET=your_secret \
  -v ./uploads:/usr/src/app/uploads \
  -v whatsapp-auth:/usr/src/app/.wwebjs_auth \
  whatsapp-scheduler
```

## Environment Variables

Configure these in the `docker-compose.yml` file or pass them directly to the container:

### Required Variables

- `MONGODB_URI`: MongoDB connection string (default: `mongodb://mongo:27017/whatsapp-scheduler`)
- `SESSION_SECRET`: Secret for session management

### Optional Variables

Email configuration (for notifications):
- `SMTP_HOST`: SMTP server host
- `SMTP_PORT`: SMTP server port
- `SMTP_SECURE`: Use TLS (true/false)
- `SMTP_USER`: SMTP username
- `SMTP_PASS`: SMTP password
- `EMAIL_FROM`: Sender email address

Google OAuth (for authentication):
- `GOOGLE_CLIENT_ID`: Google OAuth client ID
- `GOOGLE_CLIENT_SECRET`: Google OAuth client secret
- `GOOGLE_CALLBACK_URL`: OAuth callback URL (e.g., `http://localhost:3000/auth/google/callback`)

## Data Persistence

The application uses the following Docker volumes for persistence:

- `mongodb-data`: Stores the MongoDB database files
- `whatsapp-auth`: Stores WhatsApp session information
- `./uploads`: Maps to the container's uploads directory for media files

These ensure your data is preserved even when containers are restarted.

## Troubleshooting

### Common Issues

1. **WhatsApp QR Code Not Loading**
   
   Ensure Chromium is working properly in the container:
   ```bash
   docker-compose exec app chromium --version
   ```
   
   If needed, rebuild the image:
   ```bash
   docker-compose build --no-cache app
   ```

2. **MongoDB Connection Issues**
   
   Verify MongoDB is running:
   ```bash
   docker-compose ps mongo
   ```
   
   Check MongoDB logs:
   ```bash
   docker-compose logs mongo
   ```

3. **WhatsApp Authentication Problems**

   If you're having trouble with WhatsApp authentication, try clearing the auth data:
   ```bash
   docker-compose down
   docker volume rm whatsapp-scheduler_whatsapp-auth
   docker-compose up -d
   ```

4. **Container Startup Issues**

   Check container logs for errors:
   ```bash
   docker-compose logs app
   ```

5. **Permission Issues with Volumes**

   If you encounter permission issues with mounted volumes:
   ```bash
   # Fix permissions for uploads directory
   sudo chown -R 1000:1000 ./uploads
   ```

## Security Considerations

1. By default, the MongoDB instance doesn't have authentication enabled. For production:
   - Uncomment and set `MONGO_INITDB_ROOT_USERNAME` and `MONGO_INITDB_ROOT_PASSWORD` in docker-compose.yml
   - Update the MongoDB URI to include credentials

2. The application container exposes port 3000. Consider using a reverse proxy like Nginx for TLS termination in production.

3. Store sensitive environment variables in a `.env` file (not tracked by git) and load them:
   ```bash
   docker-compose --env-file .env up -d
   ```

## Backup and Restore

To backup your MongoDB data:
```bash
docker-compose exec mongo mongodump --out /data/db/backup
```

To restore from backup:
```bash
docker-compose exec mongo mongorestore /data/db/backup
```

