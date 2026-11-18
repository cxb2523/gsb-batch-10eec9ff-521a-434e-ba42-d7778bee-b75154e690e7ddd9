/**
 * One save of a board: seal the scene under the right key and upload it, following the server's
 * instructions when the project key rotated underneath the editor. React-free so the sequence of
 * keys, versions and retries can be read in one place.
 */

import { sealBoardPayload } from '@/lib/crypto-format';
import { ApiError } from '@/lib/http';
import { saveBoardPayload } from './api';
import {
  provisionCurrentBoardKey,
  resolveSealingBoardKey,
  type BoardKeyContext,
} from './board-keys';
import type { BoardMetadata } from './board-metadata';

/** Rotation can happen twice in a row at most before the caller backs off. */
const MAX_SEAL_CYCLES = 3;

/**
 * What a re-key attempt needs to finish the save if its payload upload never lands: the key the
 * images were encrypted under, and where the board stood when that happened.
 */
interface RekeyMaterial {
  /** The board's key version the files were re-encrypted from. */
  boardKeyVersion: number;
  /** The project key version the files, the wrapped key and the sealed payload use. */
  keyVersion: number;
  key: CryptoKey;
  /** The board key wrapped under the project key, as the re-key save must send it. */
  encryptedBoardKey: string;
  /** The canvas files already copied at `keyVersion`; a canvas with other files needs them too. */
  fileIds: readonly string[] | undefined;
}

/**
 * A re-key whose files were encrypted and uploaded but whose payload was never stored.
 *
 * The files are already on the server under `keyVersion`, so only the key that encrypted them and
 * the payload sealed with it are needed to finish the save. Keeping them lets the next save send
 * the same bytes instead of generating a new board key and encrypting every image again.
 */
interface PendingRekey extends RekeyMaterial {
  workspaceRef: string;
  boardId: string;
  /** The payload sealed for `revision`. */
  ciphertext: Uint8Array;
  revision: number;
  /** The scene inside `ciphertext`, so an edited canvas is sealed again rather than reused. */
  sceneJson: string;
}

/**
 * The result of the last re-key that did not land. There is one save in flight per board at a
 * time, so one slot is enough, and it is only ever reused while it still matches the board's and
 * the project's key versions.
 */
let pendingRekey: PendingRekey | null = null;

/**
 * Drops the retained re-key. A save that lands, or a board or project that moved on, clears it on
 * its own. The editor also calls this when it opens a board again, so nothing retained for the
 * previous visit outlives it, and each test starts as a fresh page would.
 */
export function clearPendingRekey(): void {
  pendingRekey = null;
}

/** True when the failed attempt already put a copy of every file this save will send on the server. */
function coversFileIds(pending: PendingRekey, fileIds: readonly string[] | undefined): boolean {
  // A save that names no files is not pruning or adding any, so the uploaded copies still stand.
  if (fileIds === undefined) return true;
  if (pending.fileIds === undefined) return fileIds.length === 0;
  if (pending.fileIds.length !== fileIds.length) return false;
  const covered = new Set(pending.fileIds);
  return fileIds.every((fileId) => covered.has(fileId));
}

/**
 * Takes the retained re-key if it belongs to this board and key version; drops it otherwise. A
 * board that moved to another version (or gained a public link) invalidates it, because its files
 * were encrypted for the old version and must be encrypted again.
 */
function takePendingRekey(params: SealedSaveParams, board: BoardMetadata): PendingRekey | null {
  const pending = pendingRekey;
  if (!pending) return null;

  const usable =
    pending.workspaceRef === params.workspaceRef &&
    pending.boardId === params.boardId &&
    pending.boardKeyVersion === board.keyVersion &&
    pending.keyVersion === board.project.keyVersion &&
    board.keyVersion < board.project.keyVersion &&
    !board.publicShareToken;
  if (!usable) pendingRekey = null;
  return usable ? pending : null;
}

