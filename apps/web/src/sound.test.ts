import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { SessionState } from "./agents";

// sound.ts builds an AudioContext and fetches the machine recordings, so the
// browser bits it touches are stubbed before the module is imported.

class FakeParam {
  value = 0;
  setTargetAtTime(v: number) {
    this.value = v;
  }
  setValueAtTime(v: number) {
    this.value = v;
  }
  exponentialRampToValueAtTime(v: number) {
    this.value = v;
  }
}

class FakeNode {
  connect(node: unknown) {
    return node;
  }
  start() {}
  stop() {}
}

class FakeAudioContext {
  currentTime = 0;
  sampleRate = 8000;
  destination = new FakeNode();
  createGain() {
    const n = new FakeNode();
    (n as any).gain = new FakeParam();
    return n;
  }
  createOscillator() {
    const n = new FakeNode();
    (n as any).frequency = new FakeParam();
    (n as any).type = "";
    return n;
  }
  createBiquadFilter() {
    const n = new FakeNode();
    (n as any).type = "";
    (n as any).frequency = new FakeParam();
    return n;
  }
  createBufferSource() {
    const n = new FakeNode();
    (n as any).buffer = null;
    (n as any).loop = false;
    return n;
  }
  createBuffer(_channels: number, length: number) {
    return { getChannelData: () => new Float32Array(length) };
  }
  decodeAudioData() {
    return Promise.resolve({ duration: 1 });
  }
  resume() {
    return Promise.resolve();
  }
  suspend() {
    return Promise.resolve();
  }
}

const prefs = new Map<string, string>();
(globalThis as any).AudioContext = FakeAudioContext;
(globalThis as any).localStorage = {
  getItem: (k: string) => prefs.get(k) ?? null,
  setItem: (k: string, v: string) => void prefs.set(k, String(v)),
  removeItem: (k: string) => void prefs.delete(k),
};
// The machine recordings "load" fine, so both the real-sample and synth paths run.
(globalThis as any).fetch = mock(() =>
  Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(16)) }),
);

const { sound } = await import("./sound");
const { useOffice } = await import("./store");

/** Private internals, exposed for assertions only. */
const eng = sound as any;

const sess = (key: string, over: Partial<SessionState> = {}): SessionState => ({
  key,
  machine: "m1",
  agent: "claude",
  sessionId: key,
  project: "demo",
  status: "working",
  activity: "write",
  tool: "Edit",
  toolCount: 1,
  failCount: 0,
  turns: 0,
  startedAt: 0,
  lastTs: 0,
  ...over,
});

/** Editing, file creation, a shell command and a QC check, all live at once. */
const factoryFloor = () => ({
  edit: sess("edit", { tool: "Edit" }),
  create: sess("create", { tool: "Write" }),
  shell: sess("shell", { activity: "shell", tool: "Bash", detail: "ls -la" }),
  qc: sess("qc", { activity: "shell", tool: "Bash", detail: "npm test" }),
});

const factoryGains = () => [
  eng.samples.cnc.gain.value,
  eng.samples.stepper.gain.value,
  eng.samples.laser.gain.value,
  eng.hum.gain.value,
  eng.buzz.gain.value,
  eng.rumble.gain.value,
  eng.servo.gain.value,
];

const flush = () => new Promise((r) => setTimeout(r, 10));

