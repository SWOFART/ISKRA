import { describe, expect, it, vi } from 'vitest';
import { PhotoCaptureSession, type PhotoCaptureRuntime } from '../../../src/client/PhotoCapture';

function jpeg(size = 32): Blob {
  return new Blob([new Uint8Array(size)], { type: 'image/jpeg' });
}

function cameraHarness() {
  const stopped: number[] = [];
  const revoked: string[] = [];
  const constraints: MediaStreamConstraints[] = [];
  let streamId = 0;
  let objectId = 0;
  const runtime: PhotoCaptureRuntime = {
    mediaDevices: {
      getUserMedia: vi.fn(async (request) => {
        constraints.push(request);
        const id = ++streamId;
        return {
          getTracks: () => [{ stop: () => { stopped.push(id); } }],
        } as unknown as MediaStream;
      }),
    },
    createObjectURL: vi.fn((_blob) => `blob:capture-${streamId}-${++objectId}`),
    revokeObjectURL: vi.fn((url) => { revoked.push(url); }),
  };
  return { runtime, stopped, revoked, constraints };
}

describe('camera-only photo capture session', () => {
  it('reports unsupported camera access without offering another media source', async () => {
    const session = new PhotoCaptureSession({ mediaDevices: null });
    await session.requestCamera();

    expect(session.phase).toBe('error');
    expect(session.failure).toBe('unsupported');
    expect(session.stream).toBeNull();
    expect(session.photos).toHaveLength(0);
    expect(session.canContinue).toBe(false);
  });

  it('turns permission denial into a retryable state and requests rear camera without audio', async () => {
    const harness = cameraHarness();
    let allowed = false;
    harness.runtime.mediaDevices = {
      getUserMedia: vi.fn(async (request) => {
        harness.constraints.push(request);
        if (!allowed) throw Object.assign(new Error('blocked'), { name: 'NotAllowedError' });
        return {
          getTracks: () => [{ stop: () => harness.stopped.push(1) }],
        } as unknown as MediaStream;
      }),
    };
    const session = new PhotoCaptureSession(harness.runtime);
    await session.requestCamera();
    expect(session.failure).toBe('permission');

    allowed = true;
    await session.requestCamera();
    expect(session.phase).toBe('ready');
    expect(harness.constraints[0]).toEqual({ audio: false, video: { facingMode: { ideal: 'environment' } } });
  });

  it('rejects zero and six photos, accepts one or five, and stops the stream on continue', async () => {
    const onePhoto = cameraHarness();
    const single = new PhotoCaptureSession(onePhoto.runtime);
    await single.requestCamera();
    expect(single.canContinue).toBe(false);
    expect(single.continueWithPhotos()).toBeNull();
    expect(single.addPhoto(jpeg())).toBe(true);
    expect(single.canContinue).toBe(true);
    expect(single.continueWithPhotos()).toHaveLength(1);
    expect(onePhoto.stopped).toEqual([1]);

    const fivePhotos = cameraHarness();
    const multiple = new PhotoCaptureSession(fivePhotos.runtime);
    await multiple.requestCamera();
    for (let count = 0; count < 5; count += 1) expect(multiple.addPhoto(jpeg())).toBe(true);
    expect(multiple.photos).toHaveLength(5);
    expect(multiple.canCapture).toBe(false);
    expect(multiple.addPhoto(jpeg())).toBe(false);
    expect(multiple.photos).toHaveLength(5);
    expect(multiple.continueWithPhotos()).toHaveLength(5);
    expect(fivePhotos.stopped).toEqual([1]);
  });

  it('keeps photos when the resident continues creating and discards them only on explicit exit', async () => {
    const harness = cameraHarness();
    const session = new PhotoCaptureSession(harness.runtime);
    await session.requestCamera();
    expect(session.addPhoto(jpeg())).toBe(true);
    const previewUrl = session.photos[0].previewUrl;

    session.requestExit();
    expect(session.exitConfirmation).toBe(true);
    session.continueCreating();
    expect(session.exitConfirmation).toBe(false);
    expect(session.photos).toHaveLength(1);
    expect(session.stream).not.toBeNull();

    session.requestExit();
    session.discardAndExit();
    expect(session.phase).toBe('closed');
    expect(session.photos).toHaveLength(0);
    expect(session.stream).toBeNull();
    expect(harness.stopped).toEqual([1]);
    expect(harness.revoked).toEqual([previewUrl]);

    session.reopen();
    await session.requestCamera();
    expect(session.photos).toHaveLength(0);
    expect(session.phase).toBe('ready');
    session.discardAndExit();
    expect(harness.stopped).toEqual([1, 2]);
  });

  it('revokes deleted previews and stops a stream that resolves after exit', async () => {
    const harness = cameraHarness();
    const session = new PhotoCaptureSession(harness.runtime);
    await session.requestCamera();
    expect(session.addPhoto(jpeg())).toBe(true);
    const removed = session.photos[0];
    expect(session.removePhoto(removed.id)).toBe(true);
    expect(harness.revoked).toEqual([removed.previewUrl]);

    let resolveStream!: (stream: MediaStream) => void;
    harness.runtime.mediaDevices = {
      getUserMedia: vi.fn(() => new Promise<MediaStream>((resolve) => { resolveStream = resolve; })),
    };
    session.stopCamera();
    const request = session.requestCamera();
    session.discardAndExit();
    resolveStream({ getTracks: () => [{ stop: () => harness.stopped.push(99) }] } as unknown as MediaStream);
    await request;
    expect(harness.stopped).toContain(99);
  });

  it('stops the camera and revokes previews on idempotent disposal', async () => {
    const harness = cameraHarness();
    const session = new PhotoCaptureSession(harness.runtime);
    await session.requestCamera();
    expect(session.addPhoto(jpeg())).toBe(true);
    const previewUrl = session.photos[0].previewUrl;

    session.dispose();
    session.dispose();

    expect(session.phase).toBe('closed');
    expect(session.photos).toHaveLength(0);
    expect(session.stream).toBeNull();
    expect(harness.stopped).toEqual([1]);
    expect(harness.revoked).toEqual([previewUrl]);
  });
});