export interface SealedSaveParams {
  workspaceRef: string;
  boardId: string;
  /** The scene to store, encrypted before it leaves this module. */
  scene: unknown;
  keyContext: BoardKeyContext;
  /** The key and version the editor currently holds for this board. */
  key: CryptoKey | null;
  keyVersion: number;
  /** The current revision before this save (new payload sealed at revision + 1). */
  revision?: number | undefined;
  /** Active file IDs in the scene to prune unreferenced files on the server. */
  fileIds?: string[] | undefined;
  /** The latest metadata, read again for every cycle because a refresh can change it. */
  readBoard: () => BoardMetadata | null;
  /**
   * Uploads every file of the scene encrypted under the new key and version, before a re-key
   * payload is sent. Returns false when a file is not available to re-encrypt, in which case the
   * board keeps its current key and the re-key is tried again on a later save.
   */
  reencryptFiles: (key: CryptoKey, keyVersion: number) => Promise<boolean>;
  /** Re-reads the board after the server says its key rotated. */
  refreshBoard: () => Promise<void>;
  /** Receives each ciphertext as soon as it exists, so a failed upload can still be stashed. */
  onSealed: (ciphertext: Uint8Array) => void;
}

export interface SealedSaveResult {
  /** The HTTP status of the final upload; 0 when the request never reached the server. */
  status: number;
  code?: string | undefined;
  message?: string | undefined;
  /** The key and version the stored payload was sealed under. */
  key: CryptoKey;
  keyVersion: number;
  revision?: number | undefined;
}

async function upload(
  workspaceRef: string,
  boardId: string,
  ciphertext: Uint8Array,
  options: {
    encryptedBoardKey?: string | undefined;
    revision: number;
    fileIds?: string[] | undefined;
  },
): Promise<{
  status: number;
  code?: string | undefined;
  revision?: number | undefined;
  message?: string | undefined;
}> {
  try {
    const res = await saveBoardPayload(workspaceRef, boardId, ciphertext, options);
    return { status: 200, revision: res.revision };
  } catch (err) {
    if (err instanceof ApiError) {
      let conflictRev: number | undefined;
      if (typeof err.details === 'object' && err.details !== null && 'revision' in err.details) {
        conflictRev = Number(err.details.revision);
      }
      return {
        status: err.status,
        code: err.code,
        revision: conflictRev,
        message: err.message,
      };
    }
    return { status: 0 };
  }
}

/**
 * Whether a refused upload may still succeed later with the same bytes: the connection failed,
 * the server had a problem, or it answered with a conflict that a re-seal can resolve.
 */
function worthRetaining(status: number): boolean {
  return status === 0 || status === 409 || status === 429 || status >= 500;
}

/**
 * Seals and uploads the scene. Returns null when the cycles ran out or the board is unknown;
 * key errors from `lib/keys` propagate.
 */
