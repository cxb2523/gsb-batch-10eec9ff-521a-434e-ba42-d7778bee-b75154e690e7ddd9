import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Player from 'video.js/dist/types/player';

import { setTextTracks, validateRemoteTextTrackOptions } from '../subtitles';
import {
    MockPlayer,
    MockTextTrack,
    MockVTTCue,
    FetchController,
    deferredRoute,
    fileRoute,
    httpErrorRoute,
    settleAsync,
    type MockHTMLTrackElement,
} from './mock-player';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const samplesDir = process.env.IK_SUBTITLE_SAMPLES_DIR
    ?? join(dirname(fileURLToPath(import.meta.url)), 'samples');
const sample = (name: string): string => readFileSync(join(samplesDir, name), 'utf8');

const SOURCE_A = 'https://ik.example.com/video-a/ik-master.m3u8';
const SOURCE_B = 'https://ik.example.com/video-b/ik-master.m3u8';

const autoTrackWithTranslations = (translations: Array<{ langCode: string; default?: boolean }>, baseDefault = false) => ({
    autoGenerate: true as const,
    default: baseDefault,
    translations,
});

const findTrack = (player: MockPlayer, srclang: string): MockTextTrack | undefined =>
    player.remoteTextTracks().find(track => track.language === srclang);

const findTrackEl = (player: MockPlayer, srclang: string): MockHTMLTrackElement | undefined =>
    player.remoteTextTrackEls().find(el => el.track.language === srclang);

const showingTracks = (player: MockPlayer): MockTextTrack[] =>
    player.remoteTextTracks().filter(track =>
        (track.kind === 'subtitles' || track.kind === 'captions') && track.mode === 'showing');

// The mock reproduces the video.js player surface used here but cannot
// implement the full structural Player type; cast at the boundary only.
const asPlayer = (player: MockPlayer): Player => player as unknown as Player;

let controller: FetchController;
let originalFetch: typeof fetch;
let originalVTTCue: unknown;

beforeEach(() => {
    controller = new FetchController();
    originalFetch = globalThis.fetch;
    originalVTTCue = (globalThis as { VTTCue?: unknown }).VTTCue;
    globalThis.fetch = controller.build() as typeof fetch;
    (globalThis as { VTTCue: unknown }).VTTCue = MockVTTCue;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalVTTCue === undefined) {
        delete (globalThis as { VTTCue?: unknown }).VTTCue;
    } else {
        (globalThis as { VTTCue: unknown }).VTTCue = originalVTTCue;
    }
});

