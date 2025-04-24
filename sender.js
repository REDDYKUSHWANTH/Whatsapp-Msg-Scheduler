const express = require("express");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const fileUpload = require("express-fileupload");
const fs = require("fs");
const path = require("path");
const qrcode = require("qrcode");
const schedule = require("node-schedule");
const bodyParser = require("body-parser");

const app = express();
const port = 3000;

// Parse JSON and URL-encoded bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Enable file uploads
app.use(fileUpload());
// Serve static UI files
app.use(express.static("public"));

// WhatsApp Client Initialization (no persistent auth to force QR scan each time)
const client = new Client({
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

let currentQR = null;
let isReady = false;

// Generate QR Code for Web
client.on("qr", async (qr) => {
  currentQR = await qrcode.toString(qr, { type: "svg" });
  isReady = false;
});

// Ready state
client.on("ready", () => {
  console.log("WhatsApp is ready!");
  currentQR = null;
  isReady = true;
});

client.on("auth_failure", () => {
  console.log("Auth failure. Please scan QR again.");
  currentQR = null;
  isReady = false;
});

client.initialize();

// Route: Get QR Code SVG
app.get("/qr", (req, res) => {
  if (currentQR) {
    res.json({ svg: currentQR });
  } else if (isReady) {
    res.json({ svg: null, ready: true });
  } else {
    res.status(503).json({ error: "QR not ready" });
  }
});

// Route: Logout and regenerate QR
app.post("/logout", async (req, res) => {
  try {
    await client.logout();
    await client.initialize();
    res.json({ message: "Logged out and regenerating QR" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// In-memory store for recurring tasks
const tasks = [];

// Route: Send message
app.post("/send", async (req, res) => {
  const { phone, text, scheduleDate, scheduleTime, recurrence } = req.body;
  const number = phone.replace(/\D/g, "") + "@c.us";

  // Validate required fields
  if (!phone || !text) {
    return res.status(400).json({ error: "phone and text are required" });
  }
  // Parse time if provided
  let hour, minute;
  if (scheduleTime) {
    const parts = scheduleTime.split(":");
    hour = parseInt(parts[0], 10);
    minute = parseInt(parts[1], 10);
    if (isNaN(hour) || isNaN(minute)) {
      return res.status(400).json({ error: "Invalid scheduleTime format" });
    }
  }

  const sendMessage = async () => {
    try {
      if (req.files && req.files.media) {
        const media = req.files.media;
        const mediaPath = path.join(__dirname, "uploads", media.name);
        await media.mv(mediaPath);

        const mediaFile = MessageMedia.fromFilePath(mediaPath);
        await client.sendMessage(number, mediaFile, {
          caption: text,
          sendMediaAsViewOnce: false,
        });
        fs.unlinkSync(mediaPath);
      } else {
        await client.sendMessage(number, text);
      }
      res.json({
        status: scheduleDate && scheduleTime ? "scheduled" : "sent",
        id: Date.now(),
      });
    } catch (err) {
      res
        .status(500)
        .json({ error: "Failed to send message", details: err.message });
    }
  };

  // Handle recurring schedules
  if (recurrence === "daily") {
    if (!scheduleTime) {
      return res
        .status(400)
        .json({ error: "scheduleTime is required for daily recurrence" });
    }
    schedule.scheduleJob({ hour, minute }, sendMessage);
    tasks.push({
      id: `t${Date.now()}`,
      phone: number,
      text,
      recurrence: "daily",
      scheduleAt: scheduleTime,
    });
    return res.json({ status: "scheduled", recurrence: "daily" });
  }
  if (recurrence === "weekly") {
    if (!scheduleDate || !scheduleTime) {
      return res.status(400).json({
        error:
          "scheduleDate and scheduleTime are required for weekly recurrence",
      });
    }
    const dateObj = new Date(scheduleDate);
    const dayOfWeek = dateObj.getDay(); // 0=Sunday
    schedule.scheduleJob({ dayOfWeek, hour, minute }, sendMessage);
    const days = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];
    tasks.push({
      id: `t${Date.now()}`,
      phone: number,
      text,
      recurrence: "weekly",
      scheduleAt: `${days[dayOfWeek]} ${scheduleTime}`,
    });
    return res.json({ status: "scheduled", recurrence: "weekly" });
  }
  if (recurrence === "yearly") {
    if (!scheduleDate || !scheduleTime) {
      return res.status(400).json({
        error:
          "scheduleDate and scheduleTime are required for yearly recurrence",
      });
    }
    const dateObj = new Date(scheduleDate);
    const month = dateObj.getMonth();
    const day = dateObj.getDate();
    schedule.scheduleJob({ month, date: day, hour, minute }, sendMessage);
    tasks.push({
      id: `t${Date.now()}`,
      phone: number,
      text,
      recurrence: "yearly",
      scheduleAt: `${scheduleDate} ${scheduleTime}`,
    });
    return res.json({ status: "scheduled", recurrence: "yearly" });
  }
  // One-time schedule
  if (scheduleDate && scheduleTime) {
    const dateObj = new Date(`${scheduleDate}T${scheduleTime}`);
    if (isNaN(dateObj)) {
      return res.status(400).json({ error: "Invalid date or time format" });
    }
    schedule.scheduleJob(dateObj, sendMessage);
    tasks.push({
      id: `t${Date.now()}`,
      phone: number,
      text,
      recurrence: "once",
      scheduleAt: `${scheduleDate} ${scheduleTime}`,
    });
    return res.json({ status: "scheduled", scheduleDate, scheduleTime });
  }
  // Immediate send
  sendMessage();
});

// Route: List all tasks as JSON for UI
app.get("/api/tasks", (req, res) => {
  res.json(tasks);
});

// Route: Delete one or more tasks and return updated list
app.post("/api/tasks/delete", (req, res) => {
  const ids = req.body.ids;
  if (!Array.isArray(ids)) {
    return res.status(400).json({ error: "ids array is required" });
  }
  ids.forEach((id) => {
    const index = tasks.findIndex((t) => t.id === id);
    if (index > -1) tasks.splice(index, 1);
  });
  // return the updated tasks list
  res.json(tasks);
});

app.listen(port, () => {
  console.log(`✅ Server running at http://localhost:${port}`);
});
