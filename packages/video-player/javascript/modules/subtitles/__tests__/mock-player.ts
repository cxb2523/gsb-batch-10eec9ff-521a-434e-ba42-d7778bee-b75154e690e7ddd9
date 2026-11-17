/**
 * Minimal, video.js-accurate test doubles for the parts of the player used by
 * the subtitles module.
 *
 * The real video.js TextTrack/HTMLTrackElement classes require a full DOM and
 * cannot be instantiated in plain Node, so these mocks reproduce the exact
 * semantics the module relies on:
 *  - TextTrack.mode is a live getter/setter (defaults to 'disabled')
 *  - TextTrack.default is stored per track and stays immutable
 *  - addCue appends to an inspectable cues array
 *  - HTMLTrackElement.track returns the paired TextTrack
 *  - addRemoteTextTrack / removeRemoteTextTrack keep both remote lists in sync
 *  - textTracks() mirrors remoteTextTracks(), like video.js's player
 */

export interface MockCue {
    startTime: number;
    endTime: number;
    text: string;
}

export class MockVTTCue implements MockCue {
    startTime: number;
    endTime: number;
    text: string;

    constructor(startTime: number, endTime: number, text: string) {
        this.startTime = startTime;
        this.endTime = endTime;
        this.text = text;
    }

    getCueAsHTML(): unknown {
        return { textContent: this.text };
    }
}

export class MockTextTrack {
    private static nextId = 0;

    kind: string;
    label: string;
    language: string;
    readonly default: boolean;
    cues: MockCue[] = [];
    activeCues: MockCue[] = [];
    id: string;
    modeChanges: Array<string> = [];

    private mode_: string = 'disabled';

    constructor(options: {
        kind?: string;
        label?: string;
        srclang?: string;
        language?: string;
        default?: boolean;
        id?: string;
    }) {
        this.kind = options.kind || 'subtitles';
        this.label = options.label || '';
        this.language = options.language || options.srclang || '';
        this.default = options.default ?? false;
        this.id = options.id || `mock-track-${MockTextTrack.nextId++}`;
    }
    get mode(): string {
        return this.mode_;
    }

    set mode(value: string) {
        if (this.mode_ !== value) {
            this.modeChanges.push(value);
        }
        this.mode_ = value;
    }

    addCue(cue: MockCue): void {
        this.cues.push(cue);
    }

    removeCue(cue: MockCue): void {
        const idx = this.cues.indexOf(cue);
        if (idx !== -1) {
            this.cues.splice(idx, 1);
        }
    }
}

export class MockHTMLTrackElement {
    kind: string;
    src: string;
    srclang: string;
    label: string;
    default: boolean;
    track: MockTextTrack;
    readyState: number = 0;

    constructor(options: {
        kind?: string;
        src?: string;
        srclang?: string;
        label?: string;
        default?: boolean;
    }) {
        this.kind = options.kind || 'subtitles';
        this.src = options.src || '';
        this.srclang = options.srclang || '';
        this.label = options.label || '';
        this.default = options.default ?? false;
        this.track = new MockTextTrack({
            kind: this.kind,
            label: this.label,
            srclang: this.srclang,
            default: this.default,
        });
    }
}

export interface LoggedMessage {
    level: 'warn' | 'error';
    message: string;
}

export class MockPlayer {
    readyStateValue: number = 1; // HAVE_METADATA, so initWhenReady runs immediately
    logs: LoggedMessage[] = [];
    controlBar = {
        getChild: (_name: string) => ({
            update(): void { /* no-op */ },
        }),
    };

    private remoteTrackEls_: MockHTMLTrackElement[] = [];
    private remoteTracks_: MockTextTrack[] = [];
    private readyListeners_: Array<() => void> = [];

    log = {
        warn: (message: string): void => {
            this.logs.push({ level: 'warn', message });
        },
        error: (message: string): void => {
            this.logs.push({ level: 'error', message });
        },
    };

    localize(token: string, tokens?: string[]): string {
        return token.replace(/\{(\d+)\}/g, (_match, index) => tokens?.[Number(index) - 1] ?? token);
    }

