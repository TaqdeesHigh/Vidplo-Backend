// I have tried my best to add as many statements as possible to explain the code
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const mysql = require('mysql2/promise');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const FormData = require('form-data');
const rateLimit = require('express-rate-limit');
const winston = require('winston');

const app = express();
const PORT = process.env.PORT || 28045; // Port for the backend server, configurable via environment variable
const API_KEY = process.env.API_KEY; // API Key for general authentication (if used later), configurable via environment variable
const steApiKey = process.env.STE_KEY; // API Key for STE (payment status updates), configurable via environment variable

app.set('trust proxy', 1); // Enable trust proxy for rate limiting and security

const logsDir = path.join(__dirname, 'logs');
fs.mkdirSync(logsDir, { recursive: true }); // Ensure logs directory exists

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      (info) => `${info.timestamp} [${info.level}]: ${info.message}`
    )
  ),
  transports: [
    new winston.transports.File({ filename: path.join(logsDir, 'server.log') }), // General server logs
    new winston.transports.File({ filename: path.join(logsDir, 'api.log'), level: 'info' }), // API request logs
    new winston.transports.File({ filename: path.join(logsDir, 'ddos.log'), level: 'warn' }), // Rate limiting/DDoS attempt logs
    new winston.transports.Console() // Output logs to console as well
  ]
});

const allowedOrigins = process.env.CORS_ALLOWED.split(','); // Allowed origins for CORS, configurable via environment variable
const authenticateRequest = (req, res, next) => { // Middleware to authenticate requests based on origin (CORS-like, but server-side check)
  const origin = req.get('origin');

  if (!origin || allowedOrigins.includes(origin)) {
    next(); // Allow request if origin is in allowed list or no origin (same-origin)
  } else {
    logger.warn(`Blocked request from unauthorized origin: ${origin}`);
    res.status(401).json({ error: 'Unauthorized request' });
  }
};

