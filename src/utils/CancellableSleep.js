import noop from './noop';

export const SLEEP_CANCELLED = 'SLEEP_CANCELLED';

export default class CancellableSleep {
  constructor(timeout) {
    this._timeout = timeout;
    this._cancelled = false;
    this._sleepOnCancel = noop;
  }

  wait() {
    return new Promise((resolve, reject) => {
      // cancel() may have been called before wait() — e.g. while the fetches
      // that precede the sleep were still in flight.
      if (this._cancelled) {
        reject(SLEEP_CANCELLED);
        return;
      }
      if (this._timeout <= 0) {
        resolve();
        return;
      }
      const sleepTimeout = setTimeout(resolve, this._timeout);
      this._sleepOnCancel = () => {
        reject(SLEEP_CANCELLED);
        clearTimeout(sleepTimeout);
      };
    });
  }

  cancel() {
    this._cancelled = true;
    this._sleepOnCancel();
  }
}