// ---------------------------------------------------------------------------
// Scenario 1: source switch - a translation track of the OLD source resolves
// after the new source has been configured. Its late response must be a no-op.
// ---------------------------------------------------------------------------
test('stale translation track of the previous source cannot mutate the player after a source switch', async () => {
    // Source A: French VTT is deliberately delayed; German resolves immediately.
    controller.addRoute(fileRoute('a-transcript', url => url.includes('/video-a/ik-gensubtitle.transcript'), sample('source-a.transcript')));
    controller.addRoute(deferredRoute(
        'a-fr-delayed',
        url => url.includes('/video-a/ik-gensubtitle.vtt') && url.includes('lang-fr'),
        async () => ({ ok: true, status: 200, text: async () => sample('source-a-fr.vtt') }),
    ));
    controller.addRoute(fileRoute('a-de', url => url.includes('/video-a/ik-gensubtitle.vtt') && url.includes('lang-de'), sample('source-a-de.vtt')));

    // Source B: everything resolves immediately.
    controller.addRoute(fileRoute('b-transcript', url => url.includes('/video-b/ik-gensubtitle.transcript'), sample('source-b.transcript')));
    controller.addRoute(fileRoute('b-fr', url => url.includes('/video-b/ik-gensubtitle.vtt') && url.includes('lang-fr'), sample('source-b-fr.vtt')));
    controller.addRoute(fileRoute('b-de', url => url.includes('/video-b/ik-gensubtitle.vtt') && url.includes('lang-de'), sample('source-b-de.vtt')));

    // A signer keeps exercising the existing URL-signing code path.
    const signedUrls: string[] = [];
    const signerFn = async (src: string): Promise<string> => {
        const signed = `${src}${src.includes('?') ? '&' : '?'}signed=1`;
        signedUrls.push(signed);
        return signed;
    };

    const player = new MockPlayer();

    // --- Configure source A (French is the default translation) ---
    await setTextTracks(
        asPlayer(player),
        [autoTrackWithTranslations([{ langCode: 'fr', default: true }, { langCode: 'de' }])],
        { src: SOURCE_A } as never,
        signerFn,
    );
    await settleAsync(20);

    assert.equal(controller.callsFor('a-fr-delayed'), 1, 'the old French VTT request must have been started');
    const staleFrenchTrack = findTrack(player, 'fr');
    assert.ok(staleFrenchTrack, 'source A French track exists before the switch');
    assert.equal(staleFrenchTrack!.cues.length, 0, 'pending French track has no cues yet');
    assert.equal(staleFrenchTrack!.mode, 'disabled', 'pending French track stays disabled while loading');
    const staleFrenchLabel = staleFrenchTrack!.label;
    const staleGermanTrack = findTrack(player, 'de');
    assert.ok(staleGermanTrack && staleGermanTrack.cues.length > 0, 'source A German track loaded in the meantime');

    // --- Switch to source B before source A French VTT returns ---
    await setTextTracks(
        asPlayer(player),
        [autoTrackWithTranslations([{ langCode: 'fr', default: true }, { langCode: 'de' }])],
        { src: SOURCE_B } as never,
        signerFn,
    );
    await settleAsync(20);

    // All source A tracks were removed; only source B tracks remain.
    assert.ok(!player.remoteTextTracks().includes(staleFrenchTrack!), 'stale French track removed from the player');
    assert.ok(!player.remoteTextTracks().includes(staleGermanTrack!), 'stale German track removed from the player');
    assert.equal(player.remoteTextTracks().length, 3, 'source B creates a fresh base + 2 translation tracks');

    const newFrenchTrack = findTrack(player, 'fr')!;
    assert.equal(newFrenchTrack.mode, 'showing', 'source B default French track takes the default selection');
    assert.ok(newFrenchTrack.cues.some(cue => cue.text.includes('bravo')), 'source B French cues come from the NEW VTT, not the old one');
    assert.equal(showingTracks(player).length, 1, 'exactly one subtitle track is showing after the switch');

    // --- Now the OLD source A French VTT finally comes back ---
    controller.flushPending();
    await settleAsync(20);

    assert.deepEqual(staleFrenchTrack!.cues, [], 'late old response must not add any cue');
    assert.equal(staleFrenchTrack!.mode, 'disabled', 'late old response must not change the stale track mode');
    assert.equal(staleFrenchTrack!.label, staleFrenchLabel, 'late old response must not change the stale track label');
    assert.ok(!player.remoteTextTracks().includes(staleFrenchTrack!), 'stale track is never re-added to the player');

    assert.equal(findTrack(player, 'fr')!.mode, 'showing', 'new source default track remains showing');
    assert.equal(showingTracks(player).length, 1, 'still exactly one subtitle track showing after the stale response');
    assert.ok(
        signedUrls.some(url => url.includes('/video-a/') && url.includes('signed=1')),
        'source A URLs were still signed (signing behavior preserved)',
    );
    assert.ok(
        signedUrls.some(url => url.includes('/video-b/') && url.includes('signed=1')),
        'source B URLs were still signed (signing behavior preserved)',
    );
});

// ---------------------------------------------------------------------------
// Scenario 2: one translation track fails to fetch. It must be marked failed
// and stay disabled without affecting the other tracks or default selection.
// ---------------------------------------------------------------------------
test('a failed translation track is marked failed and stays disabled; base default selection is untouched', async () => {
    controller.addRoute(fileRoute('transcript', url => url.includes('ik-gensubtitle.transcript'), sample('source-a.transcript')));
    controller.addRoute(httpErrorRoute('fr-fails', url => url.includes('lang-fr'), 500));
    controller.addRoute(fileRoute('de-ok', url => url.includes('lang-de'), sample('source-a-de.vtt')));

    const player = new MockPlayer();

    // Base auto-generated track itself is the default here.
    await setTextTracks(
        asPlayer(player),
        [autoTrackWithTranslations([{ langCode: 'fr' }, { langCode: 'de' }], true)],
        { src: SOURCE_A } as never,
    );
    await settleAsync(20);

    const baseTrack = findTrack(player, 'en')!;
    const failedFrench = findTrack(player, 'fr')!;
    const german = findTrack(player, 'de')!;
    const failedFrenchEl = findTrackEl(player, 'fr')!;

    assert.equal(failedFrench.mode, 'disabled', 'failed translation track stays disabled');
    assert.equal(failedFrench.cues.length, 0, 'failed translation track gets no cues');
    assert.ok(failedFrenchEl.label.includes('(failed to load)'), 'failure is visible in the track menu label');
    assert.ok(failedFrench.label.includes('(failed to load)'), 'failure is visible on the TextTrack label too');

    assert.equal(baseTrack.mode, 'showing', 'base auto-generated track keeps its default showing selection');
    assert.ok(baseTrack.cues.length > 0, 'base track cues were generated from the transcript');
    assert.equal(german.mode, 'disabled', 'other translation track keeps its non-default mode');
    assert.ok(german.cues.some(cue => cue.text.includes('Hallo')), 'other translation track still loaded its own VTT');
    assert.equal(showingTracks(player).length, 1, 'failure does not produce a second showing track');
    assert.ok(player.logs.some(log => log.level === 'error' && log.message.includes('fr')), 'failure is logged');
});