app.use(cors({ // Enable CORS for browser requests, using dynamic origin check
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true); // Allow if origin is in allowed list or no origin (same-origin)
    } else {
      logger.warn(`Blocked CORS request from origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true // Allow sending cookies in CORS requests (if needed)
}));

app.use(express.json()); // Parse JSON request bodies
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded request bodies

app.use(express.static(path.join(__dirname, 'public'))); // Serve static files from 'public' directory
const uploadDir = path.join(__dirname, 'uploads'); // Directory for uploads
const videosDir = path.join(uploadDir, 'videos'); // Subdirectory for videos

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir); // Create upload directory if it doesn't exist
}
if (!fs.existsSync(videosDir)) {
  fs.mkdirSync(videosDir); // Create videos directory if it doesn't exist
}

const dbConfig = { // Database connection configuration, all from environment variables
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD
};

let pool; // Database connection pool

async function initializeDatabase() {
  try {
    pool = await mysql.createPool(dbConfig); // Initialize connection pool
    logger.info('Database connection established');
    await createTableIfNotExists(); // Create tables if they don't exist
  } catch (error) {
    logger.error('Failed to initialize database:', error);
    process.exit(1); // Exit if database initialization fails
  }
}

async function createTableIfNotExists() {
  // First create the file_tokens table
  const createFileTokensTable = `
    CREATE TABLE IF NOT EXISTS file_tokens (
      id INT AUTO_INCREMENT PRIMARY KEY,
      token VARCHAR(255) UNIQUE NOT NULL,
      file_path VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      user_email VARCHAR(255),
      file_size BIGINT
    )
  `;
  await pool.query(createFileTokensTable);

  // Then create the users table
  const createUsersTable = `
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      plan ENUM('Free', 'Premium', 'Custom') DEFAULT 'Free',
      storage_limit BIGINT DEFAULT 5368709120,
      storage_used BIGINT DEFAULT 0
    )
  `;
  await pool.query(createUsersTable);

    // Add this new table creation query for file metadata
  const createFileMetaTable = `
    CREATE TABLE IF NOT EXISTS file_meta (
      id INT AUTO_INCREMENT PRIMARY KEY,
      token VARCHAR(255) UNIQUE NOT NULL,
      size BIGINT NOT NULL,
      privacy ENUM('public', 'private') NOT NULL DEFAULT 'public',
      views INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;
  await pool.query(createFileMetaTable);
}

initializeDatabase(); // Initialize database connection on server start

const storage = multer.diskStorage({ // Configure disk storage for uploaded files
  destination: (req, file, cb) => {
    const userEmail = req.body.userEmail || req.query.userEmail || 'default'; // Get user email from request body or query
    const dir = path.join(videosDir, userEmail);
    fs.mkdirSync(dir, { recursive: true }); // Create user-specific directory if it doesn't exist
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname); // Use original filename for uploaded file
  }
});

const upload = multer({ storage: storage, limits: { fileSize: 1024 * 1024 * 1024 * 5 } }); // Multer upload middleware, limit file size to 5GB

const allowedExtensions = ['.mp4', '.wav', '.mp3', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.webm', '.m4v', '.3gp', '.ogg']; // Allowed file extensions for upload

async function getFilePathForToken(token) { // Function to retrieve file path from token in database
  const query = 'SELECT file_path FROM file_tokens WHERE token = ?';
  const [rows] = await pool.execute(query, [token]);
  if (rows.length === 0) {
    return null; // Token not found
  }
  return rows[0].file_path; // Return file path
}

const limiter = rateLimit({ // Rate limiter to protect against abuse
  windowMs: 15 * 60 * 1000, // 15 minutes window
  max: 100, // Max 100 requests per window per IP
  handler: (req, res, next) => {
    logger.warn(`Rate limit exceeded for ${req.ip}`);
    res.status(429).json({ error: 'Too Many Requests' });
  }
});

// Endpoint to create a directory (Example, might not be directly used by frontend in final open source version)
app.post('/createdir', authenticateRequest, (req, res) => {
  const dirName = req.body.dir_name;
  if (!dirName) {
    return res.status(400).json({ error: 'Directory name is required' });
  }
  const dirPath = path.join(videosDir, dirName);
  fs.mkdir(dirPath, { recursive: true }, (err) => {
    if (err) {
      logger.error(`Failed to create directory: ${err}`);
      return res.status(500).json({ error: 'Failed to create directory' });
    }
    logger.info(`Directory "${dirName}" created successfully`);
    res.status(201).json({ message: `Directory "${dirName}" created successfully` });
  });
});

// Serve the main index.html for frontend (static file serving)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const STORAGE_LIMITS = { // Storage limits for different user plans (configurable here)
  Free: 500 * 1024 * 1024, // 500MB
  Premium: 750 * 1024 * 1024 * 1024, // 750GB
  Custom: 1.5 * 1024 * 1024 * 1024 * 1024, // 1.5TB
  Pro: 750 * 1024 * 1024 * 1024, // 750GB (Mapped to Premium)
  Expert: 1.5 * 1024 * 1024 * 1024 * 1024 // 1.5TB (Mapped to Custom)
};

// Plan mapping for plan names consistency
const PLAN_MAPPING = {
  Pro: 'Premium',
  Expert: 'Custom'
};

// Function to set user storage limit in database based on plan
async function setUserStorageLimit(userEmail, userPlan) {
  let storageLimit;

  const mappedPlan = PLAN_MAPPING[userPlan] || userPlan; // Map plan names if needed

  storageLimit = STORAGE_LIMITS[mappedPlan] || STORAGE_LIMITS.Free; // Get storage limit from configuration

  const query = 'UPDATE users SET storage_limit = ? WHERE email = ?';
  await pool.execute(query, [storageLimit, userEmail]);
}

// Function to check and update user plan based on payment status (connects to payments table, assumes payments table exists)
async function checkAndUpdateUserPlan(userEmail) {
  try {
    console.log('Checking plan for user:', userEmail);

    // First check the payment status
    const [payments] = await pool.execute(
      `SELECT * FROM payments
       WHERE email = ? AND payment_status = 'finished'
       ORDER BY created_at DESC
       LIMIT 1`,
      [userEmail]
    );

    console.log('Found payment:', payments[0]);

    if (payments.length === 0) {
      console.log('No finished payments found');
      return null;
    }

    const payment = payments[0];

    // Map the plan and set storage limit
    let newPlan;
    let newStorageLimit;

    // Convert plan to lowercase for case-insensitive comparison
    const planLower = payment.plan.toLowerCase();

    if (planLower === 'pro') {
      newPlan = 'Premium';
      newStorageLimit = 750 * 1024 * 1024 * 1024; // 750GB
    }
    else if (planLower === 'expert') {
      newPlan = 'Custom';
      newStorageLimit = 1.5 * 1024 * 1024 * 1024 * 1024; // 1.5TB
    }
    else {
      // Default to Free plan if unknown plan type
      newPlan = 'Free';
      newStorageLimit = 500 * 1024 * 1024; // 500MB
    }

    // Only update if we have valid values
    if (newPlan && newStorageLimit) {
      await pool.execute(
        'UPDATE users SET plan = ?, storage_limit = ? WHERE email = ?',
        [newPlan, newStorageLimit, userEmail]
      );

      // Verify the update
      const [updatedUser] = await pool.execute(
        'SELECT plan, storage_limit FROM users WHERE email = ?',
        [userEmail]
      );

      return {
        plan: newPlan,
        storageLimit: newStorageLimit
      };
    }

    return null;

  } catch (error) {
    console.error('Error in checkAndUpdateUserPlan:', error);
    throw error;
  }
}

// API endpoint to check user status (plan and storage limit)
app.post('/check-user-status', authenticateRequest, async (req, res) => {
  const { userEmail } = req.body;

  if (!userEmail) {
    return res.status(400).json({ error: 'User email is required' });
  }

  try {
    const userStatus = await checkAndUpdateUserPlan(userEmail);

    if (!userStatus) {
      const [userRows] = await pool.execute(
        'SELECT plan, storage_limit FROM users WHERE email = ?',
        [userEmail]
      );

      if (userRows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      return res.json({
        plan: userRows[0].plan,
        storageLimit: userRows[0].storage_limit
      });
    }

    res.json(userStatus);
  } catch (error) {
    console.error('Error checking user status:', error);
    res.status(500).json({ error: 'Failed to check user status' });
  }
});

// API endpoint to get user plan by email
app.get('/api/user-plan/:email', authenticateRequest, async (req, res) => {
  const userEmail = req.params.email;

  if (!userEmail) {
    return res.status(400).json({ error: 'User email is required' });
  }

  try {
    const [userRows] = await pool.execute(
      'SELECT plan FROM users WHERE email = ?',
      [userEmail]
    );

    if (userRows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      plan: userRows[0].plan
    });

  } catch (error) {
    console.error('Error fetching user plan:', error);
    res.status(500).json({ error: 'Failed to fetch user plan' });
  }
});

// API endpoint to create or update file metadata
app.post('/create-metadata', authenticateRequest, async (req, res) => {
  const { fileName, userEmail, fileSize, token, updateExisting } = req.body;
  const userDir = path.join(videosDir, userEmail);

  // Ensure user directory exists
  fs.mkdirSync(userDir, { recursive: true });

  // Find existing metadata files for this token
  const files = await fs.promises.readdir(userDir);
  const metadataFiles = files.filter(file =>
    file.endsWith('.json') &&
    fs.existsSync(path.join(userDir, file))
  );

  let oldMetadata = null;
  if (updateExisting) {
    // Find and read existing metadata file
    for (const file of metadataFiles) {
      const filePath = path.join(userDir, file);
      try {
        const data = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
        if (data.token === token) {
          oldMetadata = data;
          // Delete old metadata file
          await fs.promises.unlink(filePath);
          break;
        }
      } catch (err) {
        console.error(`Error reading metadata file ${file}:`, err);
      }
    }
  }

  const metadataPath = path.join(userDir, `${fileName}.json`);
  const metadata = {
    fileName,
    userEmail,
    fileSize: fileSize || (oldMetadata ? oldMetadata.fileSize : null),
    token,
    uploadDate: oldMetadata ? oldMetadata.uploadDate : new Date().toISOString(),
    updateDate: new Date().toISOString()
  };

  try {
    await fs.promises.writeFile(metadataPath, JSON.stringify(metadata));
    res.json({ message: 'Metadata file created/updated successfully' });
  } catch (err) {
    console.error('Error writing metadata file:', err);
    res.status(500).json({ error: 'Failed to create/update metadata file' });
  }
});

// API endpoint to get list of files for a user
app.get('/files', authenticateRequest, async (req, res) => {
  const userEmail = req.query.userEmail;

  if (!userEmail) {
    return res.status(400).json({ error: 'User email is required' });
  }

  try {
    const userDir = path.join(videosDir, userEmail);

    // Create directory if it doesn't exist
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
      // Return empty array since it's a new directory
      return res.json([]);
    }

    const files = await fs.promises.readdir(userDir);
    const metadataFiles = files.filter(file => file.endsWith('.json'));

    const metadataPromises = metadataFiles.map(async file => {
      const data = await fs.promises.readFile(path.join(userDir, file), 'utf8');
      return JSON.parse(data);
    });

    const metadata = await Promise.all(metadataPromises);
    res.json(metadata);

  } catch (error) {
    console.error('Error reading directory:', error);
    res.status(500).json({ error: 'Failed to read directory' });
  }
});

