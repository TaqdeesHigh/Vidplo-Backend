# Vidplo Backend - Open Source

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Description

This is the backend server for Vidplo, a video platform. It handles file uploads, storage management, user authentication (origin-based), database interactions, and API endpoints for the frontend application.

**Important:** This backend is designed to work in conjunction with a separate storage server. This repository provides the application logic, API endpoints, and database interaction, but *not* the actual file storage and encoding services. You will need to set up a compatible storage server (like the example mentioned in the code comments) separately and configure the `STORAGE_SERVER_URL` and `STORAGE_SERVER_API_KEY` environment variables.

## Setup Instructions

1.  **Clone the repository:**
    ```bash
    git clone [repository URL]
    cd vidplo-backend
    ```

2.  **Install Dependencies:**
    ```bash
    npm install
    ```

3.  **Database Setup (MySQL):**
    *   You need a MySQL database server.
    *   Create a database named (e.g., `Vidplo`).
    *   Create a user with appropriate permissions for this database.
    *   **Important:**  The backend expects the following tables to be created automatically on first run: `file_tokens`, `users`, and `file_meta`.  If you encounter issues, ensure your database user has `CREATE TABLE` privileges.  Optionally, you can manually create a `payments` table if you intend to use the payment plan update functionality (schema not provided here, as it's payment gateway specific).

4.  **Environment Variables:**
    *   Create a `.env` file in the root directory of the project.
    *   Fill in the following environment variables based on your setup. **Replace the placeholder values with your actual configuration.**

    ```env
    DB_HOST=your_db_host.example.com      # MySQL Database Host
    DB_PORT=3306                          # MySQL Database Port (default: 3306)
    DB_DATABASE=your_database_name        # MySQL Database Name
    DB_USER=your_db_user                  # MySQL Database User
    DB_PASSWORD=your_db_password          # MySQL Database Password
    INTERNAL_API_KEY=your_internal_api_key # API Key for internal backend security (if used)
    DELETE_API_KEY=your_delete_api_key     # API Key for delete operations (if used)
    CORS_ALLOWED=http://localhost:3000,https://your-frontend-domain.com,https://your-storage-domain.com # Comma-separated list of allowed origins for CORS
    STORAGE_SERVER_URL=https://your-storage-domain.com # URL of your storage server
    STORAGE_SERVER_API_KEY=your_storage_server_api_key # API Key for your storage server
    PORT=25621                             # Port for the backend server (optional, default: 28045 or from .env)
    STE_KEY=your_ste_api_key                # API Key for STE (payment status updates) - if using payment integration
    ```

5.  **Start the Server:**
    ```bash
    npm start
    ```
    The server should now be running at `http://localhost:[PORT]` (or the port you configured).

## API Endpoints

This backend provides the following API endpoints.  All endpoints (unless explicitly noted) are protected by `authenticateRequest` middleware, which checks the `Origin` header against the `CORS_ALLOWED` environment variable.

**General Endpoints:**

*   **`GET /`**
    *   Serves the `index.html` file from the `public` directory (for testing or basic frontend).

**User Management Endpoints:**

*   **`POST /check-user-status`**
    *   **Method:** POST
    *   **Request Body (JSON):**
        ```json
        {
            "userEmail": "user@example.com"
        }
        ```
    *   **Response (JSON):**
        ```json
        {
            "plan": "Free" | "Premium" | "Custom",
            "storageLimit": number // Storage limit in bytes
        }
        ```
    *   Checks and updates user plan based on payment status (if payments table is configured) and returns current plan and storage limit.

*   **`GET /api/user-plan/:email`**
    *   **Method:** GET
    *   **Path Parameters:**
        *   `email`: User's email address.
    *   **Response (JSON):**
        ```json
        {
            "plan": "Free" | "Premium" | "Custom"
        }
        ```
    *   Retrieves the user's current plan from the database.

**File Management Endpoints:**

*   **`POST /upload`**
    *   **Method:** POST
    *   **Content-Type:** `multipart/form-data`
    *   **Form Data:**
        *   `file`: The file to upload (video/audio file, allowed extensions: `.mp4`, `.wav`, `.mp3`, `.mov`, `.avi`, `.mkv`, `.flv`, `.wmv`, `.webm`, `.m4v`, `.3gp`, `.ogg`).
        *   `userEmail`: User's email address.
        *   `privacy` (optional): `"public"` or `"private"`, defaults to `"public"`.
    *   **Response (JSON):**
        ```json
        {
            "message": "File uploaded successfully and encoding started",
            "filename": string,
            "userEmail": string,
            "storageUsed": number,
            "storageLimit": number,
            "remainingStorage": number,
            "userPlan": string,
            "token": string, // Unique token for the uploaded file
            "privacy": "public" | "private",
            "views": number,
            "size": number
        }
        ```
    *   Uploads a file, sends it to the storage server, updates user storage, and returns file information including a unique token.

*   **`GET /files`**
    *   **Method:** GET
    *   **Query Parameters:**
        *   `userEmail`: User's email address.
    *   **Response (JSON):**
        ```json
        [
            {
                "fileName": string,
                "userEmail": string,
                "fileSize": number,
                "token": string,
                "uploadDate": string (ISO Date),
                "updateDate": string (ISO Date)
            },
            ...
        ]
        ```
    *   Lists metadata for all files associated with a user.

*   **`POST /create-metadata`**
    *   **Method:** POST
    *   **Request Body (JSON):**
        ```json
        {
            "fileName": string,
            "userEmail": string,
            "fileSize": number,
            "token": string,
            "updateExisting": boolean (optional, defaults to false) // Set to true to update metadata if token exists
        }
        ```
    *   **Response (JSON):**
        ```json
        {
            "message": "Metadata file created/updated successfully"
        }
        ```
    *   Creates or updates metadata for a file. Useful for associating metadata with files managed outside the direct `/upload` endpoint (e.g., encoding pipelines).

*   **`POST /api/update-file-name`**
    *   **Method:** POST
    *   **Request Body (JSON):**
        ```json
        {
            "token": string, // File token
            "newFileName": string // New file name (without extension)
        }
        ```
    *   **Response (JSON):**
        ```json
        {
            "message": "File and metadata renamed successfully",
            "newFileName": string,
            "token": string
        }
        ```
    *   Renames a file (on the storage server) and updates its metadata.

*   **`DELETE /request/delete/:token`**
    *   **Method:** DELETE
    *   **Path Parameters:**
        *   `token`: File token.
    *   **Response (JSON):**
        ```json
        {
            "message": "File and metadata deleted successfully",
            "details": {
                "storageFreed": number,
                "userEmail": string
            }
        }
        ```
    *   Deletes a file (from the storage server), removes its metadata, and updates user storage usage.

*   **`GET /api/thumbnail/:token`**
    *   **Method:** GET
    *   **Path Parameters:**
        *   `token`: File token.
    *   **Response:** Image data (JPEG)
    *   Retrieves the thumbnail image for a file from the storage server.

*   **`DELETE /request/delete-thumbnail/:token`**
    *   **Method:** DELETE
    *   **Path Parameters:**
        *   `token`: File token.
    *   **Response (JSON):**
        ```json
        {
            "message": "Thumbnail deletion request sent successfully"
        }
        ```
    *   Requests deletion of a file's thumbnail from the storage server.

*   **`POST /request-token`**
    *   **Method:** POST
    *   **Request Body (JSON):**
        ```json
        {
            "fileName": string, // File name
            "userEmail": string // User email
        }
        ```
    *   **Response (JSON):**
        ```json
        {
            "token": string // File token
        }
        ```
    *   Requests a file token from the storage server for a given file name and user. (Potentially less used endpoint).

*   **`GET /api/initiate-download/:token`**
    *   **Method:** GET
    *   **Path Parameters:**
        *   `token`: File token.
    *   **Response (JSON):**
        ```json
        {
            "downloadUrl": string // URL to download the file (storage server URL)
        }
        ```
    *   Initiates a download for Premium users, retrieves the download URL from the storage server. **Free users will receive a 403 Forbidden error.**

*   **`GET /api/file-analytics/:token`**
    *   **Method:** GET
    *   **Path Parameters:**
        *   `token`: File token.
    *   **Response (JSON):**
        ```json
        {
            "views": number,
            "privacy": "public" | "private",
            "size": number
        }
        ```
    *   Retrieves file analytics data (views, privacy, size) from the database.

**Payment Status Endpoint (For Payment Gateway Integration):**

*   **`POST /api/ste`**
    *   **Method:** POST
    *   **Request Body (JSON):**
        ```json
        {
            "referenceId": string, // Payment reference ID
            "status": "finished" | "pending" | "failed" | ..., // Payment status
            "steApiKey": string // API Key for STE (must match server-side STE_KEY env variable)
        }
        ```
    *   **Response (JSON):**
        ```json
        {
            "message": "Payment status updated successfully"
        }
        ```
    *   Endpoint for receiving payment status updates from a payment gateway (e.g., STE). **Requires a valid `steApiKey` in the request body, matching the `STE_KEY` environment variable for security.**  Updates the `payments` table (table schema not provided here and is payment gateway specific).

**Rate Limiting:**

*   The `/upload` endpoint is protected by rate limiting to 100 requests per 15 minutes per IP address to prevent abuse.

**Error Handling:**

*   The server includes a global error handler that logs errors and returns a 500 Internal Server Error response for unhandled exceptions.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.