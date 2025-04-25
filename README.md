# WhatsApp Msg Scheduler

A self-hosted Node.js + Express service that uses **whatsapp-web.js** under the hood to send scheduled text and image messages via WhatsApp Web.
The interactive web UI lets you:

- Scan a QR code to authenticate your WhatsApp account.
- Send immediate or scheduled (one-time) messages.
- Schedule recurring messages (**daily**, **weekly**, **yearly**).
- Manage scheduled tasks in-line (view & delete).

---

## Features

- Sign-up & Login (local & Google OAuth2).
- MongoDB persistence for users, tasks, and delivery/read receipts.
- Multi-format attachments: images, videos, audio, PDFs, other files, with live preview.
- Schedule one-time or recurring (daily, weekly, yearly) WhatsApp messages.
- "Send" button clears media preview immediately.
- "My Tasks" dashboard (`/mytasks`) to list, pause, resume, edit, or delete scheduled jobs.
- "Message Receipts" dashboard (`/receipts`) for real-time delivery/read ACKs.
- Email notifications on scheduled message success or failure.

## Prerequisites

- Node.js v14+ & npm
- A WhatsApp account on your mobile
- Internet connection

## Environment Variables

Create a `.env` file in the project root with the following variables:

```bash
MONGODB_URI=mongodb://localhost:27017/whatsapp_scheduler
SESSION_SECRET=your-session-secret

# (Optional) Google OAuth
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback

# SMTP Email for notifications
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false        # true for 465, false for other ports
SMTP_USER=your-smtp-user
SMTP_PASS=your-smtp-password
EMAIL_FROM=you@example.com
```

## Installation

```bash
# Clone the repo
git clone <your-repo-url>
cd <repo-directory>

# Install dependencies
npm install
```

Ensure MongoDB is running locally (or update `MONGODB_URI` to your cluster).

## Running the Service

```bash
# Start the server (http://localhost:3000)
npm start
```

You should see:

```
✅ Connected to MongoDB
✅ Server running at http://localhost:3000/signup.html
```

## Web UI

1. Visit `http://localhost:3000`.
2. **Sign up** (first-time) or **Login** (subsequent visits).
3. Use the form to:
   - Enter phone + message + (optional) multiple attachments.
   - Preview attachments live before sending.
   - Set schedule and recurrence.
   - Click **Send** (clears preview immediately).
4. **My Tasks** dashboard (`/mytasks`): manage your scheduled jobs.
5. **Message Receipts** dashboard (`/receipts`): view delivery/read statuses.

## API Endpoints

- `GET /qr` - QR code status.
- `POST /send` - Send/schedule messages (supports multiple files).
- `GET /mytasks` - Tasks dashboard.
- `POST /api/tasks/delete` - Delete tasks.
- `PATCH /api/tasks/:id` - Edit/reschedule a task.
- `POST /api/tasks/:id/pause` & `/resume` - Pause or resume.
- `GET /api/tasks` - JSON list of tasks.
- `GET /receipts` - Receipts dashboard.
- `GET /api/receipts` - JSON list of receipts.
- `GET /logout` - Clear session and logout.

## Notes

- Requires Node.js v14+.
- Use a real SMTP server or service (e.g., SendGrid, Mailgun) for email notifications.
- For production, secure cookies, HTTPS, and environment variables appropriately.

---

© 2024 WhatsApp Web Sender Demo
