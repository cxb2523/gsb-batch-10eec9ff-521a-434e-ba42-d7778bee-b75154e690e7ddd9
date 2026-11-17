import { describe, it, expect, vi, afterEach } from "vitest";
import { Player } from "./Player.ts";
import { Node } from "../node/Node.ts";
import { TimescaleFilter, EqualizerFilter } from "../filters/Filters.ts";
import type { TrackData } from "../types/protocol.ts";

type MockNode = Node & {
  rest: Node["rest"] & {
    updatePlayer: ReturnType<typeof vi.fn>;
    destroyPlayer: ReturnType<typeof vi.fn>;
  };
};

function createMockNode(name: string, type: "lavalink" | "nodelink" = "lavalink"): MockNode {
  const node = new Node(
    {
      host: "localhost",
      port: 2333,
      password: "youshallnotpass",
      name,
      type,
    },
    "123456",
  );

  Object.defineProperty(node.ws, "eventDispatcher", {
    value: {
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
    },
    configurable: true,
  });

  Object.defineProperty(node.ws, "state", {
    value: "connected",
    configurable: true,
  });

  Object.defineProperty(node.rest, "sessionId", {
    value: "test-session",
    writable: true,
    configurable: true,
  });

  node.rest.updatePlayer = vi.fn().mockResolvedValue({});
  node.rest.destroyPlayer = vi.fn().mockResolvedValue(undefined);

  return node as MockNode;
}

function createPlayer(node: Node): Player {
  return new Player({
    guildId: "guild-1",
    node,
    voiceChannelId: "channel-1",
    textChannelId: "text-1",
    kumo: {} as never,
  });
}

const VOICE_STATE = {
  sessionId: "voice-session",
  channelId: "channel-1",
  endpoint: "voice.discord.gg",
  token: "voice-token",
};

function makeTrack(encoded = "track-1"): TrackData {
  return {
    encoded,
    info: {
      identifier: encoded,
      isSeekable: true,
      author: "Test Author",
      length: 180000,
      isStream: false,
      position: 0,
      title: "Test Track",
      uri: null,
      artworkUrl: null,
      isrc: null,
      sourceName: "youtube",
    },
    pluginInfo: {},
  };
}

/** Starts a track on the node and drives the player into the playing state. */
async function startPlayback(player: Player, node: MockNode, track: TrackData): Promise<void> {
  player.setVoiceState(VOICE_STATE);
  player.queue.enqueue(track);
  await player.play();
  node.rest.updatePlayer.mockClear();
}

/** The last PATCH /sessions body sent to a node. */
function lastPatch(node: MockNode): Record<string, unknown> {
  const calls = node.rest.updatePlayer.mock.calls as Array<[string, string, Record<string, unknown>]>;
  return calls[calls.length - 1]?.[2] ?? {};
}

