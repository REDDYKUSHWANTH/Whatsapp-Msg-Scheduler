const express = require("express");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const fileUpload = require("express-fileupload");
const fs = require("fs");
const path = require("path");
const qrcode = require("qrcode");
const schedule = require("node-schedule");
const bodyParser = require("body-parser");
require("dotenv").config();
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const nodemailer = require("nodemailer");

const app = express();
const port = 3000;

// Parse JSON and URL-encoded bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Enable file uploads
app.use(fileUpload());
// Serve static UI files
app.use(express.static("public"));

// Add session management and passport initialization
app.use(
  session({
    secret: process.env.SESSION_SECRET || "secret",
    resave: false,
    saveUninitialized: false,
  })
);
app.use(passport.initialize());
app.use(passport.session());

// Configure passport for Google OAuth
passport.serializeUser((user, done) => {
  done(null, user);
});
passport.deserializeUser((obj, done) => {
  done(null, obj);
});
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL,
    },
    (accessToken, refreshToken, profile, done) => {
      // In a real app, you'd save/find the user in a database here
      return done(null, profile);
    }
  )
);

// Routes for Google authentication
app.get(
  "/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);
app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/signup" }),
  (req, res) => {
    res.redirect("/");
  }
);

// Serve signup page
app.get("/signup", async (req, res) => {
  // If any user exists, send them to login first
  const count = await User.countDocuments();
  if (count > 0) return res.redirect("/login");
  res.sendFile(path.join(__dirname, "public", "signup.html"));
});

// Handle local signup
app.post("/signup", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).send("Email and password required");
  // Check existing user
  if (await User.findOne({ email })) return res.redirect("/login");
  // Create new user
  const hashed = await bcrypt.hash(password, 10);
  await User.create({ email, password: hashed });
  res.redirect("/");
});

// GET login page
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// Handle local login
app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).send("Email and password required");
  const user = await User.findOne({ email });
  if (!user) return res.redirect("/signup");
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.redirect("/signup");
  req.session.user = { email };
  res.redirect("/");
});

// Handle user logout (session)
app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error("Session destroy error:", err);
    res.redirect("/signup");
  });
});

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

// Email transporter setup
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT, 10),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Helper to send notification emails
async function sendEmail(to, subject, text) {
  if (!to) return;
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to,
      subject,
      text,
    });
  } catch (err) {
    console.error("Error sending email:", err);
  }
}

// Ensure uploads directory exists for persistent storage
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// Task schema/model
const taskSchema = new mongoose.Schema({
  phone: String,
  name: { type: String, default: null },
  text: String,
  mediaPaths: { type: [String], default: [] },
  scheduleDate: String,
  scheduleTime: String,
  recurrence: {
    type: String,
    enum: ["once", "hourly", "daily", "weekly", "monthly", "yearly"],
    default: "once",
  },
  scheduleAt: String,
  createdAt: { type: Date, default: Date.now },
  userEmail: String,
  paused: { type: Boolean, default: false },
});
const Task = mongoose.model("Task", taskSchema);

// Schedule existing tasks at startup
(async () => {
  try {
    const existing = await Task.find({ paused: false });
    existing.forEach(scheduleTask);
    console.log(`⏰ Scheduled ${existing.length} existing jobs`);
  } catch (err) {
    console.error("Error scheduling existing tasks:", err);
  }
})();

// Automated pruning: remove media files not referenced by any task every midnight
schedule.scheduleJob({ hour: 0, minute: 0 }, async () => {
  try {
    const files = fs.readdirSync(uploadsDir);
    for (const file of files) {
      const filePath = path.join(uploadsDir, file);
      // If no active task references this file, delete it
      const taskExists = await Task.findOne({ mediaPaths: filePath });
      if (!taskExists) {
        fs.unlinkSync(filePath);
        console.log("🗑 Pruned orphaned media file:", filePath);
      }
    }
  } catch (err) {
    console.error("Error during media pruning:", err);
  }
});

// Receipt schema/model for delivery/read receipts
const receiptSchema = new mongoose.Schema({
  messageId: { type: String, unique: true },
  task: { type: mongoose.Schema.Types.ObjectId, ref: "Task" },
  ack: Number,
  timestamp: Date,
});
const Receipt = mongoose.model("Receipt", receiptSchema);

// Listen for delivery/read acknowledgments
client.on("message_ack", async (msg, ack) => {
  try {
    const messageId = msg.id._serialized;
    await Receipt.findOneAndUpdate(
      { messageId },
      { ack, timestamp: new Date() },
      { upsert: true }
    );
  } catch (err) {
    console.error("Error saving receipt:", err);
  }
});