// API endpoint for file upload
app.post('/upload', authenticateRequest, limiter, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const userEmail = req.body.userEmail || req.query.userEmail;
  const privacy = req.body.privacy || 'public'; // Get privacy setting from request

  if (!userEmail) {
    return res.status(400).json({ error: 'User email is required' });
  }

  try {
    const [userRows] = await pool.execute('SELECT plan, storage_limit, storage_used FROM users WHERE email = ?', [userEmail]);
    if (userRows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userPlan = userRows[0].plan;
    let storageLimit = userRows[0].storage_limit;
    const currentUsage = userRows[0].storage_used;

    if (storageLimit !== STORAGE_LIMITS[userPlan]) {
      await setUserStorageLimit(userEmail, userPlan);
      storageLimit = STORAGE_LIMITS[userPlan];
    }

    const remainingStorage = storageLimit - currentUsage;

    if (req.file.size > remainingStorage) {
      if (req.file.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path); // Delete partially uploaded file if storage exceeded
      }
      return res.status(400).json({
        error: 'File size exceeds remaining storage capacity',
        remainingStorage: remainingStorage,
        fileSize: req.file.size
      });
    }

    const userDir = path.join(videosDir, userEmail);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }

    const fileExt = path.extname(req.file.originalname).toLowerCase();
    if (!allowedExtensions.includes(fileExt)) {
      if (req.file.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path); // Delete invalid file type
      }
      return res.status(400).json({ error: 'Invalid file type' });
    }

    const oldPath = req.file.path;
    const newPath = path.join(userDir, req.file.filename);
    fs.renameSync(oldPath, newPath); // Move uploaded file to user directory

    const formData = new FormData();
    formData.append('file', fs.createReadStream(newPath));
    formData.append('userEmail', userEmail);
    formData.append('filename', req.file.filename);
    formData.append('privacy', privacy); // Add privacy to form data

    const response = await axios.post( // Send file to storage server
      `${process.env.STORAGE_SERVER_URL}/receive?userEmail=${encodeURIComponent(userEmail)}`,
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          'Authorization': `Bearer ${process.env.STORAGE_SERVER_API_KEY}`,
          'X-User-Email': userEmail
        },
        maxContentLength: Infinity, // Allow large files
        maxBodyLength: Infinity
      }
    );

    const [existingToken] = await pool.execute( // Check if token already exists for this file path and user
      'SELECT token FROM file_tokens WHERE file_path = ? AND user_email = ?',
      [newPath, userEmail]
    );

    let token;
    if (existingToken.length > 0) {
      token = existingToken[0].token; // Use existing token
      // Update existing metadata
      await pool.execute(
        'UPDATE file_meta SET privacy = ?, size = ? WHERE token = ?',
        [privacy, req.file.size, token]
      );
    } else {
      token = response.data.token; // Get new token from storage server response
      // Insert into file_tokens
      await pool.execute(
        'INSERT INTO file_tokens (token, file_path, user_email, file_size) VALUES (?, ?, ?, ?)',
        [token, newPath, userEmail, req.file.size]
      );

      // Insert into file_meta
      await pool.execute(
        'INSERT INTO file_meta (token, privacy, size) VALUES (?, ?, ?)',
        [token, privacy, req.file.size]
      );
    }

    if (fs.existsSync(newPath)) {
      fs.unlinkSync(newPath); // Delete local copy after successful upload to storage server
    }

    const updatedUsage = currentUsage + req.file.size;
    await pool.execute('UPDATE users SET storage_used = ? WHERE email = ?', [updatedUsage, userEmail]); // Update user storage usage in database

    const newRemainingStorage = storageLimit - updatedUsage;

    if (response.data.token) {
      try {
        // First check if entry exists in file_meta
        const [existingMeta] = await pool.execute(
          'SELECT token FROM file_meta WHERE token = ?',
          [response.data.token]
        );

        if (existingMeta.length === 0) {
          // Only insert if it doesn't exist
          await pool.execute(
            'INSERT INTO file_meta (token, size, privacy) VALUES (?, ?, ?)',
            [response.data.token, req.file.size, req.body.privacy]
          );
        } else {
          // Update existing record instead
          await pool.execute(
            'UPDATE file_meta SET size = ?, privacy = ? WHERE token = ?',
            [req.file.size, req.body.privacy, response.data.token]
          );
        }

        // Get the metadata for response
        const [metadata] = await pool.execute(
          'SELECT privacy, views FROM file_meta WHERE token = ?',
          [response.data.token]
        );

        res.json({ // Respond with success message and file information
          message: 'File uploaded successfully and encoding started',
          filename: req.file.filename,
          userEmail: userEmail,
          storageUsed: updatedUsage,
          storageLimit: storageLimit,
          remainingStorage: newRemainingStorage,
          userPlan: userPlan,
          token: response.data.token,
          privacy: metadata[0].privacy,
          views: metadata[0].views || 0,
          size: req.file.size
        });
      } catch (error) {
        console.error('Error handling file metadata:', error);
        throw error;
      }
    }
  } catch (error) {
    console.error('Error in file upload:', error);
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path); // Delete partially uploaded file on error
    }
    res.status(500).json({
      error: 'Failed to process file upload',
      details: error.message
    });
  }
});

