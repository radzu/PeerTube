/* eslint-disable @typescript-eslint/no-unused-expressions,@typescript-eslint/require-await */

import 'mocha'
import * as chai from 'chai'
import { HttpStatusCode, VideoFile } from '@shared/models'
import {
  areObjectStorageTestsDisabled,
  cleanupTests,
  createMultipleServers,
  doubleFollow,
  expectStartWith,
  makeRawRequest,
  ObjectStorageCommand,
  PeerTubeServer,
  setAccessTokensToServers,
  waitJobs
} from '../../../shared/extra-utils'

const expect = chai.expect

async function checkFilesInObjectStorage (files: VideoFile[], type: 'webtorrent' | 'playlist') {
  for (const file of files) {
    const shouldStartWith = type === 'webtorrent'
      ? ObjectStorageCommand.getWebTorrentBaseUrl()
      : ObjectStorageCommand.getPlaylistBaseUrl()

    expectStartWith(file.fileUrl, shouldStartWith)

    await makeRawRequest(file.fileUrl, HttpStatusCode.OK_200)
  }
}

function runTests (objectStorage: boolean) {
  let servers: PeerTubeServer[] = []
  const videosUUID: string[] = []

  before(async function () {
    this.timeout(60000)

    const config = objectStorage
      ? ObjectStorageCommand.getDefaultConfig()
      : {}

    // Run server 2 to have transcoding enabled
    servers = await createMultipleServers(2, config)
    await setAccessTokensToServers(servers)

    await servers[0].config.disableTranscoding()

    await doubleFollow(servers[0], servers[1])

    if (objectStorage) await ObjectStorageCommand.prepareDefaultBuckets()

    for (let i = 1; i <= 5; i++) {
      const { uuid, shortUUID } = await servers[0].videos.upload({ attributes: { name: 'video' + i } })

      if (i > 2) {
        videosUUID.push(uuid)
      } else {
        videosUUID.push(shortUUID)
      }
    }

    await waitJobs(servers)
  })

  it('Should have two video files on each server', async function () {
    this.timeout(30000)

    for (const server of servers) {
      const { data } = await server.videos.list()
      expect(data).to.have.lengthOf(videosUUID.length)

      for (const video of data) {
        const videoDetail = await server.videos.get({ id: video.uuid })
        expect(videoDetail.files).to.have.lengthOf(1)
        expect(videoDetail.streamingPlaylists).to.have.lengthOf(0)
      }
    }
  })

  it('Should run a transcoding job on video 2', async function () {
    this.timeout(60000)

    await servers[0].cli.execWithEnv(`npm run create-transcoding-job -- -v ${videosUUID[1]}`)
    await waitJobs(servers)

    for (const server of servers) {
      const { data } = await server.videos.list()

      let infoHashes: { [id: number]: string }

      for (const video of data) {
        const videoDetails = await server.videos.get({ id: video.uuid })

        if (video.shortUUID === videosUUID[1] || video.uuid === videosUUID[1]) {
          expect(videoDetails.files).to.have.lengthOf(4)
          expect(videoDetails.streamingPlaylists).to.have.lengthOf(0)

          if (objectStorage) await checkFilesInObjectStorage(videoDetails.files, 'webtorrent')

          if (!infoHashes) {
            infoHashes = {}

            for (const file of videoDetails.files) {
              infoHashes[file.resolution.id.toString()] = file.magnetUri
            }
          } else {
            for (const resolution of Object.keys(infoHashes)) {
              const file = videoDetails.files.find(f => f.resolution.id.toString() === resolution)
              expect(file.magnetUri).to.equal(infoHashes[resolution])
            }
          }
        } else {
          expect(videoDetails.files).to.have.lengthOf(1)
          expect(videoDetails.streamingPlaylists).to.have.lengthOf(0)
        }
      }
    }
  })

  it('Should run a transcoding job on video 1 with resolution', async function () {
    this.timeout(60000)

    await servers[0].cli.execWithEnv(`npm run create-transcoding-job -- -v ${videosUUID[0]} -r 480`)

    await waitJobs(servers)

    for (const server of servers) {
      const { data } = await server.videos.list()
      expect(data).to.have.lengthOf(videosUUID.length)

      const videoDetails = await server.videos.get({ id: videosUUID[0] })

      expect(videoDetails.files).to.have.lengthOf(2)
      expect(videoDetails.files[0].resolution.id).to.equal(720)
      expect(videoDetails.files[1].resolution.id).to.equal(480)

      expect(videoDetails.streamingPlaylists).to.have.lengthOf(0)

      if (objectStorage) await checkFilesInObjectStorage(videoDetails.files, 'webtorrent')
    }
  })

  it('Should generate an HLS resolution', async function () {
    this.timeout(120000)

    await servers[0].cli.execWithEnv(`npm run create-transcoding-job -- -v ${videosUUID[2]} --generate-hls -r 480`)

    await waitJobs(servers)

    for (const server of servers) {
      const videoDetails = await server.videos.get({ id: videosUUID[2] })

      expect(videoDetails.files).to.have.lengthOf(1)
      if (objectStorage) await checkFilesInObjectStorage(videoDetails.files, 'webtorrent')

      expect(videoDetails.streamingPlaylists).to.have.lengthOf(1)

      const files = videoDetails.streamingPlaylists[0].files
      expect(files).to.have.lengthOf(1)
      expect(files[0].resolution.id).to.equal(480)

      if (objectStorage) await checkFilesInObjectStorage(files, 'playlist')
    }
  })

  it('Should not duplicate an HLS resolution', async function () {
    this.timeout(120000)

    await servers[0].cli.execWithEnv(`npm run create-transcoding-job -- -v ${videosUUID[2]} --generate-hls -r 480`)

    await waitJobs(servers)

    for (const server of servers) {
      const videoDetails = await server.videos.get({ id: videosUUID[2] })

      const files = videoDetails.streamingPlaylists[0].files
      expect(files).to.have.lengthOf(1)
      expect(files[0].resolution.id).to.equal(480)

      if (objectStorage) await checkFilesInObjectStorage(files, 'playlist')
    }
  })

  it('Should generate all HLS resolutions', async function () {
    this.timeout(120000)

    await servers[0].cli.execWithEnv(`npm run create-transcoding-job -- -v ${videosUUID[3]} --generate-hls`)

    await waitJobs(servers)

    for (const server of servers) {
      const videoDetails = await server.videos.get({ id: videosUUID[3] })

      expect(videoDetails.files).to.have.lengthOf(1)
      expect(videoDetails.streamingPlaylists).to.have.lengthOf(1)

      const files = videoDetails.streamingPlaylists[0].files
      expect(files).to.have.lengthOf(4)

      if (objectStorage) await checkFilesInObjectStorage(files, 'playlist')
    }
  })

  it('Should optimize the video file and generate HLS videos if enabled in config', async function () {
    this.timeout(120000)

    await servers[0].config.enableTranscoding()
    await servers[0].cli.execWithEnv(`npm run create-transcoding-job -- -v ${videosUUID[4]}`)

    await waitJobs(servers)

    for (const server of servers) {
      const videoDetails = await server.videos.get({ id: videosUUID[4] })

      expect(videoDetails.files).to.have.lengthOf(4)
      expect(videoDetails.streamingPlaylists).to.have.lengthOf(1)
      expect(videoDetails.streamingPlaylists[0].files).to.have.lengthOf(4)

      if (objectStorage) {
        await checkFilesInObjectStorage(videoDetails.files, 'webtorrent')
        await checkFilesInObjectStorage(videoDetails.streamingPlaylists[0].files, 'playlist')
      }
    }
  })

  after(async function () {
    await cleanupTests(servers)
  })
}

describe('Test create transcoding jobs', function () {

  describe('On filesystem', function () {
    runTests(false)
  })

  describe('On object storage', function () {
    if (areObjectStorageTestsDisabled()) return

    runTests(true)
  })
})