export async function sealAndSaveBoard(params: SealedSaveParams): Promise<SealedSaveResult | null> {
  const { workspaceRef, boardId, keyContext } = params;
  let key = params.key;
  let keyVersion = params.keyVersion;
  let allowRekey = true;

  const clearThisBoardsPendingRekey = () => {
    if (pendingRekey?.workspaceRef === workspaceRef && pendingRekey.boardId === boardId) {
      pendingRekey = null;
    }
  };

  const attempt = async (cycle: number): Promise<SealedSaveResult | null> => {
    if (cycle >= MAX_SEAL_CYCLES) return null;
    const board = params.readBoard();
    if (!board) return null;

    // A board behind its project's key is moved to the current one, unless a public link
    // already carries the old key in its URL.
    const rekey =
      allowRekey && board.keyVersion < board.project.keyVersion && !board.publicShareToken;
    if (!rekey) clearThisBoardsPendingRekey();

    // A retained re-key is only usable while the board and its project still stand where they
    // did when the files were encrypted; anything else means the stored copies are junk.
    const retained = rekey ? takePendingRekey(params, board) : null;
    const targetRevision = (params.revision ?? 0) + 1;
    const sceneJson = rekey ? JSON.stringify(params.scene) : '';

    // The re-key material this attempt sends, kept if the upload never lands.
    let rekeyInfo: RekeyMaterial | null = null;

    if (rekey) {
      if (retained) {
        // The images are already on the server at this version, encrypted under this key.
        key = retained.key;
        keyVersion = retained.keyVersion;
        rekeyInfo = {
          boardKeyVersion: board.keyVersion,
          key: retained.key,
          keyVersion: retained.keyVersion,
          encryptedBoardKey: retained.encryptedBoardKey,
          fileIds: params.fileIds,
        };

        // A canvas that gained images since the failed attempt still needs those encrypted.
        if (!coversFileIds(retained, params.fileIds)) {
          if (!(await params.reencryptFiles(retained.key, retained.keyVersion))) {
            allowRekey = false;
            clearThisBoardsPendingRekey();
            return attempt(cycle + 1);
          }
        }
      } else {
        const provisioned = await provisionCurrentBoardKey(board, keyContext);
        if (!(await params.reencryptFiles(provisioned.boardKey, board.project.keyVersion))) {
          allowRekey = false;
          clearThisBoardsPendingRekey();
          return attempt(cycle + 1);
        }
        key = provisioned.boardKey;
        keyVersion = board.project.keyVersion;
        rekeyInfo = {
          boardKeyVersion: board.keyVersion,
          key: provisioned.boardKey,
          keyVersion: board.project.keyVersion,
          encryptedBoardKey: provisioned.encryptedBoardKey,
          fileIds: params.fileIds,
        };
      }
    } else if (!key || keyVersion !== board.keyVersion) {
      key = await resolveSealingBoardKey(board, keyContext);
      keyVersion = board.keyVersion;
    }
    if (!key) return null;

    // The sealed payload from the failed attempt is only reusable for the same scene at the
    // same revision; otherwise it is sealed again with the retained key, never the images.
    const ciphertext =
      retained?.sceneJson === sceneJson && retained.revision === targetRevision
        ? retained.ciphertext
        : await sealBoardPayload(key, params.scene, {
            boardId,
            keyVersion,
            revision: targetRevision,
          });
    params.onSealed(ciphertext);

    const {
      status,
      code,
      message,
      revision: savedRevision,
    } = await upload(workspaceRef, boardId, ciphertext, {
      encryptedBoardKey: rekeyInfo?.encryptedBoardKey,
      revision: params.revision ?? 0,
      fileIds: params.fileIds,
    });

    if (status >= 200 && status < 300) {
      clearThisBoardsPendingRekey();
      return { status, code, message, key, keyVersion, revision: savedRevision ?? targetRevision };
    }

    // A network failure, a server error, a rate limit or a conflict a re-seal can resolve leaves
    // the uploaded images and this ciphertext worth keeping: the next save sends them again
    // instead of encrypting the images a second time. The version check at the next attempt drops
    // it when the board has moved on, so retaining it is only ever an opportunity to reuse.
    if (rekeyInfo) {
      // The slot only ever holds the latest failed save, never an older, smaller file set.
      if (worthRetaining(status)) {
        pendingRekey = {
          workspaceRef,
          boardId,
          ...rekeyInfo,
          ciphertext,
          revision: targetRevision,
          sceneJson,
        };
      } else {
        // A refusal that will not change (a revoked role, a full disk, a bad request) is not kept.
        clearThisBoardsPendingRekey();
      }
    }

    if (status === 409 && code === 'KEY_ROTATED') {
      await params.refreshBoard();
      key = null;
      return attempt(cycle + 1);
    }
    if (status === 409 && code === 'PUBLIC_BOARD_REKEY') {
      // The re-key itself was refused; nothing of it may be reused.
      clearThisBoardsPendingRekey();
      allowRekey = false;
      return attempt(cycle + 1);
    }

    return { status, code, message, key, keyVersion, revision: savedRevision ?? targetRevision };
  };

  return attempt(0);
}