    readyState(): number {
        return this.readyStateValue;
    }

    one(_event: string, handler: () => void): void {
        this.readyListeners_.push(handler);
    }

    on(): void { /* no-op */ }
    off(): void { /* no-op */ }
    trigger(): void { /* no-op */ }

    isDisposed(): boolean {
        return false;
    }

    id(): string {
        return 'mock-player';
    }

    addRemoteTextTrack(
        options: { kind?: string; src?: string; srclang?: string; label?: string; default?: boolean },
        _manualCleanup?: boolean
    ): MockHTMLTrackElement {
        const el = new MockHTMLTrackElement(options);
        this.remoteTrackEls_.push(el);
        this.remoteTracks_.push(el.track);
        return el;
    }

    removeRemoteTextTrack(track: MockTextTrack): void {
        const elIndex = this.remoteTrackEls_.findIndex(el => el.track === track);
        if (elIndex !== -1) {
            this.remoteTrackEls_.splice(elIndex, 1);
        }
        const trackIndex = this.remoteTracks_.indexOf(track);
        if (trackIndex !== -1) {
            this.remoteTracks_.splice(trackIndex, 1);
        }
    }

    remoteTextTracks(): MockTextTrack[] {
        return this.remoteTracks_;
    }

    remoteTextTrackEls(): MockHTMLTrackElement[] {
        return this.remoteTrackEls_;
    }

    textTracks(): MockTextTrack[] {
        return this.remoteTracks_;
    }
}

// ---------------------------------------------------------------------------
// Controllable fetch
// ---------------------------------------------------------------------------

export interface FetchRoute {
    /** Returns true when this route owns the requested URL. */
    matches: (url: string) => boolean;
    /** Builds the response (or throws/rejects to simulate a network failure). */
    respond: (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
    label: string;
}

export class FetchController {
    private routes: FetchRoute[] = [];
    private pendingResolvers_: Array<() => void> = [];
    callLog: Array<{ url: string; label: string }> = [];

    addRoute(route: FetchRoute): void {
        this.routes.push(route);
    }

    /** Number of times a route with this label has been fetched. */
    callsFor(label: string): number {
        return this.callLog.filter(call => call.label === label).length;
    }

    /** Release every currently pending deferred response. */
    flushPending(): void {
        const resolvers = this.pendingResolvers_;
        this.pendingResolvers_ = [];
        resolvers.forEach(resolve => resolve());
    }

    build(): typeof fetch {
        return async (input: RequestInfo | URL): Promise<Response> => {
            const url = typeof input === 'string' ? input : input.toString();
            const route = this.routes.find(r => r.matches(url));

            if (!route) {
                throw new Error(`No mock fetch route for ${url}`);
            }

            this.callLog.push({ url, label: route.label });

            if ((route as DeferredFetchRoute).deferred) {
                await new Promise<void>(resolve => this.pendingResolvers_.push(resolve));
            }

            const result = await route.respond(url);
            return {
                ok: result.ok,
                status: result.status,
                text: () => result.text(),
            } as unknown as Response;
        };
    }
}

interface DeferredFetchRoute extends FetchRoute {
    deferred: true;
}

/** Route that blocks until FetchController.flushPending() is called. */
export function deferredRoute(
    label: string,
    matches: (url: string) => boolean,
    respond: FetchRoute['respond']
): DeferredFetchRoute {
    return { label, matches, respond, deferred: true };
}

export function fileRoute(
    label: string,
    matches: (url: string) => boolean,
    body: string
): FetchRoute {
    return {
        label,
        matches,
        respond: async () => ({ ok: true, status: 200, text: async () => body }),
    };
}

export function httpErrorRoute(
    label: string,
    matches: (url: string) => boolean,
    status = 500
): FetchRoute {
    return {
        label,
        matches,
        respond: async () => ({ ok: false, status, text: async () => `HTTP ${status}` }),
    };
}

/**
 * Drain the microtask queue a few times so that awaited fetch chains settle.
 */
export async function settleAsync(iterations = 10): Promise<void> {
    for (let i = 0; i < iterations; i++) {
        await Promise.resolve();
    }
}