// Utility function to get user plan from database
async function getUserPlan(userEmail) {
  console.log("Getting user plan for email:", userEmail);
  const query = 'SELECT plan FROM users WHERE email = ?';
  const [rows] = await pool.execute(query, [userEmail]);
  const plan = rows.length > 0 ? rows[0].plan : "Free";
  console.log("User plan fetched from database:", plan);
  return plan;
}

// API endpoint to initiate file download (Premium users only)
app.get('/api/initiate-download/:token', async (req, res) => {
  console.log("Initiating download for token:", req.params.token);
  const { token } = req.params;

  try {
    const filePath = await getFilePathForToken(token);

    if (!filePath) {
      console.log("Invalid token:", token);
      return res.status(404).json({ error: 'Invalid token' });
    }

    console.log("File path:", filePath);
    const userEmail = path.basename(path.dirname(filePath));
    console.log("User email:", userEmail);
    const userPlan = await getUserPlan(userEmail);
    console.log("User plan:", userPlan);

    if (userPlan === "Free") {
      console.log("Free user attempting to download");
      return res.status(403).json({ error: 'Download is only available for Premium users. Upgrade your plan to access this feature.' });
    }

    const storageServerUrl = process.env.STORAGE_SERVER_URL; // Get storage server URL from environment variable
    const downloadUrl = `${storageServerUrl}/api/initiate-download/:token/${token}`;
    console.log("Download URL:", downloadUrl);
    res.json({ downloadUrl });
  } catch (error) {
    console.error("Error in initiate-download:", error);
    res.status(500).json({ error: 'An error occurred while processing your request' });
  }
});

