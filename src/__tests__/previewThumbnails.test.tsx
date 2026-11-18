import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { VideoSeekSlider, Props } from '..';

const TRACK_WIDTH = 100;

const getWrapper = (overrides: Partial<Props> = {}): any => (
  <VideoSeekSlider
    max={100000}
    currentTime={0}
    onChange={() => undefined}
    {...overrides}
  />
);

const getTrack = (): HTMLElement => screen.getByTestId('main-track');

const hover = (clientX: number): void => {
  fireEvent.pointerMove(getTrack(), { clientX });
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

const defer = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
};

const VTT_URL = '/media/thumbs.vtt';
const OTHER_VTT_URL = '/media/other.vtt';
const ABS_VTT_URL = 'http://localhost:3000/media/thumbs.vtt';

/** Builds a one cue VTT response; an empty payload yields no cues at all. */
const vtt = (image: string): Response =>
  new Response(`WEBVTT\n\n00:00:00.000 --> 00:01:40.000\n${image}\n`);

const A_SHEET = 'a-sheet.jpg#xywh=160,0,160,90';
const B_SHEET = 'b-sheet.jpg#xywh=0,0,160,90';

const previewScreen = (): HTMLElement | null =>
  screen.queryByTestId('preview-screen');

/** Background image of the rendered preview, whether plain or a sprite frame. */
const previewImage = (): HTMLElement | null => {
  const preview = previewScreen();

  if (!preview) {
    return null;
  }

  return preview.classList.contains('sprite')
    ? (preview.firstElementChild as HTMLElement)
    : preview;
};

const spriteUrl = (): string | undefined =>
  previewImage()?.style.backgroundImage;