describe("sound engine follows theme and replay state", () => {
  beforeAll(async () => {
    useOffice.setState({ theme: "factory", mode: "live" });
    await sound.enable();
    await flush(); // let the sample fetches land
  });

  it("factory live: edit, create, command and QC each drive their own sound", () => {
    useOffice.setState({ sessions: factoryFloor() });
    // Real recordings are loaded, so the loops play through their gains…
    expect(eng.samples.cnc.gain.value).toBeGreaterThan(0); // editing mills
    expect(eng.samples.stepper.gain.value).toBeGreaterThan(0); // new files print
    expect(eng.samples.laser.gain.value).toBeGreaterThan(0); // commands cut
    expect(eng.servo.gain.value).toBeGreaterThan(0); // QC gantry
    expect(eng.rumble.gain.value).toBeGreaterThan(0); // floor conveyor
    expect(eng.probing).toBe(1); // one QC station probing
    expect(eng.typingRate).toBe(0); // no office keyboard on the factory floor
  });

  it("synth stand-ins take over when a recording is unavailable", () => {
    const loaded = eng.samples;
    eng.samples = {}; // what a failed fetch leaves behind
    sound.update(useOffice.getState().sessions);
    expect(eng.hum.gain.value).toBeGreaterThan(0);
    expect(eng.buzz.gain.value).toBeGreaterThan(0);
    eng.samples = loaded;
    sound.update(useOffice.getState().sessions);
  });

  it("switching to office or robots silences every factory loop and the probe", () => {
    useOffice.setState({ theme: "office" });
    expect(factoryGains().every((v) => v === 0)).toBe(true);
    expect(eng.probing).toBe(0);
    expect(eng.typingRate).toBeGreaterThan(0); // office keyboard takes over

    useOffice.setState({ theme: "robots" });
    expect(factoryGains().every((v) => v === 0)).toBe(true);
    expect(eng.probing).toBe(0);

    useOffice.setState({ theme: "factory" });
    expect(eng.samples.cnc.gain.value).toBeGreaterThan(0);
    expect(eng.probing).toBe(1);
  });

  it("replay mutes the loops and never fires one-shots, even across seeks", () => {
    const shots = {
      arrive: mock(() => {}),
      ding: mock(() => {}),
      fail: mock(() => {}),
      alarm: mock(() => {}),
      pass: mock(() => {}),
      prompt: mock(() => {}),
    };
    Object.assign(eng, shots);
    eng.lastShot.clear();

    useOffice.setState({ mode: "replay" });
    // A seek lands mid-history: new sessions, finished turns, failures, waiting agents.
    useOffice.setState({
      sessions: {
        a: sess("a", { turns: 5 }),
        b: sess("b", { status: "waiting" }),
      },
    });
    // Another seek jumps somewhere else entirely.
    useOffice.setState({
      sessions: {
        a: sess("a", { turns: 9, failCount: 2 }),
        c: sess("c", { activity: "shell", tool: "Bash", detail: "npm test", toolCount: 7 }),
      },
    });

    expect(factoryGains().every((v) => v === 0)).toBe(true);
    expect(eng.probing).toBe(0);
    expect(eng.typingRate).toBe(0);
    for (const spy of Object.values(shots)) expect(spy).not.toHaveBeenCalled();
  });

  it("back on factory live the loops return and old sessions don't re-chime", () => {
    eng.lastShot.clear();
    // The same four sessions that were live before the replay: no transition, no chime.
    useOffice.setState({ mode: "live", sessions: factoryFloor() });
    expect(eng.samples.cnc.gain.value).toBeGreaterThan(0);
    expect(eng.samples.laser.gain.value).toBeGreaterThan(0);
    expect(eng.probing).toBe(1);
    expect(eng.arrive).not.toHaveBeenCalled();
    expect(eng.ding).not.toHaveBeenCalled();
    expect(eng.alarm).not.toHaveBeenCalled();
  });

  it("live mode still plays one-shots on real state transitions", () => {
    eng.lastShot.clear();
    const base = useOffice.getState().sessions;

    useOffice.setState({ sessions: { ...base, newbie: sess("newbie") } });
    expect(eng.arrive).toHaveBeenCalledTimes(1);

    useOffice.setState({
      sessions: { ...base, newbie: sess("newbie"), edit: sess("edit", { tool: "Edit", turns: 1 }) },
    });
    expect(eng.ding).toHaveBeenCalledTimes(1);

    useOffice.setState({
      sessions: { ...base, newbie: sess("newbie", { failCount: 1, lastOk: false }) },
    });
    expect(eng.fail).toHaveBeenCalledTimes(1);

    useOffice.setState({
      sessions: { ...base, newbie: sess("newbie", { status: "waiting" }) },
    });
    expect(eng.alarm).toHaveBeenCalledTimes(1);

    // QC finishes a check cleanly: tool count moves on, no failure.
    useOffice.setState({
      sessions: {
        ...base,
        qc: sess("qc", { activity: "shell", tool: "Bash", detail: "npm test", toolCount: 2 }),
      },
    });
    expect(eng.pass).toHaveBeenCalledTimes(1);
  });

  it("keeps the on/off preference and stays silent while disabled", async () => {
    sound.disable();
    expect(prefs.get("agent-office-sound")).toBe("off");
    sound.update(useOffice.getState().sessions);
    expect(factoryGains().every((v) => v === 0)).toBe(true);

    await sound.enable();
    expect(prefs.get("agent-office-sound")).toBe("on");
    expect(eng.samples.cnc.gain.value).toBeGreaterThan(0);
  });
});