// Modify sendScheduled to record initial receipt
async function sendScheduled(taskDoc, number) {
  try {
    if (taskDoc.mediaPaths && taskDoc.mediaPaths.length) {
      for (let i = 0; i < taskDoc.mediaPaths.length; i++) {
        const mediaFile = MessageMedia.fromFilePath(taskDoc.mediaPaths[i]);
        const opts = {};
        if (i === 0 && taskDoc.text) {
          opts.caption = taskDoc.text;
          opts.sendMediaAsViewOnce = false;
        }
        var msg = await client.sendMessage(number, mediaFile, opts);
        await Receipt.create({
          messageId: msg.id._serialized,
          task: taskDoc._id,
          ack: msg.ack,
          timestamp: new Date(),
        });
      }
    } else {
      var msg = await client.sendMessage(number, taskDoc.text);
      await Receipt.create({
        messageId: msg.id._serialized,
        task: taskDoc._id,
        ack: msg.ack,
        timestamp: new Date(),
      });
    }
    await sendEmail(
      taskDoc.userEmail,
      "WhatsApp Message Sent",
      `Your message to ${
        taskDoc.phone
      } was sent successfully at ${new Date().toLocaleString()}`
    );
  } catch (err) {
    console.error("Scheduled send failed:", err);
    await sendEmail(
      taskDoc.userEmail,
      "WhatsApp Message Failed",
      `Failed to send your message to ${
        taskDoc.phone
      } at ${new Date().toLocaleString()}. Error: ${err.message}`
    );
  }
}

// Serve My Tasks dashboard
app.get("/mytasks", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "mytasks.html"));
});

// Update an existing task (reschedule)
app.patch("/api/tasks/:id", async (req, res) => {
  const { scheduleDate, scheduleTime, recurrence } = req.body;
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ error: "Task not found" });
  // cancel existing job
  schedule.cancelJob(task._id.toString());
  // update fields
  if (scheduleDate) task.scheduleDate = scheduleDate;
  if (scheduleTime) task.scheduleTime = scheduleTime;
  if (recurrence) task.recurrence = recurrence;
  task.scheduleAt =
    recurrence === "once"
      ? `${task.scheduleDate} ${task.scheduleTime}`
      : task.scheduleTime;
  await task.save();
  scheduleTask(task);
  res.json(task);
});

// Pause a task
app.post("/api/tasks/:id/pause", async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ error: "Task not found" });
  schedule.cancelJob(task._id.toString());
  task.paused = true;
  await task.save();
  res.json(task);
});

// Resume a task
app.post("/api/tasks/:id/resume", async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ error: "Task not found" });
  task.paused = false;
  await task.save();
  scheduleTask(task);
  res.json(task);
});

// Utility to schedule jobs for a task document
function scheduleTask(t) {
  const number = t.phone.replace(/\D/g, "") + "@c.us";
  let job;
  const [hour, minute] = t.scheduleTime
    ? t.scheduleTime.split(":").map((n) => parseInt(n, 10))
    : [null, null];
  // hourly recurrence: run every hour at specified minute
  if (t.recurrence === "hourly" && minute != null) {
    job = schedule.scheduleJob({ minute }, async () =>
      sendScheduled(t, number)
    );
  } else if (t.recurrence === "daily" && hour != null) {
    job = schedule.scheduleJob({ hour, minute }, async () =>
      sendScheduled(t, number)
    );
  } else if (t.recurrence === "weekly" && t.scheduleDate && hour != null) {
    const dow = new Date(t.scheduleDate).getDay();
    job = schedule.scheduleJob({ dayOfWeek: dow, hour, minute }, async () =>
      sendScheduled(t, number)
    );
  }
  // monthly recurrence: run every month on the day-of-month at time
  else if (t.recurrence === "monthly" && t.scheduleDate && hour != null) {
    const day = new Date(t.scheduleDate).getDate();
    job = schedule.scheduleJob({ date: day, hour, minute }, async () =>
      sendScheduled(t, number)
    );
  } else if (t.recurrence === "yearly" && t.scheduleDate && hour != null) {
    const dt = new Date(t.scheduleDate);
    job = schedule.scheduleJob(
      { month: dt.getMonth(), date: dt.getDate(), hour, minute },
      async () => sendScheduled(t, number)
    );
  } else if (t.recurrence === "once" && t.scheduleDate && t.scheduleTime) {
    const dt = new Date(`${t.scheduleDate}T${t.scheduleTime}`);
    job = schedule.scheduleJob(dt, async () => {
      await sendScheduled(t, number);
      // remove task from database
      await Task.findByIdAndDelete(t._id);
      // cleanup uploaded files
      if (t.mediaPaths && t.mediaPaths.length) {
        t.mediaPaths.forEach((filePath) => {
          try {
            fs.unlinkSync(filePath);
          } catch (err) {
            console.error("Failed to delete media file:", filePath, err);
          }
        });
      }
    });
  }
}