describe('preview thumbnails sources', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(
      TRACK_WIDTH
    );
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      width: TRACK_WIDTH,
    } as DOMRect);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('failures fall back to getPreviewScreenUrl', () => {
    const expectFallback = async (
      fetchImplementation: () => Promise<Response>
    ): Promise<void> => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const getPreviewScreenUrl = vi.fn(() => 'fallback.jpg');

      vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImplementation);

      render(
        getWrapper({
          previewThumbnails: VTT_URL,
          getPreviewScreenUrl,
          timeCodes: [
            { fromMs: 0, description: 'Intro' },
            { fromMs: 50000, description: 'Main part' },
          ],
        })
      );

      await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
      hover(60);

      expect(getPreviewScreenUrl).toHaveBeenCalledWith(60000);
      expect(spriteUrl()).toBe('url("fallback.jpg")');
      // Time and chapter label stay visible regardless of the image source.
      expect(screen.getByTestId('hover-time')).toHaveTextContent('Main part');
      expect(screen.getByTestId('hover-time')).toHaveTextContent('01:00');
    };

    it('falls back on a network error', async () => {
      await expectFallback(() => Promise.reject(new TypeError('network down')));
    });

    it('falls back on a non-2xx response', async () => {
      await expectFallback(() =>
        Promise.resolve(new Response('missing', { status: 404 }))
      );
    });

    it('falls back on an empty VTT file', async () => {
      await expectFallback(() => Promise.resolve(vtt('')));
    });

    it('shows time and labels without an image when there is no callback', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(vtt(''));

      render(
        getWrapper({
          previewThumbnails: VTT_URL,
          timeCodes: [{ fromMs: 0, description: 'Intro' }],
        })
      );

      await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
      hover(30);

      const hoverTime = screen.getByTestId('hover-time');

      expect(previewScreen()).not.toBeInTheDocument();
      expect(hoverTime).toHaveTextContent('Intro');
      expect(hoverTime).toHaveTextContent('00:30');
    });
  });

  describe('switching the VTT url', () => {
    it('uses the fallback while the url is still loading', async () => {
      const pending = defer<Response>();
      vi.spyOn(globalThis, 'fetch').mockImplementation(() => pending.promise);

      const getPreviewScreenUrl = (): string => 'fallback.jpg';

      render(
        getWrapper({
          previewThumbnails: VTT_URL,
          getPreviewScreenUrl,
        })
      );

      hover(30);

      expect(spriteUrl()).toBe('url("fallback.jpg")');

      pending.resolve(vtt(A_SHEET));

      await waitFor(() => expect(spriteUrl()).toContain('a-sheet.jpg'));
    });

    it('a late response from a previous url cannot replace the active one', async () => {
      const a = defer<Response>();
      const b = defer<Response>();
      vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
        String(input) === ABS_VTT_URL ? a.promise : b.promise
      );

      const { rerender } = render(getWrapper({ previewThumbnails: VTT_URL }));

      hover(30);
      expect(previewScreen()).not.toBeInTheDocument();

      rerender(getWrapper({ previewThumbnails: OTHER_VTT_URL }));
      b.resolve(vtt(B_SHEET));

      const preview = await screen.findByTestId('preview-screen');

      expect(preview).toHaveClass('sprite');
      expect(spriteUrl()).toContain('b-sheet.jpg');

      // Source A resolves after B already rendered: it must neither replace
      // B's frames nor blank the preview.
      await act(async () => {
        a.resolve(vtt(A_SHEET));
        await Promise.resolve();
        await Promise.resolve();
      });

      hover(60);
      expect(spriteUrl()).toContain('b-sheet.jpg');
      expect(spriteUrl()).not.toContain('a-sheet.jpg');
    });

    it('ignores a late response while the active url is still loading', async () => {
      const a = defer<Response>();
      const b = defer<Response>();
      vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
        String(input) === ABS_VTT_URL ? a.promise : b.promise
      );

      const getPreviewScreenUrl = (): string => 'fallback.jpg';
      const { rerender } = render(
        getWrapper({ previewThumbnails: VTT_URL, getPreviewScreenUrl })
      );

      rerender(
        getWrapper({ previewThumbnails: OTHER_VTT_URL, getPreviewScreenUrl })
      );

      await act(async () => {
        a.resolve(vtt(A_SHEET));
        await Promise.resolve();
        await Promise.resolve();
      });

      hover(30);
      expect(previewScreen()).toBeInTheDocument();
      expect(spriteUrl()).toBe('url("fallback.jpg")');

      b.resolve(vtt(B_SHEET));

      await waitFor(() => expect(spriteUrl()).toContain('b-sheet.jpg'));
      expect(spriteUrl()).not.toContain('a-sheet.jpg');
    });

    it('does not flash previous frames while the next url is loading', async () => {
      const b = defer<Response>();
      vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
        String(input) === ABS_VTT_URL
          ? Promise.resolve(vtt(A_SHEET))
          : b.promise
      );

      const { rerender } = render(getWrapper({ previewThumbnails: VTT_URL }));

      hover(30);

      const first = await screen.findByTestId('preview-screen');

      expect(first.firstElementChild).toHaveStyle({
        backgroundPosition: '-160px 0px',
      });

      rerender(getWrapper({ previewThumbnails: OTHER_VTT_URL }));

      // The next source is still loading: the hover must not resurrect the
      // frames of the previous source.
      hover(60);
      expect(previewScreen()).not.toBeInTheDocument();

      b.resolve(vtt(B_SHEET));

      const next = await screen.findByTestId('preview-screen');

      expect(next).toHaveClass('sprite');
      expect(spriteUrl()).toContain('b-sheet.jpg');
      expect(next.firstElementChild).toHaveStyle({
        backgroundPosition: '0px 0px',
      });
    });

    it('reuses an already loaded url without refetching it', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(() => Promise.resolve(vtt(A_SHEET)));

      const { rerender } = render(getWrapper({ previewThumbnails: VTT_URL }));

      hover(30);
      await screen.findByTestId('preview-screen');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      rerender(getWrapper({ previewThumbnails: OTHER_VTT_URL }));
      hover(30);
      await screen.findByTestId('preview-screen');
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Switching back shows the cached thumbnails on the same render, with no
      // extra request and no blank frame.
      rerender(getWrapper({ previewThumbnails: VTT_URL }));
      hover(30);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(spriteUrl()).toContain('a-sheet.jpg');
    });

    it('keeps the fallback after a failed url, then recovers on a good one', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
        String(input) === ABS_VTT_URL
          ? Promise.resolve(new Response('nope', { status: 500 }))
          : Promise.resolve(vtt(B_SHEET))
      );

      const getPreviewScreenUrl = (): string => 'fallback.jpg';
      const { rerender } = render(
        getWrapper({ previewThumbnails: VTT_URL, getPreviewScreenUrl })
      );

      hover(30);
      await waitFor(() => expect(spriteUrl()).toBe('url("fallback.jpg")'));

      rerender(
        getWrapper({
          previewThumbnails: OTHER_VTT_URL,
          getPreviewScreenUrl,
        })
      );

      await waitFor(() => expect(spriteUrl()).toContain('b-sheet.jpg'));

      const preview = previewScreen() as HTMLElement;

      expect(preview).toHaveClass('sprite');
      expect(preview.firstElementChild).toHaveStyle({
        backgroundPosition: '0px 0px',
      });
    });
  });
});
