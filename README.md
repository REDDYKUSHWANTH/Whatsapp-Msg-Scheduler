# WhatsApp Web Sender

A self-hosted Node.js + Express service that uses **whatsapp-web.js** under the hood to send scheduled text and image messages via WhatsApp Web.
The interactive web UI lets you:

- Scan a QR code to authenticate your WhatsApp account.
- Send immediate or scheduled (one-time) messages.
- Schedule recurring messages (**daily**, **weekly**, **yearly**).
- Manage scheduled tasks in-line (view & delete).

---

## Prerequisites

- Node.js v14+ & npm
- A WhatsApp account on your mobile
- Internet connection

## Installation

```bash
# Clone the repo
git clone <your-repo-url>
cd <repo-directory>

# Install dependencies
npm install
```

## Running the Service

```bash
# Start the server (runs at http://localhost:3000)
npm start
```

After startup you will see a QR code printed in the terminal and served on the UI.

## Web UI

1. Open your browser at:

   ```
   http://localhost:3000
   ```

2. **Authenticate** by scanning the QR code in your WhatsApp Mobile App under _Linked Devices_.
3. Once authenticated, use the form to:

   - Enter a phone number (with or without country code; the server defaults to +91 for India).
   - Type a text message or attach an image.
   - (Optional) Set **Schedule Date** and **Schedule Time**.
   - Choose a **Recurrence**: None, Daily, Weekly, or Yearly.
   - Click **Send**.

4. To view or delete scheduled tasks:
   - Click **View Scheduled Tasks**.
   - Select one or more entries and click **Delete Selected**.

## API Endpoints

All endpoints are under `http://localhost:3000`:

- `GET /qr` : Returns `{ svg, ready }` JSON with the latest QR (SVG) or `ready: true` once authenticated.
- `POST /send` : Accepts form data (`phone`, `text`, optional `media` file, `scheduleDate`, `scheduleTime`, `recurrence`) to send or schedule messages.
- `GET /api/tasks` : Returns a JSON array of all scheduled tasks.
- `POST /api/tasks/delete` : Accepts JSON `{ ids: ["t123", ...] }` to delete tasks by ID; returns updated task list.

## Notes

- The server uses in-memory storage for tasks; restarting the server clears scheduled tasks.
- For production use, consider using a persistent job store (database) and running Puppeteer in a stable environment.
- This setup is provided as a development/demo tool only.

---

© 2024 WhatsApp Web Sender Demo