// Route: Send message
app.post("/send", async (req, res) => {
  // Persist attachments to disk immediately
  let mediaPaths = [];
  if (req.files && req.files.media) {
    const files = Array.isArray(req.files.media)
      ? req.files.media
      : [req.files.media];
    for (const file of files) {
      const filename = `${Date.now()}_${file.name}`;
      const filePath = path.join(uploadsDir, filename);
      await file.mv(filePath);
      mediaPaths.push(filePath);
    }
  }
  // extract name as well
  const { phone, name, text, scheduleDate, scheduleTime, recurrence } =
    req.body;
  const number = phone.replace(/\D/g, "") + "@c.us";
  // store creator email if logged in
  const creatorEmail = req.session.user?.email;

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
        // support single or multiple attachments
        const medias = Array.isArray(req.files.media)
          ? req.files.media
          : [req.files.media];
        // send each media; include caption only on first
        for (let i = 0; i < medias.length; i++) {
          const m = medias[i];
          const mediaPath = path.join(__dirname, "uploads", m.name);
          await m.mv(mediaPath);
          const mediaFile = MessageMedia.fromFilePath(mediaPath);
          const opts = {};
          if (i === 0 && text) {
            opts.caption = text;
            opts.sendMediaAsViewOnce = false;
          }
          await client.sendMessage(number, mediaFile, opts);
          fs.unlinkSync(mediaPath);
        }
      } else {
        // no media, send text only
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

  // Handle scheduling and persistent storage
  if (recurrence === "daily") {
    // create and schedule task
    const t = await Task.create({
      phone: number,
      name,
      text,
      mediaPaths,
      scheduleDate,
      scheduleTime,
      recurrence,
      scheduleAt: scheduleTime,
      userEmail: creatorEmail,
    });
    scheduleTask(t);
    return res.json({ status: "scheduled", recurrence: "daily" });
  }
  if (recurrence === "weekly") {
    const days = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];
    const dow = new Date(scheduleDate).getDay();
    const desc = `${days[dow]} ${scheduleTime}`;
    const t = await Task.create({
      phone: number,
      name,
      text,
      mediaPaths,
      scheduleDate,
      scheduleTime,
      recurrence,
      scheduleAt: desc,
      userEmail: creatorEmail,
    });
    scheduleTask(t);
    return res.json({ status: "scheduled", recurrence: "weekly" });
  }
  if (recurrence === "yearly") {
    const desc = `${scheduleDate} ${scheduleTime}`;
    const t = await Task.create({
      phone: number,
      name,
      text,
      mediaPaths,
      scheduleDate,
      scheduleTime,
      recurrence,
      scheduleAt: desc,
      userEmail: creatorEmail,
    });
    scheduleTask(t);
    return res.json({ status: "scheduled", recurrence: "yearly" });
  }
  if (scheduleDate && scheduleTime) {
    const desc = `${scheduleDate} ${scheduleTime}`;
    const t = await Task.create({
      phone: number,
      name,
      text,
      mediaPaths,
      scheduleDate,
      scheduleTime,
      recurrence: "once",
      scheduleAt: desc,
      userEmail: creatorEmail,
    });
    scheduleTask(t);
    return res.json({ status: "scheduled", scheduleDate, scheduleTime });
  }
  // Immediate send
  sendMessage();
});

// Route: List all tasks as JSON for UI
app.get("/api/tasks", async (req, res) => {
  const all = await Task.find();
  res.json(all);
});

// Route: Delete one or more tasks and return updated list
app.post("/api/tasks/delete", async (req, res) => {
  const ids = req.body.ids;
  if (!Array.isArray(ids))
    return res.status(400).json({ error: "ids array is required" });
  await Task.deleteMany({ _id: { $in: ids } });
  const all = await Task.find();
  res.json(all);
});

// Serve the Receipts dashboard page
app.get("/receipts", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "receipts.html"));
});

// API endpoint to fetch all receipts with associated task info
app.get("/api/receipts", async (req, res) => {
  try {
    const receipts = await Receipt.find().populate("task").exec();
    res.json(receipts);
  } catch (err) {
    console.error("Failed to load receipts:", err);
    res.status(500).json({ error: "Failed to load receipts" });
  }
});

// MongoDB connection and User model
mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection error:", err));
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true },
  password: String,
});
const User = mongoose.model("User", userSchema);

app.listen(port, () => {
  console.log(`✅ Server running at http://localhost:${port}/signup.html`);
});
