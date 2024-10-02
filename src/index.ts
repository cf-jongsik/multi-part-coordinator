import {
	S3Client,
	S3ClientConfig,
	HeadObjectCommand,
	HeadObjectCommandInput,
	GetObjectCommandInput,
	GetObjectCommand,
} from '@aws-sdk/client-s3';
import { DurableObject } from 'cloudflare:workers';

export class multiPartList extends DurableObject {
	sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(`CREATE TABLE IF NOT EXISTS uploadparts(
			partid INTEGER PRIMARY KEY,
			uploadid TEXT,
			bucket	TEXT,
			key TEXT,
			bytestart INTEGER,
			byteend INTEGER,
			complete BOOLEAN DEFAULT FALSE,
			etag TEXT DEFAULT 'null',
			partNumber INTEGER DEFAULT -1
			);`);
	}

	addUploadPart(partid: number, uploadid: string, bucket: string, key: string, bytestart: number, byteend: number): void {
		const sql = this.sql.exec(
			`INSERT OR REPLACE INTO uploadparts (partid, uploadid, bucket, key, bytestart, byteend, complete) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			partid,
			uploadid,
			bucket,
			key,
			bytestart,
			byteend,
			false
		);
	}

	completeUploadPart(partid: number, etag: string, partNumber: number): void {
		this.sql.exec(`UPDATE uploadparts SET complete = ? , etag = ?, partNumber = ? WHERE partid = ?`, true, etag, partNumber, partid);
	}

	finishUpload() {
		return this.sql.exec('SELECT etag, partNumber FROM uploadparts WHERE etag <> "null" ORDER BY partNumber ASC').toArray();
	}

	isUploadDone(): { total: number; completed: number } {
		const total = this.sql.exec(`SELECT * FROM uploadparts`).toArray().length;
		const completed = this.sql.exec(`SELECT * FROM uploadparts WHERE complete = ?`, true).toArray().length;
		return {
			total,
			completed,
		};
	}

	listUploadParts(): sqlRow[] {
		return this.sql.exec(`SELECT * FROM uploadparts`).toArray() as unknown as sqlRow[];
	}
}

export default {
	async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext) {
		const msgs = batch.messages as Message<PartFetchMsg>[];
		if (!msgs || msgs.length === 0) {
			return;
		}

		const s3Config: S3ClientConfig = {
			endpoint: env.S3_ENDPOINT, // required
			region: env.S3_REGION ?? 'auto',
			credentials: {
				accessKeyId: env.AWS_ACCESS_KEY_ID, // required
				secretAccessKey: env.AWS_SECRET_ACCESS_KEY, // required
			},
		};
		if (env.debug) console.log('s3Config', s3Config);
		const s3 = new S3Client(s3Config);

		for (let msg of msgs) {
			if (!msg.body) {
				console.error('Missing message body');
				continue; // Continue to the next message if the body is missing
			}

			try {
				let id: DurableObjectId = env.do.idFromName(msg.body.bucket + '/' + msg.body.key + '/' + msg.body.uploadid);
				let stub = env.do.get(id);

				switch (msg.body.action) {
					case 'partFetch': {
						if (env.debug) console.log('partFetch', msg.body.partid);

						// GetObject
						const input: GetObjectCommandInput = {
							// GetObjectCommandInput
							Bucket: msg.body.bucket, // required
							Key: msg.body.key, // required
							Range: `bytes=${msg.body.bytestart}-${msg.body.byteend}`,
						};
						if (env.debug) console.log('input', input);
						const command = new GetObjectCommand(input);

						const s3Res = await s3.send(command);
						if (env.debug) console.log(s3Res);

						// Check if s3Res.Body exists before accessing it
						if (!s3Res.Body) {
							throw new Error('Failed to fetch part from S3');
						}

						const workerURL = new URL(
							`${env.UPLOAD_WORKER_URL}/${msg.body.key}?action=mpu-uploadpart&uploadId=${msg.body.uploadid}&partNumber=${
								msg.body.partid + 1
							}`
						);

						const uploadRes = await fetch(workerURL, {
							method: 'PUT',
							body: await s3Res.Body?.transformToByteArray(),
							headers: { 'Content-Type': 'application/octet-stream' },
						});

						if (!uploadRes.ok) {
							throw new Error(`Failed to upload part to worker: ${uploadRes.status} ${await uploadRes.text()}`);
						}

						const uploadResJson = (await uploadRes.json()) as R2UploadedPart;
						if (env.debug) console.log(uploadResJson);

						const partDoneMsg: PartFetchMsg = {
							action: 'partDone',
							partid: msg.body.partid,
							uploadid: msg.body.uploadid,
							bucket: msg.body.bucket,
							key: msg.body.key,
							bytestart: msg.body.bytestart,
							byteend: msg.body.byteend,
							complete: true,
							etag: uploadResJson.etag,
							partNumber: uploadResJson.partNumber,
						};
						await env.queue.send(partDoneMsg, { contentType: 'json' });
						break;
					}
					case 'partDone': {
						if (env.debug) console.log('partDone', msg.body.partid);
						if (!msg.body.etag || !msg.body.partNumber) {
							console.error('Missing ETag or part number in partDone message');
							return; // Return early if required data is missing
						}
						await stub.completeUploadPart(msg.body.partid, msg.body.etag, msg.body.partNumber);
						const { completed, total } = await stub.isUploadDone();
						if (env.debug) console.log(completed, '/', total, 'done');
						if (completed === total) {
							const allDoneMsg: PartFetchMsg = {
								action: 'allDone',
								bucket: msg.body.bucket,
								key: msg.body.key,
								uploadid: msg.body.uploadid,
								complete: true,
								partid: msg.body.partid,
							};
							await env.queue.send(allDoneMsg, { contentType: 'json' });
						}
						break;
					}
					case 'allDone': {
						if (env.debug) console.log('allDone', msg.body.key);

						// Retrieve uploadedPart list
						const list = (await stub.finishUpload()) as unknown as R2UploadedPart[];
						if (!list) {
							console.error('Upload data not found for allDone message');
							return; // Return early if upload data is not found
						}
						const returnJson = { parts: list };
						if (env.debug) console.log('returnJson', returnJson);

						const workerURL = new URL(`${env.UPLOAD_WORKER_URL}/${msg.body.key}?action=mpu-complete&uploadId=${msg.body.uploadid}`);

						const completeRes = await fetch(workerURL, {
							method: 'POST',
							body: JSON.stringify(returnJson),
							headers: { 'Content-Type': 'application/json' },
						});
						if (env.debug) console.log(completeRes);

						if (completeRes.status == 200) console.log('upload complete');
						break;
					}
					default:
						if (env.debug) console.log('default action', msg.body);
				}
			} catch (e) {
				console.error('Error processing queue message:', e);
				return;
			}
		}
	},
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		if (request.method !== 'POST') {
			return new Response('Method Not Allowed', { status: 405 });
		}
		try {
			const requestJson: RequestJson = await request.json();
			if (!requestJson || !requestJson.s3_bucket || !requestJson.s3_key) {
				return new Response('Invalid request body', { status: 400 });
			}
			if (env.debug) console.log('request', requestJson);

			// get file size from S3 using @aws-sdk/S3Client
			const s3Config: S3ClientConfig = {
				endpoint: env.S3_ENDPOINT, // required
				region: env.S3_REGION ?? 'auto',
				credentials: {
					accessKeyId: env.AWS_ACCESS_KEY_ID, // required
					secretAccessKey: env.AWS_SECRET_ACCESS_KEY, // required
				},
			};
			if (env.debug) console.log('s3Config', s3Config);
			const s3 = new S3Client(s3Config);

			// HeadObjectCommand
			const input: HeadObjectCommandInput = {
				// HeadObjectCommandInput
				Bucket: requestJson.s3_bucket, // required
				Key: requestJson.s3_key, // required
			};
			if (env.debug) console.log('input', input);
			const command = new HeadObjectCommand(input);

			const s3Res = await s3.send(command);
			if (env.debug) console.log(s3Res);

			// get part count
			const partSize = env.PARTSIZE;
			const fileSize = s3Res.ContentLength;
			// Check for valid fileSize and partSize
			if (!fileSize || !partSize) {
				return new Response('Invalid file size or part size', { status: 400 });
			}

			const parts = Math.ceil(fileSize / partSize);
			if (parts <= 0) {
				return new Response('Invalid parts size', { status: 400 });
			}
			if (env.debug) console.log('filesize', fileSize, 'partsize', partSize, '# of parts', parts);

			const workerURL = new URL(`${env.UPLOAD_WORKER_URL}/${requestJson.s3_key}?action=mpu-create`);
			const fetchRes = await fetch(workerURL, { method: 'POST' });
			if (!fetchRes.ok) {
				throw new Error(`Failed to create multipart upload: ${fetchRes.status} ${await fetchRes.text()}`);
			}

			const json = (await fetchRes.json()) as WorkerPostResponse;
			if (!json) {
				return new Response('Invalid Worker Response', { status: 400 });
			}
			if (env.debug) console.log('json', json);

			// get DO
			let id: DurableObjectId = env.do.idFromName(requestJson.s3_bucket + '/' + requestJson.s3_key + '/' + json.uploadId);
			let stub = env.do.get(id);

			// create multi-part upload db
			for (let counter = 0; counter < parts; counter++) {
				let bytestart = counter * partSize;
				let byteend = bytestart + partSize - 1;
				if (counter === parts - 1) {
					byteend = fileSize - 1;
				}
				if (env.debug) console.log(counter, requestJson.s3_bucket, requestJson.s3_key, bytestart, byteend);
				await stub.addUploadPart(counter, json.uploadId, requestJson.s3_bucket, requestJson.s3_key, bytestart, byteend);
				// send msgs queues
				const messages: PartFetchMsg = {
					action: 'partFetch',
					partid: counter,
					uploadid: json.uploadId,
					bucket: requestJson.s3_bucket,
					key: requestJson.s3_key,
					bytestart: bytestart,
					byteend: byteend,
					complete: false,
				};
				await env.queue.send(messages);
			}
			const list = await stub.listUploadParts();
			if (env.debug) console.log('list', list);
			return Response.json(
				{
					totalParts: list.length,
					partSize: partSize,
					fileSize: list[list.length - 1].byteend,
					uploadID: list[0].uploadid,
					bucket: list[0].bucket,
					key: list[0].key,
				},
				{ status: 200 }
			);
		} catch (e) {
			if (e instanceof Error) {
				console.error(e);
				return new Response(e.message, { status: 500 });
			} else {
				console.error('Unknown error:', e);
				return new Response('Internal Server Error', { status: 500 });
			}
		}
	},
} satisfies ExportedHandler<Env>;
