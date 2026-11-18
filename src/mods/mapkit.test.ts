import { describe, expect, test } from 'bun:test';
import { buildMaps, eventPageReach, pageNeedsStep, previewMap, type GameSource, type MapSpec } from './mapkit.ts';

const layer = (name: string, w: number, h: number, data?: number[]) => ({ type: 'tilelayer', name, width: w, height: h, data: data ?? new Array(w * h).fill(0), opacity: 1, visible: true, x: 0, y: 0 });
// Source map 1: collision tileset first (gid 1), art tileset "A" at gid 25. Source map 2 has a different tileset order.
const map1 = { width: 6, height: 4, tilewidth: 32, tileheight: 32, tilesets: [{ firstgid: 1, source: 'Tile_Collisions_32x32.json' }, { firstgid: 25, source: 'A.json' }],
    layers: [layer('GROUND - I', 6, 4, Array.from({ length: 24 }, (_, i) => 25 + i)), layer('COLLISION', 6, 4, Array.from({ length: 24 }, (_, i) => (i % 6 === 0 ? 1 : 0)))] };
const map2 = { width: 4, height: 4, tilewidth: 32, tileheight: 32, tilesets: [{ firstgid: 1, source: 'B.json' }, { firstgid: 101, source: 'Tile_Collisions_32x32.json' }],
    layers: [layer('GROUND - I', 4, 4, new Array(16).fill(7)), layer('COLLISION', 4, 4, new Array(16).fill(101))] };
const data = { width: 6, height: 4, displayName: 'x', note: 'n', bgm: { name: '', volume: 90, pitch: 100, pan: 0 }, tilesetId: 1, data: new Array(6 * 4 * 6).fill(5), events: [null, { id: 1, name: 'orig', pages: [], x: 0, y: 0 }, { id: 2, name: 'gone', pages: [], x: 1, y: 1 }] };

const src = (over: Partial<GameSource> = {}): GameSource => ({
    tiledMap: id => ({ 1: map1, 2: map2 } as any)[id] ?? (() => { throw new Error('no such map'); })(),
    mapData: () => data,
    mapInfos: () => [null, { id: 1, name: 'one' }, { id: 2, name: 'two' }],
    tileset: s => ({ 'A.json': { tilecount: 64 }, 'B.json': { tilecount: 64 }, 'Tile_Collisions_32x32.json': { tilecount: 24 } } as any)[s] ?? null,
    commonEventCount: () => 10, systemCounts: () => ({ switches: 50, variables: 50 }),
    assetExists: rel => rel === 'img/characters/NPC.png',
    pngSize: rel => (rel === 'img/tilesets/MINE.png' ? [96, 64] : null),
    ...over,
});
const spec = (o: Partial<MapSpec> = {}): MapSpec => ({ id: 1001, name: 'New', size: [8, 6], tilesFrom: 1, ...o });
const parse = (b: ReturnType<typeof buildMaps>, f: string) => JSON.parse(b.files[f]!);