/** The PATCH body that carried a non-null track (i.e. an actual play request). */
function lastTrackPlay(node: MockNode): Record<string, unknown> {
  const calls = node.rest.updatePlayer.mock.calls as Array<[string, string, Record<string, unknown>]>;
  const play = [...calls]
    .reverse()
    .find((c) => (c[2]?.track as { encoded?: string } | undefined)?.encoded != null);
  return play?.[2] ?? {};
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Player.setNode migration", () => {
  it("same-family migration keeps every filter and resumes from the original position", async () => {
    vi.useFakeTimers();
    const oldNode = createMockNode("old", "nodelink");
    const newNode = createMockNode("new", "nodelink");
    const player = createPlayer(oldNode);
    const track = makeTrack();

    await startPlayback(player, oldNode, track);
    await player.setTimescale({ speed: 1.25, pitch: 1.25 });
    await player.setEcho({ delay: 200, feedback: 0.4 });

    await player.seek(42000);
    const positionAtMove = player.position;
    expect(positionAtMove).toBe(42000);

    await player.setNode(newNode);

    expect(player.node.id).toBe("new");
    expect(player.status).toBe("playing");
    // The old node is told to release the player; the replacement takes over
    expect(oldNode.rest.destroyPlayer).toHaveBeenCalledWith("test-session", "guild-1");

    const payload = lastTrackPlay(newNode);
    expect(payload.track).toEqual({ encoded: "track-1" });
    expect(payload.position).toBe(positionAtMove);
    // Both filters survive a same-family move and are re-applied on the node
    expect(player.filters.has("timescale")).toBe(true);
    expect(player.filters.has("echo")).toBe(true);
    expect(payload.filters).toMatchObject({
      timescale: { speed: 1.25, pitch: 1.25 },
      echo: { delay: 200, feedback: 0.4 },
    });
  });

  it("same-family migration keeps a paused track paused at the same position", async () => {
    const oldNode = createMockNode("old", "lavalink");
    const newNode = createMockNode("new", "lavalink");
    const player = createPlayer(oldNode);
    const track = makeTrack();

    await startPlayback(player, oldNode, track);
    await player.pause();
    await player.seek(15000);
    newNode.rest.updatePlayer.mockClear();

    await player.setNode(newNode);

    expect(player.status).toBe("paused");
    expect(player.paused).toBe(true);
    const payload = lastTrackPlay(newNode);
    expect(payload.track).toEqual({ encoded: "track-1" });
    expect(payload.position).toBe(15000);
    expect(payload.paused).toBe(true);
  });

  it("cross-family migration drops only the filters the target cannot run and re-applies the rest", async () => {
    const nlNode = createMockNode("nl", "nodelink");
    const llNode = createMockNode("ll", "lavalink");
    const player = createPlayer(nlNode);
    const track = makeTrack();

    await startPlayback(player, nlNode, track);
    await player.setTimescale({ speed: 1.1, pitch: 1.1 });
    await player.setEcho({ delay: 250, feedback: 0.3 });
    await player.setEqualizer([{ band: 0, gain: 0.4 }]);
    nlNode.rest.updatePlayer.mockClear();

    await player.seek(30000);

    await player.setNode(llNode);

    // NodeLink-only filter is gone, standard Lavalink filters stay
    expect(player.filters.has("echo")).toBe(false);
    expect(player.filters.has("timescale")).toBe(true);
    expect(player.filters.has("equalizer")).toBe(true);

    const payload = lastTrackPlay(llNode);
    expect(payload.track).toEqual({ encoded: "track-1" });
    expect(payload.position).toBe(30000);
    expect(payload.filters).not.toHaveProperty("echo");
    expect(payload.filters).toMatchObject({
      timescale: { speed: 1.1, pitch: 1.1 },
      equalizer: [{ band: 0, gain: 0.4 }],
    });

    // The reverse move (Lavalink -> NodeLink) must not drop standard filters
    const nextNlNode = createMockNode("nl-2", "nodelink");
    llNode.rest.updatePlayer.mockClear();
    await player.setNode(nextNlNode);
    expect(player.filters.has("timescale")).toBe(true);
    expect(player.filters.has("equalizer")).toBe(true);
    const reversePayload = lastTrackPlay(nextNlNode);
    expect(reversePayload.filters).toMatchObject({
      timescale: { speed: 1.1, pitch: 1.1 },
      equalizer: [{ band: 0, gain: 0.4 }],
    });
  });

  it("keeps filters, position and status when the target node has no session yet, then flushes on resync", async () => {
    const oldNode = createMockNode("old", "lavalink");
    const newNode = createMockNode("new", "lavalink");
    Object.defineProperty(newNode.rest, "sessionId", {
      value: null,
      writable: true,
      configurable: true,
    });
    const player = createPlayer(oldNode);
    const track = makeTrack();

    await startPlayback(player, oldNode, track);
    await player.setEqualizer([{ band: 1, gain: 0.2 }]);
    oldNode.rest.updatePlayer.mockClear();
    await player.seek(20000);

    // Migration must resolve (not throw) and must not touch the session-less node
    await expect(player.setNode(newNode)).resolves.toBeUndefined();
    expect(player.node.id).toBe("new");
    expect(newNode.rest.updatePlayer).not.toHaveBeenCalled();
    // Internal state is fully retained
    expect(player.status).toBe("playing");
    expect(player.currentTrack?.encoded).toBe("track-1");
    expect(player.filters.has("equalizer")).toBe(true);
    expect(player.queue.currentTrack?.encoded).toBe("track-1");

    // The session comes up — a nodeReady-driven resync delivers everything
    Object.defineProperty(newNode.rest, "sessionId", {
      value: "new-session",
      writable: true,
      configurable: true,
    });
    await player.resync();

    const payload = lastPatch(newNode);
    expect(payload.voice).toMatchObject({ token: "voice-token", channelId: "channel-1" });
    expect(payload.track).toEqual({ encoded: "track-1" });
    expect(payload.position).toBe(20000);
    expect(payload.filters).toMatchObject({ equalizer: [{ band: 1, gain: 0.2 }] });
    // After a successful flush the stash is consumed
    expect(player.position).toBe(20000);
  });

  it("replays the stashed migration position through a later playTrack when the session was unavailable", async () => {
    const oldNode = createMockNode("old", "lavalink");
    const newNode = createMockNode("new", "lavalink");
    Object.defineProperty(newNode.rest, "sessionId", {
      value: null,
      writable: true,
      configurable: true,
    });
    const player = createPlayer(oldNode);
    const track = makeTrack();

    await startPlayback(player, oldNode, track);
    await player.seek(55000);

    await player.setNode(newNode);
    expect(newNode.rest.updatePlayer).not.toHaveBeenCalled();

    // Session established; the caller (or a queue advance) starts the track
    Object.defineProperty(newNode.rest, "sessionId", {
      value: "new-session",
      writable: true,
      configurable: true,
    });
    await player.playTrack(track);

    const payload = lastTrackPlay(newNode);
    expect(payload.track).toEqual({ encoded: "track-1" });
    expect(payload.position).toBe(55000);
    // A subsequent explicit play no longer inherits the migration position
    newNode.rest.updatePlayer.mockClear();
    await player.playTrack(track);
    expect(lastTrackPlay(newNode).position).toBeUndefined();
  });

  it("surfaces a track start failure on the new node without collapsing the player to idle", async () => {
    vi.useFakeTimers();
    const oldNode = createMockNode("old", "lavalink");
    const newNode = createMockNode("new", "lavalink");
    newNode.rest.updatePlayer = vi.fn().mockRejectedValue(new Error("node rejected track"));
    const player = createPlayer(oldNode);
    const track = makeTrack();

    await startPlayback(player, oldNode, track);
    await player.setEqualizer([{ band: 0, gain: 0.3 }]);
    await player.seek(10000);

    await expect(player.setNode(newNode)).rejects.toThrow("node rejected track");

    // Player state survives: still logically playing the same track at the
    // same spot, and the node ownership already moved to the replacement
    expect(player.node.id).toBe("new");
    expect(player.status).toBe("playing");
    expect(player.currentTrack?.encoded).toBe("track-1");
    expect(player.filters.has("equalizer")).toBe(true);

    // Once the node recovers, a resync still delivers the retained state
    newNode.rest.updatePlayer = vi.fn().mockResolvedValue({});
    await player.resync();
    const payload = lastPatch(newNode);
    expect(payload.track).toEqual({ encoded: "track-1" });
    expect(payload.position).toBe(10000);
    expect(payload.filters).toMatchObject({ equalizer: [{ band: 0, gain: 0.3 }] });
  });

  it("does not let a failed destroy on the old node block the new node from taking over", async () => {
    vi.useFakeTimers();
    const oldNode = createMockNode("old", "lavalink");
    oldNode.rest.destroyPlayer = vi.fn().mockRejectedValue(new Error("old node is gone"));
    const newNode = createMockNode("new", "lavalink");
    const player = createPlayer(oldNode);
    const track = makeTrack();

    await startPlayback(player, oldNode, track);
    await player.seek(8000);

    await expect(player.setNode(newNode)).resolves.toBeUndefined();
    expect(oldNode.rest.destroyPlayer).toHaveBeenCalledWith("test-session", "guild-1");
    expect(player.node.id).toBe("new");

    const payload = lastTrackPlay(newNode);
    expect(payload.track).toEqual({ encoded: "track-1" });
    expect(payload.position).toBe(8000);
  });

  it("migrates an idle player by registering voice and filters without starting a track", async () => {
    const oldNode = createMockNode("old", "lavalink");
    const newNode = createMockNode("new", "lavalink");
    const player = createPlayer(oldNode);
    player.setVoiceState(VOICE_STATE);
    player.filters.add(new TimescaleFilter({ speed: 1.5 }));

    await player.setNode(newNode);

    expect(player.status).toBe("idle");
    const payload = lastPatch(newNode);
    expect(payload.voice).toMatchObject({ token: "voice-token", channelId: "channel-1" });
    expect(payload.track).toBeUndefined();
    expect(payload.filters).toMatchObject({ timescale: { speed: 1.5 } });
  });

  it("is a no-op when asked to move onto the node it already uses", async () => {
    const node = createMockNode("only", "lavalink");
    const player = createPlayer(node);
    await player.setNode(node);
    expect(node.rest.destroyPlayer).not.toHaveBeenCalled();
    expect(node.rest.updatePlayer).not.toHaveBeenCalled();
  });

  it("retains standard filters across a NodeLink -> Lavalink move even when no track is playing", async () => {
    const nlNode = createMockNode("nl", "nodelink");
    const llNode = createMockNode("ll", "lavalink");
    const player = createPlayer(nlNode);
    player.setVoiceState(VOICE_STATE);
    await player.setEcho({ delay: 100, feedback: 0.2 });
    player.filters.add(new EqualizerFilter([{ band: 0, gain: 0.1 }]));

    await player.setNode(llNode);

    expect(player.filters.has("echo")).toBe(false);
    expect(player.filters.has("equalizer")).toBe(true);
    const payload = lastPatch(llNode);
    expect(payload.filters).toEqual({ equalizer: [{ band: 0, gain: 0.1 }] });
  });
});
