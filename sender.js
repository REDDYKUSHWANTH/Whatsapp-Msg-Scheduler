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

// Define all MongoDB schemas
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

// Receipt schema/model for delivery/read receipts
const receiptSchema = new mongoose.Schema({
  messageId: { type: String, unique: true },
  task: { type: mongoose.Schema.Types.ObjectId, ref: "Task" },
  ack: Number,
  timestamp: Date,
});
const Receipt = mongoose.model("Receipt", receiptSchema);

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

// Parse browser arguments from environment variables or use defaults
const parseBrowserArgs = () => {
  const defaultArgs = [
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
    defaultArgs.push("--disable-features=TranslateUI");
    defaultArgs.push("--disable-background-networking");
  } else if (isLinux) {
    defaultArgs.push("--no-zygote");
    defaultArgs.push("--single-process");
  }
  
  // Get args from environment variable if set
  if (process.env.PUPPETEER_ARGS) {
    try {
      const envArgs = process.env.PUPPETEER_ARGS.split(' ');
      logInfo("Using browser args from environment:", envArgs);
      // Ensure --no-sandbox is included for container environments
      if (!envArgs.includes('--no-sandbox')) {
        envArgs.push('--no-sandbox');
      }
      return envArgs;
    } catch (err) {
      logError("Error parsing PUPPETEER_ARGS:", err);
    }
  }
  
  // Always ensure --no-sandbox is included for container environments
  if (!defaultArgs.includes('--no-sandbox')) {
    defaultArgs.push('--no-sandbox');
  }
  
  return defaultArgs;
};

// Get browser arguments
const browserArgs = parseBrowserArgs();

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

// Initialize WhatsApp client function will be replaced with a fixed version below

// Create a global client variable
let client;

// Create custom puppeteer browser instance for WAWebJS
async function createCustomPuppeteerBrowser() {
  try {
    const executablePath = await findChromeExecutablePath();
    
    // Log launch configuration for debugging
    logInfo('Launching browser with configuration:');
    logInfo('- Executable path:', executablePath || 'Default');
    logInfo('- Arguments:', browserArgs);
    
    // Create data directories with proper permissions if they don't exist
    const dataDir = path.join(__dirname, '.browser-data');
    const authDir = path.join(__dirname, '.wwebjs_auth');
    
    for (const dir of [dataDir, authDir]) {
      if (!fs.existsSync(dir)) {
        try {
          fs.mkdirSync(dir, { recursive: true });
          logInfo(`Created directory: ${dir}`);
        } catch (err) {
          logError(`Failed to create directory ${dir}:`, err);
        }
      }
    }
    
    // Launch browser with optimized configuration
    const browser = await puppeteer.launch({
      headless: true,
      args: browserArgs,
      executablePath,
      ignoreHTTPSErrors: true,
      defaultViewport: { width: 1280, height: 800 },
      timeout: 120000,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      dumpio: process.env.NODE_ENV !== 'production', // Log browser console in dev mode
    });
    
    // Log successful launch
    const version = await browser.version();
    logInfo('Browser launched successfully:', version);
    
    return browser;
  } catch (error) {
    logError('Error creating custom browser:', error);
    throw error;
  }
}
        dataPath: authPath,
        clientId: 'whatsapp-scheduler'
      }),
      puppeteer: {
        // Use our custom browser instance
        browser: await createCustomPuppeteerBrowser(),
        // Explicitly set these properties for more reliability
        browserArgs: browserArgs,
        headless: true,
      },
      webVersionCache: { type: 'local' },
      restartOnAuthFail: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.67 Safari/537.36',
    });

    // Set up event handlers
    newClient.on("qr", async (qr) => {
      try {
        currentQR = await qrcode.toString(qr, { type: "svg" });
        logInfo("QR Code generated - scan to connect WhatsApp");
        isReady = false;
      } catch (err) {
        logError("Error generating QR code:", err);
      }
    });

    newClient.on("ready", () => {
      logInfo("WhatsApp is ready and connected!");
      currentQR = null;
      isReady = true;
      initRetries = 0;
    });

    newClient.on("auth_failure", (msg) => {
      logError("WhatsApp authentication failed:", msg);
      currentQR = null;
      isReady = false;
    });

    newClient.on("disconnected", (reason) => {
      logInfo("WhatsApp disconnected. Reason:", reason);
      isReady = false;
      
      if (initRetries < MAX_RETRIES) {
        const delay = 5000 + (initRetries * 2000); // Increasing backoff
        logInfo(`Will attempt reconnection in ${delay/1000} seconds (${initRetries+1}/${MAX_RETRIES})...`);
        
        setTimeout(() => {
          initClient(newClient);
        }, delay);
      } else {
        logError("Maximum reconnection attempts reached. Please restart the server.");
      }
    });

    // Add error logging
    newClient.on("message_create", (msg) => {
      logDebug("New message created:", msg.body?.substring(0, 20) + "...");
    });
    
    // Listen for delivery/read acknowledgments
    newClient.on("message_ack", async (msg, ack) => {
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

    return newClient;
  } catch (error) {
    logError("Fatal error setting up WhatsApp client:", error);
    throw error;
  }
}

// This function is replaced with the optimized version below
    client = existingClient || await setupWhatsAppClient();
    
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

// Receipt schema is now defined above with other models
// Define all MongoDB schemas
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

// Create a global client variable
let client;

// Create custom puppeteer browser instance for WAWebJS
async function createCustomPuppeteerBrowser() {
  try {
    const executablePath = await findChromeExecutablePath();
    
    // Log launch configuration for debugging
    logInfo('Launching browser with configuration:');
    logInfo('- Executable path:', executablePath || 'Default');
    logInfo('- Arguments:', browserArgs);
    
    // Create data directories with proper permissions if they don't exist
    const dataDir = path.join(__dirname, '.browser-data');
    const authDir = path.join(__dirname, '.wwebjs_auth');
    
    for (const dir of [dataDir, authDir]) {
      if (!fs.existsSync(dir)) {
        try {
          fs.mkdirSync(dir, { recursive: true });
          logInfo(`Created directory: ${dir}`);
        } catch (err) {
          logError(`Failed to create directory ${dir}:`, err);
        }
      }
    }
    
    // Launch browser with optimized configuration
    const browser = await puppeteer.launch({
      headless: true,
      args: browserArgs,
      executablePath,
      ignoreHTTPSErrors: true,
      defaultViewport: { width: 1280, height: 800 },
      timeout: 120000,
      handleSIGINT: false,
      handleSIGTERM: false,
      
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
