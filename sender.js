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

// Puppeteer-extra for improved browser automation
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const app = express();
const port = process.env.PORT || 3000;

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

// WhatsApp Client Initialization with puppeteer-extra and stealth plugin
// Detection and logging helpers
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const logDebug = (...args) => console.log(`[DEBUG]`, ...args);
const logError = (...args) => console.error(`[ERROR]`, ...args);
const logInfo = (...args) => console.log(`[INFO]`, ...args);

// Find Chrome executable path based on platform
async function findChromeExecutablePath() {
  logInfo(`Detecting Chrome on ${process.platform}...`);
  
  // Use provided path from environment variable if available
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    logInfo(`Using Chrome from environment variable: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  
  // Default paths by platform
  if (isWin) {
    const possiblePaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
      process.env.ProgramFiles + '\\Google\\Chrome\\Application\\chrome.exe',
      process.env['ProgramFiles(x86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
    ].filter(Boolean); // Remove any undefined paths
    
    logDebug('Searching for Chrome in Windows paths:', possiblePaths);
    
    for (const chromePath of possiblePaths) {
      try {
        if (fs.existsSync(chromePath)) {
          logInfo(`Found Chrome at: ${chromePath}`);
          return chromePath;
        }
      } catch (err) {
        // Skip this path
      }
    }
  } else if (isMac) {
    const macPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(macPath)) return macPath;
  } else if (isLinux) {
    const linuxPaths = [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ];
    
    for (const chromePath of linuxPaths) {
      try {
        if (fs.existsSync(chromePath)) return chromePath;
      } catch (err) {
        // Skip this path
      }
    }
  }
  
  logInfo('No Chrome installation found, will use puppeteer bundled browser');
  return null;
}

// Configure browser arguments for better compatibility
const browserArgs = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-accelerated-2d-canvas",
  "--no-first-run",
  "--disable-extensions",
  "--ignore-certificate-errors",
  "--ignore-certificate-errors-spki-list",
  "--disable-features=IsolateOrigins,site-per-process",
  "--user-data-dir=" + path.join(__dirname, '.browser-data')
];

// OS-specific optimizations
if (isWin) {
  browserArgs.push("--disable-features=TranslateUI");
  browserArgs.push("--disable-background-networking");
} else if (isLinux) {
  browserArgs.push("--no-zygote");
  browserArgs.push("--single-process");
}

// Initialize state variables
let currentQR = null;
let isReady = false;
let initRetries = 0;
const MAX_RETRIES = 3;

// Create custom puppeteer browser instance for WAWebJS
async function createCustomPuppeteerBrowser() {
  try {
    const executablePath = await findChromeExecutablePath();
    
    const browser = await puppeteer.launch({
      headless: true,
      args: browserArgs,
      executablePath,
      ignoreHTTPSErrors: true,
      defaultViewport: { width: 1280, height: 800 },
      timeout: 120000,
    });
    
    return browser;
  } catch (error) {
    logError('Error creating custom browser:', error);
    throw error;
  }
}

// Initialize the WhatsApp Web client
async function setupWhatsAppClient() {
  try {
    // Create the WhatsApp client with custom puppeteer implementation
    const client = new Client({
      authStrategy: new LocalAuth({ 
        dataPath: path.join(__dirname, '.wwebjs_auth'),
        clientId: 'whatsapp-scheduler'
      }),
      puppeteer: {
        // Use our custom browser instance
        browser: await createCustomPuppeteerBrowser(),
      },
      webVersionCache: { type: 'local' },
      restartOnAuthFail: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });

    // Set up event handlers
    client.on("qr", async (qr) => {
      try {
        currentQR = await qrcode.toString(qr, { type: "svg" });
        logInfo("QR Code generated - scan to connect WhatsApp");
        isReady = false;
      } catch (err) {
        logError("Error generating QR code:", err);
      }
    });

    client.on("ready", () => {
      logInfo("WhatsApp is ready and connected!");
      currentQR = null;
      isReady = true;
      initRetries = 0;
    });

    client.on("auth_failure", (msg) => {
      logError("WhatsApp authentication failed:", msg);
      currentQR = null;
      isReady = false;
    });

    client.on("disconnected", (reason) => {
      logInfo("WhatsApp disconnected. Reason:", reason);
      isReady = false;
      
      if (initRetries < MAX_RETRIES) {
        const delay = 5000 + (initRetries * 2000); // Increasing backoff
        logInfo(`Will attempt reconnection in ${delay/1000} seconds (${initRetries+1}/${MAX_RETRIES})...`);
        
        setTimeout(() => {
          initClient(client);
        }, delay);
      } else {
        logError("Maximum reconnection attempts reached. Please restart the server.");
      }
    });

    // Add error logging
    client.on("message_create", (msg) => {
      logDebug("New message created:", msg.body.substring(0, 20) + "...");
    });
    
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
        logError("Error saving receipt:", err);
      }
    });

    return client;
  } catch (error) {
    logError("Fatal error setting up WhatsApp client:", error);
    throw error;
  }
}

// Create a global client variable
let client;

// Initialize client with retry mechanism
async function initClient(existingClient = null) {
  try {
    // Use existing client if provided, otherwise create a new one
    client = existingClient || await setupWhatsAppClient().catch(err => {
      logError("Failed to setup WhatsApp client:", err);
      return null;
    });
    
    if (!client) {
      logError("Could not create WhatsApp client. Check Chrome installation.");
      return;
    }

    initRetries++;
    logInfo(`Initializing WhatsApp client (attempt ${initRetries}/${MAX_RETRIES})...`);
    
    await client.initialize().catch(err => {
      logError("Failed to initialize WhatsApp client:", err);
      
      if (initRetries < MAX_RETRIES) {
        const delay = 10000 * initRetries; // Increasing backoff
        logInfo(`Retrying in ${delay/1000} seconds... (${initRetries}/${MAX_RETRIES})`);
        
        setTimeout(() => {
          initClient(client);
        }, delay);
      } else {
        logError("Maximum initialization retries reached. WhatsApp features will not be available.");
      }
    });
  } catch (err) {
    logError("Unexpected error during client initialization:", err);
    
    if (initRetries < MAX_RETRIES) {
      const delay = 10000 * initRetries;
      logInfo(`Retrying after error in ${delay/1000} seconds... (${initRetries}/${MAX_RETRIES})`);
      
      setTimeout(() => {
        initClient(null);
      }, delay);
    }
  }
}

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

// User schema/model for authentication
const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please use a valid email address']
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [6, 'Password must be at least 6 characters']
  },
  name: {
    type: String,
    trim: true
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastLogin: Date
}, {
  timestamps: true
});

// Create the User model
const User = mongoose.model("User", userSchema);

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

// Message receipt handling is now inside setupWhatsAppClient function

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
  if (!isReady) {
    return res
      .status(503)
      .json({ error: "WhatsApp client not ready – scan the QR code first" });
  }
  // ── DEBUG: log the incoming payload and readiness
  console.log("▶ /send called:", {
    body: req.body,
    files: req.files,
    isReady,
  });

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
    const receipts = await Receipt.find().populate('task');
    res.json(receipts);
  } catch (err) {
    logError("Error fetching receipts:", err);
    res.status(500).json({ error: "Failed to fetch receipts", details: err.message });
  }
});

// Start the WhatsApp client initialization process
(async function startClient() {
  try {
    // Start client initialization
    await initClient();
  } catch (err) {
    logError("Failed to start WhatsApp client:", err);
    // Continue with server initialization even if WhatsApp client fails
  }
})();

// Connect to MongoDB
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("✅ Connected to MongoDB");
    
    // Start the server after MongoDB connection is established
    app.listen(port, () => {
      console.log(`✅ Server running at http://localhost:${port}/signup.html`);
    });
  })
  .catch(err => {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  });