describe('mapkit', () => {
    test('builds the four files and registers the map', () => {
        const b = buildMaps('m', [spec({ events: [{ name: 'a', x: 1, y: 1, sprite: 'NPC', do: [{ say: 'hi' }] }] })], src());
        expect(b.errors).toEqual([]);
        expect(Object.keys(b.files).sort()).toEqual(['files/data/Map1001.json', 'files/languages/en/m_map1001.yml', 'files/maps/map1001.json', 'patches/data/MapInfos.json.patch.json']);
        const t = parse(b, 'files/maps/map1001.json');
        expect([t.width, t.height, t.layers[0].data.length]).toEqual([8, 6, 48]);
        expect(parse(b, 'files/data/Map1001.json').data.length).toBe(8 * 6 * 6);
        expect(b.files['files/languages/en/m_map1001.yml']).toContain('message_0:\n  text: "hi"');
        const ops = parse(b, 'patches/data/MapInfos.json.patch.json');
        expect(ops.at(-1)).toMatchObject({ op: 'add', path: '/1001' });
        expect(ops.filter((o: any) => o.path !== '/1001').every((o: any) => o.value === null)).toBe(true); // padded gap
    });
    test('refuses ids the game already uses, and bad shapes', () => {
        expect(buildMaps('m', [spec({ id: 2 })], src()).errors[0]).toMatch(/already used by the game/);
        expect(buildMaps('m', [spec({ size: [2, 2] })], src()).errors[0]).toMatch(/size/);
        expect(buildMaps('m', [spec(), spec()], src()).errors.join()).toMatch(/duplicate/);
    });
    test('stamp remaps gids across different tileset layouts and keeps collision', () => {
        const b = buildMaps('m', [spec({ stamps: [{ from: 2, rect: [0, 0, 2, 2], at: [3, 3] }] })], src());
        expect(b.errors).toEqual([]);
        const t = parse(b, 'files/maps/map1001.json');
        const b1 = t.tilesets.find((x: any) => x.source === 'B.json');
        expect(b1.firstgid).toBeGreaterThanOrEqual(25 + 64);                       // appended after the existing tilesets
        expect(t.layers[0].data[3 * 8 + 3]).toBe(b1.firstgid + 6);                 // local id 7-1 preserved
        expect(t.layers[1].data[3 * 8 + 3]).toBe(1);                               // collision: src gid 101 -> dst collision gid 1
        expect(t.layers[1].data[0]).toBe(0);
    });
    test('stamp rectangles are bounds-checked', () => {
        expect(buildMaps('m', [spec({ stamps: [{ from: 2, rect: [0, 0, 9, 9], at: [0, 0] }] })], src()).errors[0]).toMatch(/outside map 2/);
        expect(buildMaps('m', [spec({ stamps: [{ from: 2, rect: [0, 0, 4, 4], at: [6, 0] }] })], src()).errors[0]).toMatch(/does not fit/);
    });
    test('blocked ascii sets and clears collision', () => {
        const t = parse(buildMaps('m', [spec({ blocked: ['#.#'] })], src()), 'files/maps/map1001.json');
        expect(t.layers[1].data.slice(0, 3)).toEqual([1, 0, 1]);
    });
    test('commands compile with correct codes and nesting', () => {
        const b = buildMaps('m', [spec({ events: [{ name: 'e', x: 1, y: 1, do: [
            { switch: 3 }, { variable: 4, op: 'add', value: 2 }, { gold: -5 }, { item: 2, count: 3 },
            { if: { variable: [4, '>=', 2] }, then: [{ say: 'a' }], else: [{ self: 'B', to: false }] },
            { transfer: { map: 1, x: 2, y: 3 } }, { script: ['a();', 'b();'] },
        ] }] })], src());
        expect(b.errors).toEqual([]);
        const list = parse(b, 'files/data/Map1001.json').events[1].pages[0].list as { code: number; indent: number; parameters: unknown[] }[];
        expect(list.map(c => c.code)).toEqual([121, 122, 125, 126, 111, 356, 411, 123, 412, 201, 355, 655, 0]);
        expect(list[0]!.parameters).toEqual([3, 3, 0]);
        expect(list[1]!.parameters).toEqual([4, 4, 1, 0, 2]);
        expect(list[2]!.parameters).toEqual([1, 0, 5]);
        expect(list[5]!.indent).toBe(1);
        expect(list[5]!.parameters).toEqual(['ShowMessage m_map1001.message_0']);
        expect(list[9]!.parameters).toEqual([0, 1, 2, 3, 2, 0]);
    });
    test('pages: conditions, triggers, and the limits RPG Maker has', () => {
        const b = buildMaps('m', [spec({ events: [{ name: 'e', x: 1, y: 1, pages: [{ do: [] }, { if: { self: 'A', switch: [5, 6] }, trigger: 'auto', do: [] }] }] })], src());
        const pages = parse(b, 'files/data/Map1001.json').events[1].pages;
        expect(pages[1].conditions).toMatchObject({ selfSwitchValid: true, selfSwitchCh: 'A', switch1Id: 5, switch1Valid: true, switch2Id: 6, switch2Valid: true });
        expect(pages[1].trigger).toBe(3);
        const bad = buildMaps('m', [spec({ events: [{ name: 'e', x: 1, y: 1, pages: [{ if: { notSwitch: 2 }, do: [] }] }] })], src());
        expect(bad.errors.join()).toMatch(/notSwitch/);
    });
    test('warns about unreachable touch events, unknown sprites, bad transfers and common events', () => {
        const b = buildMaps('m', [spec({ blocked: ['#'], events: [
            { name: 'door', x: 0, y: 0, trigger: 'touch', do: [{ transfer: { map: 99999, x: 0, y: 0 } }, { common: 99 }] },
            { name: 'npc', x: 3, y: 3, sprite: 'MISSING', do: [] },
        ] })], src());
        const w = b.warnings.join('\n');
        expect(w).toMatch(/door.*blocked tile/);
        expect(w).toMatch(/map 99999/);
        expect(w).toMatch(/common event 99/);
        expect(w).toMatch(/MISSING/);
        expect(b.errors).toEqual([]);
    });
    test('events outside the map are errors', () => {
        expect(buildMaps('m', [spec({ events: [{ name: 'e', x: 8, y: 0, do: [] }] })], src()).errors[0]).toMatch(/outside/);
    });
    test('preview marks blocked tiles and events', () => {
        const t = parse(buildMaps('m', [spec({ blocked: ['#'] })], src()), 'files/maps/map1001.json');
        const p = previewMap(t, [{ x: 0, y: 0, name: 'door' }, { x: 2, y: 2, name: 'npc' }]);
        expect(p).toContain('A door (0,0)  [on a blocked tile]');
        expect(p).toContain('B npc (2,2)');
    });

    test('page reachability: only touch / event-touch without through needs the player to step on the tile', () => {
        expect(pageNeedsStep('action', false)).toBe(false);
        expect(pageNeedsStep('auto', false)).toBe(false);
        expect(pageNeedsStep('parallel', false)).toBe(false);
        expect(pageNeedsStep('touch', false)).toBe(true);
        expect(pageNeedsStep('event-touch', false)).toBe(true);
        expect(pageNeedsStep('touch', true)).toBe(false);       // through pages do not require the tile
        expect(pageNeedsStep(1, false)).toBe(true);            // numeric RPG Maker trigger codes work too
        expect(pageNeedsStep(3, false)).toBe(false);
    });

    test('eventPageReach judges each page against the collision layer', () => {
        const t = parse(buildMaps('m', [spec({ blocked: ['#'] })], src()), 'files/maps/map1001.json');
        const reach = eventPageReach(t, 0, 0, [
            { trigger: 1, through: false },   // touch on the blocked tile
            { trigger: 0, through: false },   // action: never tile-dependent
            { trigger: 3, through: false },   // auto: runs without the player
            { trigger: 1, through: true },    // touch but through
        ]);
        expect(reach.map(r => [r.index, r.trigger, r.needsStep, r.blocked, r.reachable])).toEqual([
            [1, 'touch', true, true, false],
            [2, 'action', false, false, true],
            [3, 'auto', false, false, true],
            [4, 'touch', false, false, true],
        ]);
        const open = eventPageReach(t, 2, 2, [{ trigger: 1, through: false }]);
        expect(open[0]).toMatchObject({ needsStep: true, blocked: false, reachable: true });
    });

    test('multi-page events warn per page and never report the whole event while a page is reachable', () => {
        // Event at (0,0) sits on a blocked tile (blocked: ['#'] blocks column 0): page 1 touch
        // is unreachable, page 2 action can still be triggered, so the event itself is not "unreachable".
        const b = buildMaps('m', [spec({ blocked: ['#'], events: [{
            name: 'moody', x: 0, y: 0,
            pages: [{ trigger: 'touch', do: [] }, { trigger: 'action', do: [] }],
        }] })], src());
        const w = b.warnings.join('\n');
        expect(w).toMatch(/moody.*page 1 \(touch\).*blocked tile/);
        expect(w).not.toMatch(/moody.*unreachable/);
        // An event whose only other page is auto: the auto page runs, so the event stays reachable.
        const auto = buildMaps('m', [spec({ blocked: ['#'], events: [{
            name: 'guard', x: 0, y: 0,
            pages: [{ trigger: 'touch', do: [] }, { trigger: 'auto', do: [] }],
        }] })], src()).warnings.join('\n');
        expect(auto).toMatch(/guard.*page 1 \(touch\).*blocked tile/);
        expect(auto).not.toMatch(/guard.*unreachable/);
    });

    test('all step-dependent pages blocked: each page is named and the event is flagged unreachable', () => {
        const b = buildMaps('m', [spec({ blocked: ['#'], events: [{
            name: 'trapdoor', x: 0, y: 0,
            pages: [{ trigger: 'touch', do: [] }, { trigger: 'event-touch', do: [] }],
        }] })], src());
        const w = b.warnings;
        expect(w.some(m => /trapdoor.*page 1 \(touch\).*blocked tile/.test(m))).toBe(true);
        expect(w.some(m => /trapdoor.*page 2 \(event-touch\).*blocked tile/.test(m))).toBe(true);
        expect(w.some(m => /trapdoor.*is unreachable: every page/.test(m))).toBe(true);
    });

    test('through pages and auto/parallel pages never count as blocked', () => {
        const b = buildMaps('m', [spec({ blocked: ['#'], events: [
            { name: 'ghost', x: 0, y: 0, trigger: 'touch', through: true, do: [] },
            { name: 'cutscene', x: 0, y: 0, trigger: 'parallel', do: [] },
        ] })], src());
        expect(b.warnings.filter(m => /ghost|cutscene/.test(m))).toEqual([]);
        // A blocked touch page plus a through touch page: the through page keeps the event reachable.
        const mixed = buildMaps('m', [spec({ blocked: ['#'], events: [{
            name: 'halfway', x: 0, y: 0,
            pages: [{ trigger: 'touch', do: [] }, { trigger: 'touch', through: true, do: [] }],
        }] })], src()).warnings.join('\n');
        expect(mixed).toMatch(/halfway.*page 1 \(touch\).*blocked tile/);
        expect(mixed).not.toMatch(/halfway.*unreachable/);
    });

    test('single-page events keep the original warning wording', () => {
        const b = buildMaps('m', [spec({ blocked: ['#'], events: [
            { name: 'door', x: 0, y: 0, trigger: 'touch', do: [] },
        ] })], src());
        expect(b.warnings).toContain('map 1001: event "door" at (0,0) is on a blocked tile, so the player can never step on it (use "map show" to find an open tile)');
    });

    test('preview legend names the blocked pages of a multi-page event', () => {
        const built = buildMaps('m', [spec({ blocked: ['#'], events: [{
            name: 'moody', x: 0, y: 0,
            pages: [{ trigger: 'touch', do: [] }, { trigger: 'action', do: [] }],
        }] })], src());
        const t = parse(built, 'files/maps/map1001.json');
        const d = parse(built, 'files/data/Map1001.json');
        const ev = d.events[1];
        const p = previewMap(t, [{ x: ev.x, y: ev.y, name: ev.name, pages: ev.pages.map((pg: any) => ({ trigger: pg.trigger, through: pg.through })) }]);
        expect(p).toContain('A moody (0,0)  [page 1 touch blocked]');
        expect(p).not.toContain('event unreachable');
        // Same shape as the CLI: every step-dependent page blocked adds the event-level marker.
        const all = buildMaps('m', [spec({ blocked: ['#'], events: [{
            name: 'trapdoor', x: 0, y: 0,
            pages: [{ trigger: 'touch', do: [] }, { trigger: 'event-touch', do: [] }],
        }] })], src());
        const t2 = parse(all, 'files/maps/map1001.json');
        const e2 = parse(all, 'files/data/Map1001.json').events[1];
        const p2 = previewMap(t2, [{ x: e2.x, y: e2.y, name: e2.name, pages: e2.pages.map((pg: any) => ({ trigger: pg.trigger, through: pg.through })) }]);
        expect(p2).toContain('[page 1 touch blocked; page 2 event-touch blocked]  [event unreachable]');
    });

    test('custom tilesets: json is generated from the PNG size and paint uses it', () => {
        const b = buildMaps('m', [spec({ tilesets: [{ name: 'MINE' }], paint: [{ layer: 'GROUND - I', tileset: 'MINE', tiles: [[0, null], [3, 5]], at: [1, 1] }] })], src());
        expect(b.errors).toEqual([]);
        const ts = parse(b, 'files/maps/MINE.json');
        expect([ts.columns, ts.tilecount, ts.image]).toEqual([3, 6, '../img/tilesets/MINE.png']);
        const t = parse(b, 'files/maps/map1001.json');
        const first = t.tilesets.find((x: any) => x.source === 'MINE.json').firstgid;
        const L = t.layers[0].data;
        expect([L[1 * 8 + 1], L[1 * 8 + 2], L[2 * 8 + 1], L[2 * 8 + 2]]).toEqual([first, 0, first + 3, first + 5]);
    });
    test('paint and tileset errors are specific', () => {
        const e = (o: Partial<MapSpec>) => buildMaps('m', [spec(o)], src()).errors.join('|');
        expect(e({ tilesets: [{ name: 'NOPE' }] })).toMatch(/files\/img\/tilesets\/NOPE\.png/);
        expect(e({ paint: [{ layer: 'NOPE', tileset: 'A', tile: 0 }] })).toMatch(/no layer "NOPE"/);
        expect(e({ paint: [{ layer: 'COLLISION', tileset: 'A', tile: 0 }] })).toMatch(/use "blocked"/);
        expect(e({ paint: [{ layer: 'GROUND - I', tileset: 'ZZZ', tile: 0 }] })).toMatch(/not a game tileset/);
        expect(e({ tilesets: [{ name: 'MINE' }], paint: [{ layer: 'GROUND - I', tileset: 'MINE', tile: 6 }] })).toMatch(/tile 6 is outside MINE \(it has 6\)/);
        expect(e({ paint: [{ layer: 'GROUND - I', tileset: 'A', tile: 1, rect: [7, 5, 3, 1] }] })).toMatch(/outside the 8x6 map/);
        expect(e({ paint: [{ layer: 'GROUND - I', tileset: 'A' }] })).toMatch(/either "tile"/);
    });
    test('base: editing a game map in place keeps events and data, adds and removes events, writes no MapInfos', () => {
        const b = buildMaps('m', [{ id: 1, base: 1, removeEvents: [2], events: [{ name: 'new', x: 2, y: 2, do: [] }] }], src({ mapInfos: () => [null, { id: 1, name: 'one' }] }));
        expect(b.errors).toEqual([]);
        expect(b.warnings.join()).toMatch(/replaces the game's map 1/);
        const d = parse(b, 'files/data/Map001.json');
        expect(d.events.map((e: any) => e && e.name)).toEqual([null, 'orig', null, 'new']);
        expect(d.events[3].id).toBe(3);
        expect(d.data.every((v: number) => v === 5)).toBe(true);   // tile data untouched
        expect(d.displayName).toBe('x');
        expect(b.files['patches/data/MapInfos.json.patch.json']).toBeUndefined();
        expect(parse(b, 'files/maps/map1.json').width).toBe(6);
    });
    test('base: clone-and-extend under a new id; a base that is a different existing id still needs a free id', () => {
        const b = buildMaps('m', [spec({ id: 1002, base: 1, name: 'Copy', events: [{ name: 'n', x: 0, y: 0, do: [] }] })], src());
        expect(b.errors).toEqual([]);
        expect(parse(b, 'files/data/Map1002.json').events.map((e: any) => e && e.name)).toEqual([null, 'orig', 'gone', 'n']);
        expect(buildMaps('m', [spec({ id: 2, base: 1 })], src()).errors[0]).toMatch(/already used by the game/);
        expect(buildMaps('m', [{ id: 9 } as MapSpec], src()).errors.join()).toMatch(/name is required/);
    });
});
