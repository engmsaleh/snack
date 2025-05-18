import aws from 'aws-sdk';
import logger from '../logger';
import config from '../config';

export type { S3 } from 'aws-sdk';

// Base AWS SDK configuration (region might still be useful for some SDK functionalities)
aws.config.update({
  region: config.s3.region, 
});

let s3ClientOptions: aws.S3.ClientConfiguration = {
  // Default to AWS region if no specific endpoint is set
  region: config.s3.region,
};

// Check if we are targeting MinIO or a custom S3-compatible endpoint
if (process.env.S3_ENDPOINT_URL) {
  s3ClientOptions = {
    endpoint: process.env.S3_ENDPOINT_URL,
    accessKeyId: process.env.S3_ACCESS_KEY_ID, // Use MinIO specific key
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY, // Use MinIO specific secret
    s3ForcePathStyle: true, // Essential for MinIO
    signatureVersion: 'v4', // Often helpful for S3 compatibles
    region: config.s3.region, // Can be a dummy value for MinIO like 'us-east-1' but SDK might require it
  };
  logger.info({ 
    message: 'S3 client configured for custom endpoint (MinIO)',
    endpoint: s3ClientOptions.endpoint,
    accessKeyId: s3ClientOptions.accessKeyId ? 'Provided' : 'Not Provided',
    forcePathStyle: s3ClientOptions.s3ForcePathStyle,
  }, 'S3 Client Config for MinIO');
} else {
  // Standard AWS S3 configuration using AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY from config
  s3ClientOptions = {
    accessKeyId: config.aws.access_key, 
    secretAccessKey: config.aws.secret_key,
    region: config.s3.region,
    // signatureVersion: 'v4', // v4 is default for most regions now
  };
   logger.info({ 
    message: 'S3 client configured for AWS S3',
    region: s3ClientOptions.region,
    accessKeyId: config.aws.access_key ? 'Provided' : 'Not Provided',
  }, 'S3 Client Config for AWS');
}

export const s3 = new aws.S3(s3ClientOptions);

// This import was not used, ensure logger is correctly imported if used in this file.
// import logger from '../logger';
// If logger is needed, it should be imported like this:
// import logger from '../logger'; // Removed redundant/commented out import
