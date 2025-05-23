import fetch from 'node-fetch';
import path from 'path';
import raven from 'raven';

import addS3Redirect from './addS3Redirect';
import fetchAndExtract from './fetchAndExtract';
import findPath from './findPath';
import installPackage from './installPackage';
import packageBundle from './packageBundle';
import uploadFile from './uploadFile';
import getCachePrefix from '../cache-busting';
import config from '../config';
import { createRedisClient } from '../external/redis';
import logger from '../logger';
import { Package } from '../types';
import { s3 } from '../external/aws';

// TODO: find the typescript definitions for this package, `@types/sander` doesn't exists
const { mkdir, rimraf, writeFile, exists } = require('sander');

type Options = {
  pkg: Package;
  version: string;
  deep?: string | null;
  platforms: string[];
  rebuild: boolean;
  dependencies: { [key: string]: string | null };
  hash: string;
  latestHash?: string | null;
  versionSnackager: boolean;
  sdkVersion?: string;
};

const EXPIRATION_SECONDS = 60 * 30;
const client = createRedisClient();

type BundlePending = {
  name: string;
  version: string;
  pending: true;
};

type BundleResolved = {
  name: string;
  hash: string;
  handle: string;
  version: string;
  // TODO: fix possible `null` for dependency and replace this with `Package['dependencies']`
  dependencies: { [key: string]: string | null };
};

export type BundleResponse = BundlePending | BundleResolved;