test('a failed DEFAULT translation track never forces itself showing and does not flip other tracks', async () => {
    controller.addRoute(fileRoute('transcript', url => url.includes('ik-gensubtitle.transcript'), sample('source-a.transcript')));
    controller.addRoute(httpErrorRoute('fr-fails', url => url.includes('lang-fr'), 500));
    controller.addRoute(fileRoute('de-ok', url => url.includes('lang-de'), sample('source-a-de.vtt')));

    const player = new MockPlayer();

    // French translation is configured as the default but its fetch fails.
    await setTextTracks(
        asPlayer(player),
        [autoTrackWithTranslations([{ langCode: 'fr', default: true }, { langCode: 'de' }])],
        { src: SOURCE_A } as never,
    );
    await settleAsync(20);

    const failedFrench = findTrack(player, 'fr')!;
    const baseTrack = findTrack(player, 'en')!;
    const german = findTrack(player, 'de')!;

    assert.equal(failedFrench.mode, 'disabled', 'failed default track must not become showing');
    assert.ok(failedFrench.label.includes('(failed to load)'), 'failed default track is marked failed');
    assert.equal(baseTrack.mode, 'hidden', 'non-default base track keeps its hidden mode - it is not force-shown');
    assert.equal(german.mode, 'disabled', 'sibling translation keeps its mode');
    assert.ok(german.cues.length > 0, 'sibling translation finished loading despite the failure');
    assert.ok(showingTracks(player).length <= 1, 'at most one subtitle track is showing');
});

// ---------------------------------------------------------------------------
// Scenario 3: default translation track loads successfully and is shown.
// ---------------------------------------------------------------------------
test('a successfully loaded default translation track is shown and remains the sole showing track', async () => {
    controller.addRoute(fileRoute('transcript', url => url.includes('ik-gensubtitle.transcript'), sample('source-a.transcript')));
    controller.addRoute(fileRoute('fr-ok', url => url.includes('lang-fr'), sample('source-a-fr.vtt')));
    controller.addRoute(fileRoute('de-ok', url => url.includes('lang-de'), sample('source-a-de.vtt')));

    const player = new MockPlayer();

    await setTextTracks(
        asPlayer(player),
        [autoTrackWithTranslations([{ langCode: 'fr', default: true }, { langCode: 'de' }])],
        { src: SOURCE_A } as never,
    );
    await settleAsync(20);

    const french = findTrack(player, 'fr')!;
    const german = findTrack(player, 'de')!;
    const baseTrack = findTrack(player, 'en')!;

    assert.equal(french.mode, 'showing', 'default translation track is showing');
    assert.ok(french.cues.some(cue => cue.text.includes('Bonjour')), 'French track received the French VTT cues (order preserved)');
    assert.ok(!french.label.includes('failed'), 'successful track keeps its normal label');
    assert.equal(german.mode, 'disabled', 'non-default translation stays disabled');
    assert.ok(german.cues.some(cue => cue.text.includes('Hallo')), 'German track received the German VTT cues (order preserved)');
    // The winning default translation disables every other subtitle track via
    // the module's existing disableOtherTracks() behavior; it must not be showing.
    assert.notEqual(baseTrack.mode, 'showing', 'base auto-generated track is not showing');
    assert.equal(showingTracks(player).length, 1, 'exactly one subtitle/caption track is showing in the batch');
});

// ---------------------------------------------------------------------------
// Regression guards: validation, signing and regular VTT cleanup stay intact.
// ---------------------------------------------------------------------------
test('existing validation still rejects multiple default tracks', () => {
    assert.throws(
        () => validateRemoteTextTrackOptions({
            autoGenerate: true,
            translations: [{ langCode: 'fr', default: true }, { langCode: 'de', default: true }],
        }),
        /only one entry can have `default`/,
    );
});

test('regular VTT source tracks are still created and are removed on the next setTextTracks call', async () => {
    controller.addRoute(fileRoute('plain-vtt', () => true, 'WEBVTT\n\n00:00.000 --> 00:01.000\nplain'));

    const player = new MockPlayer();
    const signerFn = async (src: string): Promise<string> => `${src}?signed=1`;

    await setTextTracks(
        asPlayer(player),
        [{ src: 'https://example.com/subs/english.vtt', srclang: 'en', label: 'English', default: true }],
        { src: SOURCE_A } as never,
        signerFn,
    );
    await settleAsync(5);

    assert.equal(player.remoteTextTracks().length, 1);
    const plainTrackEl = player.remoteTextTrackEls()[0];
    assert.equal(plainTrackEl.srclang, 'en');
    assert.ok(plainTrackEl.src.includes('signed=1'), 'regular VTT URL is signed as before');

    await setTextTracks(
        asPlayer(player),
        [autoTrackWithTranslations([{ langCode: 'fr' }])],
        { src: SOURCE_B } as never,
    );
    await settleAsync(5);

    assert.ok(!player.remoteTextTrackEls().includes(plainTrackEl), 'previous regular VTT track is invalidated on re-configuration');
});