// API endpoint to update file name
app.post('/api/update-file-name', authenticateRequest, async (req, res) => {
  const { token, newFileName } = req.body;

  try {
    // Get file information using token
    const [fileInfo] = await pool.execute(
      'SELECT file_path, user_email FROM file_tokens WHERE token = ?',
      [token]
    );

    if (fileInfo.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    const { user_email: userEmail } = fileInfo[0];
    const oldFileName = path.basename(fileInfo[0].file_path);

    // Find and rename the old metadata file
    const oldMetadataPath = path.join(videosDir, userEmail, `${oldFileName}.json`);
    const newMetadataPath = path.join(videosDir, userEmail, `${newFileName}.json`);

    if (fs.existsSync(oldMetadataPath)) {
      // Read existing metadata
      const metadata = JSON.parse(fs.readFileSync(oldMetadataPath, 'utf8'));

      // Update metadata with new filename
      metadata.fileName = newFileName;
      metadata.updateDate = new Date().toISOString();

      // Write updated metadata to new file
      fs.writeFileSync(newMetadataPath, JSON.stringify(metadata));

      // Delete old metadata file
      fs.unlinkSync(oldMetadataPath);
    }

    // Send rename request to storage server
    const response = await axios.post(`${process.env.STORAGE_SERVER_URL}/rename-file`, {
      token,
      newFileName,
      userEmail
    }, {
      headers: { 'Authorization': `Bearer ${process.env.STORAGE_SERVER_API_KEY}` }
    });

    res.json({
      message: 'File and metadata renamed successfully',
      newFileName,
      token: response.data.token || token
    });

  } catch (error) {
    console.error('Error updating file name:', error);
    res.status(500).json({
      error: 'Failed to update file name',
      details: error.message
    });
  }
});

// API endpoint to request file deletion
app.delete('/request/delete/:token', authenticateRequest, async (req, res) => {
  const { token } = req.params;

  try {
    // Get file information using token
    const [fileInfo] = await pool.execute(
      'SELECT file_path, user_email, file_size FROM file_tokens WHERE token = ?',
      [token]
    );

    if (fileInfo.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    const { user_email: userEmail, file_size: fileSize } = fileInfo[0];
    const fileName = path.basename(fileInfo[0].file_path);

    // Delete metadata file
    const metadataPath = path.join(videosDir, userEmail, `${fileName}.json`);
    if (fs.existsSync(metadataPath)) {
      fs.unlinkSync(metadataPath);
    }

    // Send delete request to storage server
    await axios.delete(`${process.env.STORAGE_SERVER_URL}/delete-file`, {
      data: {
        token,
        userEmail
      },
      headers: {
        'Authorization': `Bearer ${process.env.STORAGE_SERVER_API_KEY}`
      }
    });

    // Remove token from database
    await pool.execute('DELETE FROM file_tokens WHERE token = ?', [token]);

    // Update user's storage usage
    const updateStorageQuery = 'UPDATE users SET storage_used = GREATEST(storage_used - ?, 0) WHERE email = ?';
    await pool.execute(updateStorageQuery, [fileSize, userEmail]);

    res.json({
      message: 'File and metadata deleted successfully',
      details: {
        storageFreed: fileSize,
        userEmail: userEmail
      }
    });

  } catch (error) {
    console.error('Error processing file deletion:', error);
    res.status(500).json({
      error: 'Failed to process file deletion',
      details: error.message
    });
  }
});

// API endpoint to get file thumbnail
app.get('/api/thumbnail/:token', authenticateRequest, async (req, res) => {
  const { token } = req.params;

  try {
    const [fileInfo] = await pool.execute(
      'SELECT user_email FROM file_tokens WHERE token = ?',
      [token]
    );

    if (fileInfo.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    const thumbnailUrl = `${process.env.STORAGE_SERVER_URL}/api/thumbnail/${token}`;
    const response = await axios.get(thumbnailUrl, {
      responseType: 'arraybuffer',
      headers: {
        'Authorization': `Bearer ${process.env.STORAGE_SERVER_API_KEY}`
      }
    });

    res.set('Content-Type', 'image/jpeg');
    res.send(response.data);

  } catch (error) {
    console.error('Error fetching thumbnail:', error);
    res.status(500).json({ error: 'Failed to fetch thumbnail' });
  }
});

// API endpoint to request thumbnail deletion (potentially unused in frontend, but kept for completeness)
app.delete('/request/delete-thumbnail/:token', authenticateRequest, async (req, res) => {
  const { token } = req.params;

  try {
    const [fileInfo] = await pool.execute(
      'SELECT file_path, user_email FROM file_tokens WHERE token = ?',
      [token]
    );

    if (fileInfo.length === 0) {
      return res.status(404).json({ error: 'Token not found' });
    }

    const { file_path: filePath, user_email: userEmail } = fileInfo[0];
    const fileName = path.basename(filePath);
    const thumbnailName = fileName.replace(/\.[^/.]+$/, "_thumbnail.jpg");

    await axios.delete(`${process.env.STORAGE_SERVER_URL}/delete-file`, {
      headers: {
        'Authorization': `Bearer ${process.env.STORAGE_SERVER_API_KEY}`
      },
      data: {
        userEmail: userEmail,
        fileName: thumbnailName
      }
    });

    res.json({ message: 'Thumbnail deletion request sent successfully' });

  } catch (error) {
    console.error('Error processing thumbnail deletion:', error);
    res.status(500).json({ error: 'Failed to process thumbnail deletion' });
  }
});

// API endpoint to request a token from storage server (potentially unused in current flow, but kept for flexibility)
app.post('/request-token', authenticateRequest, async (req, res) => {
  const { fileName, userEmail } = req.body;

  if (!fileName || !userEmail) {
    return res.status(400).json({ error: 'File name and user email are required' });
  }

  try {
    const response = await axios.post(
      `${process.env.STORAGE_SERVER_URL}/request-token`,
      {
        filePath: fileName,
        userEmail: userEmail
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.STORAGE_SERVER_API_KEY}`
        }
      }
    );

    if (response.data.token) {
      console.log('Token received for file:', fileName);
      return res.json({ token: response.data.token });
    } else {
      console.log('No token found for file:', fileName);
      return res.status(404).json({ error: 'No token found for this file' });
    }

  } catch (error) {
    console.error('Error requesting token from storage server:', error);
    res.status(500).json({
      error: 'Failed to retrieve token',
      details: error.response ? error.response.data : error.message
    });
  }
});

// API endpoint to receive payment status updates from STE (Payment Gateway)
app.post('/api/ste', async (req, res) => {
  const { referenceId, status, steApiKey: providedSteApiKey } = req.body;

  try {
    if (!steApiKey || providedSteApiKey !== steApiKey) {
      logger.warn(`Invalid STE API key used from IP: ${req.ip}`);
      return res.status(401).json({ error: 'Unauthorized: Invalid STE API key' });
    }

    const [result] = await pool.execute(
      'UPDATE payments SET payment_status = ? WHERE reference_id = ?',
      [status, referenceId]
    );

    // 3. Handle Update Results:
    if (result.affectedRows === 0) {
      // No matching reference_id was found
      logger.warn(`No payment found for reference ID: ${referenceId}`);
      return res.status(404).json({ error: 'Payment not found' });
    }

    // 4. Send Success Response:
    logger.info(`Payment status updated to "${status}" for reference ID: ${referenceId}`);
    res.json({ message: 'Payment status updated successfully' });

  } catch (error) {
    logger.error(`Error updating payment status: ${error}`);
    res.status(500).json({ error: 'Failed to update payment status' });
  }
});

// API endpoint to get file analytics (views, privacy, size)
app.get('/api/file-analytics/:token', authenticateRequest, async (req, res) => {
  const { token } = req.params;

  try {
    // Fetch analytics data from file_meta table
    const [fileMetaData] = await pool.execute(
      'SELECT views, privacy, size FROM file_meta WHERE token = ?',
      [token]
    );

    if (fileMetaData.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.json({
      views: fileMetaData[0].views || 0,
      privacy: fileMetaData[0].privacy,
      size: fileMetaData[0].size
    });

  } catch (error) {
    console.error('Error fetching file analytics:', error);
    res.status(500).json({ error: 'Failed to fetch analytics data' });
  }
});

// --- Global Error Handler ---
app.use((err, req, res, next) => {
  logger.error(`Internal Server Error: ${err.stack}`);
  res.status(500).json({ error: 'Internal Server Error' });
});

// --- Start the Server ---
app.listen(PORT, () => {
  logger.info(`Backend server listening at ${PORT}`);
});