export default async function fetchBundle({
  pkg,
  version,
  deep = null,
  platforms,
  rebuild,
  dependencies, // peerDependencies
  hash,
  latestHash = null,
  versionSnackager,
  sdkVersion,
}: Options): Promise<BundleResponse> {
  const fullName = `${pkg.name}${deep ? `/${deep}` : ''}`;
  const cachePrefix = getCachePrefix(fullName);
  const buildStatusRedisId =
    `snackager/buildStatus/${cachePrefix}/` +
    `${fullName}@${version}-${platforms.join(',')}`.replace(/\//g, '~');
  const latestCompletedVersionRedisId =
    `snackager/latestVersion/${cachePrefix}/` + fullName.replace(/\//g, '~');

  const handle = versionSnackager ? `snackager-${cachePrefix}/${hash}` : hash;
  const latestHandle =
    versionSnackager && latestHash ? `snackager-${cachePrefix}/${latestHash}` : latestHash;

  const logMetadata = { pkg, redisId: buildStatusRedisId };

  const peerDependencies =
    fullName === pkg.name ? dependencies : { ...dependencies, [pkg.name]: version };

  const unavailable: string[] = [];

  const inProgress: false | null | { [key: string]: string } =
    !rebuild &&
    (await new Promise((resolve) =>
      client.hgetall(buildStatusRedisId, (err, value) => {
        if (err) {
          resolve(null);
        } else {
          resolve(value);
        }
      }),
    ));

  if (inProgress) {
    client.ttl(buildStatusRedisId, (err, value) => {
      if (!err && value < 0) {
        logger.warn(logMetadata, `redis value without TTL found, deleting`);
        client.del(buildStatusRedisId);
      }
    });

    if (inProgress.type === 'finished') {
      if (inProgress.hash === hash) {
        logger.info({ ...logMetadata, redisHash: inProgress.hash, requestHash: hash }, `Redis status is 'finished' and hash matches. Verifying .done files using Redis handle: ${inProgress.handle}.`);
        
        const platformCheckPromises = platforms.map(async (platform) => {
          let isPlatformDone = false;
          const checkHandle = inProgress.handle;
          
          if (process.env.DEBUG_LOCAL_FILES) {
            const doneFilePath = path.join(config.tmpdir, 'output', `${checkHandle}-${platform}/.done`);
            if (await exists(doneFilePath)) {
              isPlatformDone = true;
              logger.info({ ...logMetadata, platform, path: doneFilePath }, `Platform ${platform} .done file VERIFIED locally (used Redis handle: ${checkHandle}).`);
            } else {
              logger.warn({ ...logMetadata, platform, path: doneFilePath }, `Platform ${platform} .done file NOT found locally (used Redis handle: ${checkHandle}, expected for finished Redis state).`);
            }
          } else {
            const s3Key = `${checkHandle}-${platform}/.done`;
            logger.info({ ...logMetadata, platform, bucket: config.s3.bucket, key: s3Key, handleFromRedis: checkHandle }, `Verifying .done file via s3.headObject on S3-compatible storage`);
            try {
              await s3
                .headObject({
                  Bucket: config.s3.bucket,
                  Key: s3Key,
                })
                .promise();
              isPlatformDone = true;
              logger.info({ ...logMetadata, platform, bucket: config.s3.bucket, key: s3Key }, `Platform ${platform} .done file VERIFIED on S3-compatible storage (used Redis handle: ${checkHandle}).`);
            } catch (e: any) {
              const status = e.statusCode || (e.code === 'NotFound' || e.code === 'NoSuchKey' ? 404 : 500);
              logger.warn(
                { ...logMetadata, platform, handle: checkHandle, status: status, errMsg: e.message },
                `Platform ${platform} .done file NOT found on S3-compatible storage (used Redis handle: ${checkHandle}, status ${status}, expected for finished Redis state).`
              );
            }
          }
          return { platform, isPlatformDone };
        });

        const platformResults = await Promise.all(platformCheckPromises);
        if (platformResults.every(result => result.isPlatformDone)) {
          logger.info({ ...logMetadata, handle: inProgress.handle }, "All platform .done files verified. Returning cached bundle based on 'finished' Redis status.");
          return {
            name: fullName,
            hash: inProgress.hash,
            handle: inProgress.handle,
            version: inProgress.version || pkg.version,
            dependencies: peerDependencies,
          };
        } else {
          logger.warn({ ...logMetadata, handleFromRedis: inProgress.handle, currentHandle: handle }, "Redis status is 'finished' with matching hash, but one or more .done files are missing. Proceeding to re-bundle.");
        }
      } else {
        logger.info({ ...logMetadata, redisHash: inProgress.hash, requestHash: hash }, `Redis status is 'finished' but for a different hash (${inProgress.hash} vs ${hash}). Re-bundling required.`);
      }
    } else if (inProgress.type === 'pending') {
      logger.info(logMetadata, `bundling is already in progress, waiting`);
      return { name: fullName, version, pending: true };
    } else if (inProgress.type === 'error') {
      logger.warn({ ...logMetadata, error: inProgress.message }, `an error occurred earlier`);
      if (!process.env.DEBUG_LOCAL_FILES) {
        throw new Error(inProgress.message);
      }
    }
  }

  await Promise.all(
    platforms.map(async (platform) => {
      if (rebuild) {
        logger.info({ ...logMetadata, platform }, `requested rebuild for platform: ${platform}`);

        unavailable.push(platform);
        return;
      }

      if (process.env.DEBUG_LOCAL_FILES) {
        if (await exists(path.join(config.tmpdir, 'output', `${handle}-${platform}/.done`))) {
          logger.info(
            { ...logMetadata, platform },
            `package is cached locally for platform: ${platform}`,
          );
        } else {
          logger.info(
            { ...logMetadata, platform },
            `is not cached locally for platform: ${platform}`,
          );
          unavailable.push(platform);
        }
      } else {
        try {
          await s3.headObject({
            Bucket: config.s3.bucket,
            Key: `${handle}-${platform}/.done`,
          }).promise();
          logger.info(
            { ...logMetadata, platform },
            `Platform ${platform} .done file found on S3-compatible storage.`
          );
        } catch (error: any) {
          const status = error.statusCode || (error.code === 'NotFound' || error.code === 'NoSuchKey' ? 404 : 500);
          logger.info(
            { ...logMetadata, platform, status: status, errMsg: error.message },
            `${pkg.name} Platform ${platform} .done file NOT found on S3-compatible storage (status ${status}) (expected for finished Redis state).`
          );
          unavailable.push(platform);
        }
      }
    }),
  );

  if (!unavailable.length) {
    return {
      name: fullName,
      hash,
      handle,
      version: pkg.version,
      dependencies: peerDependencies,
    };
  }

  logger.info(
    { ...logMetadata, unavailable },
    `package is not cached for ${unavailable.join(', ')}`,
  );

  const dir = `${config.tmpdir}/${buildStatusRedisId}`;
  await mkdir(dir);

  logger.info(logMetadata, `setting key to pending in redis`);
  const isAlreadySet = await new Promise((resolve, reject) => {
    client
      .multi()
      .hsetnx(buildStatusRedisId, 'type', 'pending')
      .expire(buildStatusRedisId, EXPIRATION_SECONDS)
      .exec((err, replies) => {
        if (err) {
          reject(err);
        } else {
          resolve(replies[0] === 0);
        }
      });
  });
  if (isAlreadySet && !rebuild) {
    logger.info(logMetadata, `bundling is already in progress, waiting`);
    return { name: fullName, version, pending: true };
  }

  try {
    logger.info(logMetadata, `fetching package`);
    await fetchAndExtract(pkg, version, dir);

    const cwd = `${dir}/${findPath(pkg.name, dir)}`;
    logger.info(logMetadata, `installing package at ${cwd}`);
    await installPackage(cwd);

    logger.info(logMetadata, 'packaging bundle');
    const files = await packageBundle({
      pkg,
      cwd,
      deep,
      externalDependencies: peerDependencies,
      base: `${config.cloudfront.url}/${encodeURIComponent(handle)}`,
      platforms: unavailable,
      sdkVersion,
    });

    if (process.env.DEBUG_LOCAL_FILES) {
      logger.info(logMetadata, 'writing files to disk');

      await Promise.all(
        Object.keys(files).map(async (platform) => {
          const dir = path.join(config.tmpdir, 'output', `${handle}-${platform}`);

          await Promise.all(
            Object.keys(files[platform]).map(async (file) => {
              const filename = path.join(dir, file);

              await mkdir(path.dirname(filename));
              await writeFile(filename, files[platform][file]);
            }),
          );

          await writeFile(path.join(dir, '.done'), '');
        }),
      );
    } else {
      logger.info(logMetadata, 'uploading files');
      await Promise.all(
        Object.keys(files).map(async (platform) => {
          const promises: Promise<any>[] = Object.keys(files[platform]).map((file, i, arr) => {
            logger.info(
              {
                ...logMetadata,
                file,
                platform,
                current: i + 1,
                total: arr.length,
              },
              `uploading artifact for platform: ${platform}`,
            );
            return uploadFile(`${handle}-${platform}/${file}`, files[platform][file]);
          });

          if (latestHandle) {
            logger.info(logMetadata, `adding latest link: ${latestHandle}-${platform}`);
            promises.push(
              addS3Redirect(
                `${latestHandle}-${platform}/bundle.js`,
                `${handle}-${platform}/bundle.js`,
              ),
              addS3Redirect(`${latestHandle}-${platform}/.done`, `${handle}-${platform}/.done`),
            );
          }

          await Promise.all(promises);

          logger.info(
            { ...logMetadata, platform, hash },
            `marking platform as complete: ${platform}`,
          );
          const doneS3Key = `${handle}-${platform}/.done`;
          logger.info({ ...logMetadata, platform, generatedHandle: handle, finalS3KeyForDoneWrite: doneS3Key, bucket: config.s3.bucket }, `CREATING .done file on S3. Generated handle: ${handle}, Final S3 Key for .done: ${doneS3Key}`);
          await s3
            .putObject({
              Bucket: config.s3.bucket,
              Key: doneS3Key,
              Body: '',
            })
            .promise();
          logger.info({ ...logMetadata, platform, bucket: config.s3.bucket, key: doneS3Key }, `Created .done file on S3-compatible storage`);

          if (latestHandle) {
            client.set(latestCompletedVersionRedisId, version);
          }

          logger.info(
            { ...logMetadata, platform },
            `finished uploading artifacts for platform: ${platform}`,
          );
        }),
      );
    }

    logger.info(logMetadata, `marking id as finished`);
    const finishedStatus: { [key: string]: string } = {
      type: 'finished',
      hash: hash,
      handle: handle,
      version: pkg.version,
    };
    client.multi()
      .hmset(buildStatusRedisId, finishedStatus)
      .expire(buildStatusRedisId, EXPIRATION_SECONDS)
      .exec((err, _replies) => {
        if (err) {
          logger.error({ ...logMetadata, error: err }, 'Error marking bundle as finished in Redis');
        } else {
          logger.info({ ...logMetadata }, 'Successfully marked bundle as finished in Redis');
        }
      });
  } catch (error: any) {
    logger.error(
      { ...logMetadata, error, stack: error?.stack },
      `UNABLE TO BUNDLE (this is the main catch block). Error: ${error?.message}`,
    );
    client
      .multi()
      .hmset(buildStatusRedisId, { type: 'error', message: error.message })
      .expire(buildStatusRedisId, 60 * 5)
      .exec();
    if (config.sentry) {
      raven.captureException(error);
    }
  } finally {
    if (!process.env.DEBUG_LOCAL_FILES) {
      rimraf(dir);
    }
  }

  logger.info(logMetadata, `done! cleaning up`);
  return { name: fullName, version: pkg.version, pending: true };
}
