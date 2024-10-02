# Multi-Part Upload Coordinator

This Workers implements a multi-part upload coordinator using Cloudflare Workers and Durable Objects. It orchestrates the upload of large files to S3 by splitting them into smaller parts and managing their upload status.

## Key Components

### Durable Object (multiPartList)

- Stores upload part information in a SQLite database (`uploadparts` table).
- Methods:
  - `addUploadPart`: Adds a new upload part to the database.
  - `completeUploadPart`: Marks an upload part as complete and updates its ETag and part number.
  - `finishUpload`: Retrieves the ETags and part numbers of all completed parts.
  - `isUploadDone`: Checks if all upload parts are marked as complete.
  - `listUploadParts`: Returns a list of all upload parts.

### Queue Worker

- Processes messages from the queue to manage upload part fetching and completion.
- Message Types:
  - `partFetch`: Triggers the download and upload of a specific part to S3.
  - `partDone`: Marks a part as uploaded and updates its status in the Durable Object.
  - `allDone`: Initiates the final multipart upload completion request to S3 after all parts are uploaded.

### Fetch Handler

- Handles incoming POST requests to initiate the upload process.
- Determines the file size and calculates the number of parts required.
- Creates a multipart upload on S3 and stores the upload ID in the Durable Object.
- Enqueues `partFetch` messages for each part to be uploaded.

## Workflow

1. **Upload Request**: A POST request with S3 bucket and key is received by the fetch handler.
2. **Initialization**:
   - The handler retrieves the file size from S3.
   - It calculates the number of parts based on the configured part size.
   - It initiates a multipart upload on S3 and obtains an upload ID.
   - A Durable Object is created/accessed for this specific upload.
3. **Part Processing**:
   - The handler enqueues `partFetch` messages for each part.
   - The queue worker processes these messages:
     - Downloads the part data from S3.
     - Uploads the part to S3 using the upload ID.
     - Sends a `partDone` message upon successful upload.
4. **Part Completion**:
   - The queue worker processes `partDone` messages:
     - Updates the part status in the Durable Object.
     - Checks if all parts are uploaded.
5. **Finalization**:
   - If all parts are uploaded, the queue worker sends an `allDone` message.
   - This message triggers the final multipart upload completion request to S3, combining all uploaded parts.

## Code Overview

### Environment Variables

- `PARTSIZE`: Size of each part in bytes. - 10~20MB recommended
- `UPLOAD_WORKER_URL`: URL of the worker handling part uploads.
- `S3_ENDPOINT`, `S3_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`: S3 configuration.

### Dependencies

- `@aws-sdk/client-s3`: For interacting with S3.
- `cloudflare:workers`: For Durable Objects and queue functionality.

### Code Structure

- `multiPartList` class: Implements the Durable Object logic.
- `queue` function: Handles queue message processing. - Cloudflare Queue need to be created

  `MAKE SURE YOUR CONSUMER BATCH SIZE IS SMALL ENOUGH, recommend 1~10`

  `QUEUE CONSUMER BATCH SIZE * PART SIZE has to be lower than Workers Memory Limits which is 128MB`

- `fetch` function: Handles incoming upload requests.

This code provides a robust and scalable solution for managing large file uploads to S3 by leveraging Cloudflare Workers and Durable Objects.
