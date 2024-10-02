type WorkerPostResponse = {
	key: string;
	uploadId: string;
};

type RequestJson = {
	s3_bucket: string;
	s3_key: string;
};

type sqlRow = {
	partid: number;
	uploadid: string;
	bucket: string;
	key: string;
	bytestart?: number;
	byteend?: number;
	complete: boolean;
	etag?: string;
	partNumber?: number;
};

interface PartFetchMsg extends sqlRow {
	action: string;
}
