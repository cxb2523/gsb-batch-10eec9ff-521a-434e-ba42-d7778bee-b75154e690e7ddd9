import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateSymmetricKey } from '@/lib/crypto';
import { ApiError } from '@/lib/http';
import { saveBoardPayload } from './api';
import { provisionCurrentBoardKey, resolveSealingBoardKey } from './board-keys';
import type { BoardMetadata } from './board-metadata';
import { sealAndSaveBoard, clearPendingRekey, type SealedSaveParams } from './board-save';

vi.mock('./api', () => ({ saveBoardPayload: vi.fn() }));
vi.mock('./board-keys', () => ({
  provisionCurrentBoardKey: vi.fn(),
  resolveSealingBoardKey: vi.fn(),
}));

const board = (overrides: Partial<BoardMetadata> = {}, projectKeyVersion = 1): BoardMetadata => ({
  id: 'b1',
  title: 'Mesh',
  projectId: 'p1',
  keyVersion: 1,
  publicShareToken: null,
  updatedAt: '',
  project: { id: 'p1', name: 'Core', organizationId: 'w1', keyVersion: projectKeyVersion },
  ...overrides,
});

const rejection = (status: number, code?: string) =>
  new ApiError({ status, code, message: 'refused' });

describe('sealAndSaveBoard', () => {
  let key: CryptoKey;
  let params: SealedSaveParams;
  let current: BoardMetadata | null;

  beforeEach(async () => {
    vi.resetAllMocks();
    clearPendingRekey();
    key = await generateSymmetricKey();
    current = board();
    params = {
      workspaceRef: 'acme',
      boardId: 'b1',
      scene: { elements: [] },
      keyContext: { privateKey: null, userId: 'u1', workspaceRef: 'acme' },
      key,
      keyVersion: 1,
      reencryptFiles: vi.fn(async () => true),
      readBoard: () => current,
      refreshBoard: vi.fn(async () => {}),
      onSealed: vi.fn(),
    };
    vi.mocked(saveBoardPayload).mockResolvedValue({
      success: true,
      hasPayload: true,
      revision: 1,
      updatedAt: '',
    });
  });

  it('uploads under the key the editor already holds', async () => {
    const result = await sealAndSaveBoard(params);

    expect(result).toMatchObject({ status: 200, key, keyVersion: 1 });
    expect(saveBoardPayload).toHaveBeenCalledWith(
      'acme',
      'b1',
      expect.any(Uint8Array),
      expect.objectContaining({ revision: 0 }),
    );
    expect(resolveSealingBoardKey).not.toHaveBeenCalled();
  });

  it('hands every ciphertext to the caller before the upload, so a failure can be stashed', async () => {
    vi.mocked(saveBoardPayload).mockRejectedValue(rejection(500));

    const result = await sealAndSaveBoard(params);

    expect(result?.status).toBe(500);
    expect(params.onSealed).toHaveBeenCalledTimes(1);
    expect(vi.mocked(params.onSealed).mock.calls[0]?.[0][0]).toBe(0x01);
  });

  it('reports a request that never reached the server as status 0', async () => {
    vi.mocked(saveBoardPayload).mockRejectedValue(new TypeError('Failed to fetch'));

    expect(await sealAndSaveBoard(params)).toMatchObject({ status: 0 });
  });

  it('moves a board behind its project key to the current key and sends the new wrapped key', async () => {
    const newKey = await generateSymmetricKey();
    current = board({}, 2);
    vi.mocked(provisionCurrentBoardKey).mockResolvedValue({
      boardKey: newKey,
      encryptedBoardKey: 'wrapped-v2',
    });

    const result = await sealAndSaveBoard(params);

    expect(result).toMatchObject({ status: 200, key: newKey, keyVersion: 2 });
    expect(saveBoardPayload).toHaveBeenCalledWith(
      'acme',
      'b1',
      expect.any(Uint8Array),
      expect.objectContaining({ encryptedBoardKey: 'wrapped-v2' }),
    );
  });

  it('uploads the files under the new key before the re-key payload', async () => {
    const newKey = await generateSymmetricKey();
    current = board({}, 2);
    vi.mocked(provisionCurrentBoardKey).mockResolvedValue({
      boardKey: newKey,
      encryptedBoardKey: 'wrapped-v2',
    });
    const order: string[] = [];
    vi.mocked(params.reencryptFiles).mockImplementation(async () => {
      order.push('files');
      return true;
    });
    vi.mocked(saveBoardPayload).mockImplementation(async () => {
      order.push('payload');
      return { success: true, hasPayload: true, revision: 1, updatedAt: '' };
    });

    await sealAndSaveBoard(params);

    expect(params.reencryptFiles).toHaveBeenCalledWith(newKey, 2);
    expect(order).toEqual(['files', 'payload']);
  });

  it('keeps the current key when a file cannot be re-encrypted', async () => {
    current = board({}, 2);
    vi.mocked(provisionCurrentBoardKey).mockResolvedValue({
      boardKey: await generateSymmetricKey(),
      encryptedBoardKey: 'wrapped-v2',
    });
    vi.mocked(params.reencryptFiles).mockResolvedValue(false);

    const result = await sealAndSaveBoard(params);

    expect(result).toMatchObject({ status: 200, keyVersion: 1 });
    expect(saveBoardPayload).toHaveBeenCalledWith(
      'acme',
      'b1',
      expect.any(Uint8Array),
      expect.not.objectContaining({ encryptedBoardKey: expect.anything() }),
    );
  });

  it('does not re-key a board that has a public link', async () => {
    current = board({ publicShareToken: 'tok' }, 2);

    const result = await sealAndSaveBoard(params);

    expect(provisionCurrentBoardKey).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 200, keyVersion: 1 });
  });

  it('refreshes the board and seals again when the server says the key rotated', async () => {
    const reopened = await generateSymmetricKey();
    vi.mocked(saveBoardPayload)
      .mockRejectedValueOnce(rejection(409, 'KEY_ROTATED'))
      .mockResolvedValueOnce({
        success: true,
        hasPayload: true,
        revision: 1,
        updatedAt: '',
      });
    vi.mocked(resolveSealingBoardKey).mockResolvedValue(reopened);
    vi.mocked(params.refreshBoard).mockImplementation(async () => {
      current = board({ keyVersion: 2 }, 2);
    });

    const result = await sealAndSaveBoard(params);

    expect(params.refreshBoard).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 200, key: reopened, keyVersion: 2 });
    expect(saveBoardPayload).toHaveBeenCalledTimes(2);
  });

  it('stops re-keying when the server says a public link holds the old key', async () => {
    current = board({}, 2);
    vi.mocked(provisionCurrentBoardKey).mockResolvedValue({
      boardKey: await generateSymmetricKey(),
      encryptedBoardKey: 'wrapped-v2',
    });
    // Back to the board's own key version, as the server asked.
    vi.mocked(resolveSealingBoardKey).mockResolvedValue(key);
    vi.mocked(saveBoardPayload)
      .mockRejectedValueOnce(rejection(409, 'PUBLIC_BOARD_REKEY'))
      .mockResolvedValueOnce({
        success: true,
        hasPayload: true,
        revision: 1,
        updatedAt: '',
      });

    const result = await sealAndSaveBoard(params);

    expect(provisionCurrentBoardKey).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 200, keyVersion: 1 });
  });

  it('gives up after three rotations in a row', async () => {
    vi.mocked(saveBoardPayload).mockRejectedValue(rejection(409, 'KEY_ROTATED'));
    vi.mocked(resolveSealingBoardKey).mockResolvedValue(key);

    expect(await sealAndSaveBoard(params)).toBeNull();
    expect(saveBoardPayload).toHaveBeenCalledTimes(3);
  });

  it('does nothing when the board is not known', async () => {
    current = null;

    expect(await sealAndSaveBoard(params)).toBeNull();
    expect(saveBoardPayload).not.toHaveBeenCalled();
  });

  it('lets key errors from the key service reach the caller', async () => {
    current = board({}, 2);
    vi.mocked(provisionCurrentBoardKey).mockRejectedValue(new Error('no project key'));

    await expect(sealAndSaveBoard(params)).rejects.toThrow('no project key');
    expect(saveBoardPayload).not.toHaveBeenCalled();
  });

  describe('retaining a re-key whose upload failed', () => {
    let newKey: CryptoKey;

    beforeEach(async () => {
      newKey = await generateSymmetricKey();
      current = board({}, 2);
      vi.mocked(provisionCurrentBoardKey).mockResolvedValue({
        boardKey: newKey,
        encryptedBoardKey: 'wrapped-v2',
      });
      params.fileIds = ['file-1'];
    });

    /** The payload bytes of the n-th upload, so two attempts can be compared. */
    const uploadedPayload = (call: number): Uint8Array => {
      const payload = vi.mocked(saveBoardPayload).mock.calls[call]?.[2];
      if (!(payload instanceof Uint8Array)) throw new Error('expected a Uint8Array payload');
      return payload;
    };

    it('reuses the encrypted images and sealed payload after a failed upload', async () => {
      vi.mocked(saveBoardPayload)
        .mockRejectedValueOnce(rejection(500))
        .mockResolvedValueOnce({ success: true, hasPayload: true, revision: 1, updatedAt: '' });

      const first = await sealAndSaveBoard(params);
      expect(first).toMatchObject({ status: 500, keyVersion: 2 });

      const second = await sealAndSaveBoard(params);

      expect(second).toMatchObject({ status: 200, key: newKey, keyVersion: 2 });
      expect(provisionCurrentBoardKey).toHaveBeenCalledTimes(1);
      expect(params.reencryptFiles).toHaveBeenCalledTimes(1);
      expect(uploadedPayload(1)).toEqual(uploadedPayload(0));
      expect(saveBoardPayload).toHaveBeenLastCalledWith(
        'acme',
        'b1',
        expect.any(Uint8Array),
        expect.objectContaining({ encryptedBoardKey: 'wrapped-v2' }),
      );
    });

    it('reuses them after a network error that never reached the server', async () => {
      vi.mocked(saveBoardPayload)
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce({ success: true, hasPayload: true, revision: 1, updatedAt: '' });

      expect(await sealAndSaveBoard(params)).toMatchObject({ status: 0 });
      expect(await sealAndSaveBoard(params)).toMatchObject({ status: 200 });

      expect(provisionCurrentBoardKey).toHaveBeenCalledTimes(1);
      expect(params.reencryptFiles).toHaveBeenCalledTimes(1);
      expect(uploadedPayload(1)).toEqual(uploadedPayload(0));
    });

    it('keeps the encrypted images when the rotation cycles run out', async () => {
      vi.mocked(saveBoardPayload).mockRejectedValue(rejection(409, 'KEY_ROTATED'));
      vi.mocked(resolveSealingBoardKey).mockResolvedValue(key);
      // The refresh keeps reporting the same versions, so every cycle asks the server again and
      // the save finally gives up without ever storing the payload.
      expect(await sealAndSaveBoard(params)).toBeNull();

      // The project is still ahead of the board on the next save, so the retained key and
      // ciphertext finish the re-key without encrypting the image again.
      current = board({}, 2);
      vi.mocked(provisionCurrentBoardKey).mockResolvedValue({
        boardKey: newKey,
        encryptedBoardKey: 'wrapped-v2',
      });
      vi.mocked(saveBoardPayload).mockResolvedValueOnce({
        success: true,
        hasPayload: true,
        revision: 1,
        updatedAt: '',
      });

      expect(await sealAndSaveBoard(params)).toMatchObject({ status: 200, keyVersion: 2 });
      expect(provisionCurrentBoardKey).toHaveBeenCalledTimes(1);
      expect(params.reencryptFiles).toHaveBeenCalledTimes(1);
    });

    it('seals an edited canvas again without encrypting the images a second time', async () => {
      vi.mocked(saveBoardPayload)
        .mockRejectedValueOnce(rejection(500))
        .mockResolvedValueOnce({ success: true, hasPayload: true, revision: 1, updatedAt: '' });
      await sealAndSaveBoard(params);

      params.scene = { elements: [{ id: 'rect-1' }] };
      const second = await sealAndSaveBoard(params);

      expect(second).toMatchObject({ status: 200, key: newKey, keyVersion: 2 });
      expect(params.reencryptFiles).toHaveBeenCalledTimes(1);
      expect(uploadedPayload(1)).not.toEqual(uploadedPayload(0));
      expect(saveBoardPayload).toHaveBeenLastCalledWith(
        'acme',
        'b1',
        expect.any(Uint8Array),
        expect.objectContaining({ encryptedBoardKey: 'wrapped-v2' }),
      );
    });

    it('encrypts images that appeared after the failed attempt and keeps the rest', async () => {
      vi.mocked(saveBoardPayload)
        .mockRejectedValueOnce(rejection(500))
        .mockResolvedValueOnce({ success: true, hasPayload: true, revision: 1, updatedAt: '' });
      await sealAndSaveBoard(params);

      params.fileIds = ['file-1', 'file-2'];
      expect(await sealAndSaveBoard(params)).toMatchObject({ status: 200 });

      expect(params.reencryptFiles).toHaveBeenCalledTimes(2);
      expect(params.reencryptFiles).toHaveBeenLastCalledWith(newKey, 2);
      expect(provisionCurrentBoardKey).toHaveBeenCalledTimes(1);
    });

    it('drops the retained re-key when the board key version changed before the retry', async () => {
      vi.mocked(saveBoardPayload)
        .mockRejectedValueOnce(rejection(500))
        .mockResolvedValueOnce({ success: true, hasPayload: true, revision: 1, updatedAt: '' });
      await sealAndSaveBoard(params);

      // Another save moved the board to version 2 while the project went on to version 3.
      const nextKey = await generateSymmetricKey();
      current = board({ keyVersion: 2 }, 3);
      vi.mocked(provisionCurrentBoardKey).mockResolvedValue({
        boardKey: nextKey,
        encryptedBoardKey: 'wrapped-v3',
      });

      const result = await sealAndSaveBoard(params);

      expect(result).toMatchObject({ status: 200, key: nextKey, keyVersion: 3 });
      expect(provisionCurrentBoardKey).toHaveBeenCalledTimes(2);
      expect(params.reencryptFiles).toHaveBeenCalledTimes(2);
      expect(params.reencryptFiles).toHaveBeenLastCalledWith(nextKey, 3);
      expect(uploadedPayload(1)).not.toEqual(uploadedPayload(0));
    });

    it('drops the retained re-key when only the project key version moved on', async () => {
      vi.mocked(saveBoardPayload)
        .mockRejectedValueOnce(rejection(500))
        .mockResolvedValueOnce({ success: true, hasPayload: true, revision: 1, updatedAt: '' });
      await sealAndSaveBoard(params);

      // The project rotated again before the board could be moved to version 2.
      const nextKey = await generateSymmetricKey();
      current = board({}, 3);
      vi.mocked(provisionCurrentBoardKey).mockResolvedValue({
        boardKey: nextKey,
        encryptedBoardKey: 'wrapped-v3',
      });

      const result = await sealAndSaveBoard(params);

      expect(result).toMatchObject({ status: 200, key: nextKey, keyVersion: 3 });
      expect(provisionCurrentBoardKey).toHaveBeenCalledTimes(2);
      expect(params.reencryptFiles).toHaveBeenCalledTimes(2);
      expect(params.reencryptFiles).toHaveBeenLastCalledWith(nextKey, 3);
      expect(saveBoardPayload).toHaveBeenLastCalledWith(
        'acme',
        'b1',
        expect.any(Uint8Array),
        expect.objectContaining({ encryptedBoardKey: 'wrapped-v3' }),
      );
    });

    it('drops the retained re-key once the board has a public link', async () => {
      vi.mocked(saveBoardPayload)
        .mockRejectedValueOnce(rejection(500))
        .mockResolvedValueOnce({ success: true, hasPayload: true, revision: 1, updatedAt: '' });
      await sealAndSaveBoard(params);

      current = board({ publicShareToken: 'tok' }, 2);
      const result = await sealAndSaveBoard(params);

      // The public link keeps the board on its own key; its files must not be moved underneath it.
      expect(result).toMatchObject({ status: 200, keyVersion: 1 });
      expect(provisionCurrentBoardKey).toHaveBeenCalledTimes(1);
      expect(params.reencryptFiles).toHaveBeenCalledTimes(1);
      expect(saveBoardPayload).toHaveBeenLastCalledWith(
        'acme',
        'b1',
        expect.any(Uint8Array),
        expect.not.objectContaining({ encryptedBoardKey: expect.anything() }),
      );
    });

    it('drops the retained re-key when the save that failed is superseded', async () => {
      vi.mocked(saveBoardPayload)
        .mockRejectedValueOnce(rejection(500))
        .mockRejectedValueOnce(rejection(500))
        .mockResolvedValueOnce({ success: true, hasPayload: true, revision: 1, updatedAt: '' });
      await sealAndSaveBoard(params);

      // A second failure replaces the first result rather than stacking beside it.
      params.fileIds = ['file-1', 'file-2'];
      await sealAndSaveBoard(params);
      expect(params.reencryptFiles).toHaveBeenCalledTimes(2);

      // The retry reuses the latest result: both images are already uploaded at the new version.
      expect(await sealAndSaveBoard(params)).toMatchObject({ status: 200 });
      expect(params.reencryptFiles).toHaveBeenCalledTimes(2);
      expect(provisionCurrentBoardKey).toHaveBeenCalledTimes(1);
    });

    it('clears the retained re-key after a successful save', async () => {
      vi.mocked(saveBoardPayload)
        .mockRejectedValueOnce(rejection(500))
        .mockResolvedValue({ success: true, hasPayload: true, revision: 1, updatedAt: '' });
      await sealAndSaveBoard(params);
      expect(await sealAndSaveBoard(params)).toMatchObject({ status: 200 });
      expect(provisionCurrentBoardKey).toHaveBeenCalledTimes(1);
      expect(params.reencryptFiles).toHaveBeenCalledTimes(1);

      // The board record still looks due for the re-key, as it would if the cached copy had not
      // caught up with the save. What is already stored must not be sent a second time.
      expect(await sealAndSaveBoard(params)).toMatchObject({ status: 200 });

      expect(provisionCurrentBoardKey).toHaveBeenCalledTimes(2);
      expect(params.reencryptFiles).toHaveBeenCalledTimes(2);
    });

    it('retains nothing when a refusal will not change on a retry', async () => {
      vi.mocked(saveBoardPayload).mockRejectedValueOnce(rejection(413));
      expect(await sealAndSaveBoard(params)).toMatchObject({ status: 413 });

      // The next save builds the re-key again rather than replaying bytes the server refused.
      vi.mocked(saveBoardPayload).mockResolvedValueOnce({
        success: true,
        hasPayload: true,
        revision: 1,
        updatedAt: '',
      });
      expect(await sealAndSaveBoard(params)).toMatchObject({ status: 200 });

      expect(params.reencryptFiles).toHaveBeenCalledTimes(2);
      expect(provisionCurrentBoardKey).toHaveBeenCalledTimes(2);
    });

    it('retains nothing when a file cannot be re-encrypted', async () => {
      vi.mocked(params.reencryptFiles).mockResolvedValue(false);
      vi.mocked(saveBoardPayload).mockRejectedValueOnce(rejection(500));

      const first = await sealAndSaveBoard(params);

      expect(first).toMatchObject({ status: 500, keyVersion: 1 });
      expect(saveBoardPayload).toHaveBeenCalledWith(
        'acme',
        'b1',
        expect.any(Uint8Array),
        expect.not.objectContaining({ encryptedBoardKey: expect.anything() }),
      );

      // Every save tries the re-encryption again from scratch; the old-key ciphertext is not
      // mistaken for a finished re-key.
      vi.mocked(params.reencryptFiles).mockResolvedValue(true);
      vi.mocked(saveBoardPayload).mockResolvedValueOnce({
        success: true,
        hasPayload: true,
        revision: 1,
        updatedAt: '',
      });

      expect(await sealAndSaveBoard(params)).toMatchObject({ status: 200, keyVersion: 2 });
      expect(params.reencryptFiles).toHaveBeenCalledTimes(2);
      expect(provisionCurrentBoardKey).toHaveBeenCalledTimes(2);
    });
  });
});
