/* dev-only test harness, loaded manually over CDP; never referenced by index.html */
window.__errs = [];
window.onerror = (m, s, l) => window.__errs.push(m + ' @' + l);
window.addEventListener('unhandledrejection', e => window.__errs.push('rej: ' + e.reason));

window.H = {
  place(x, y, z, yaw, pitch){
    player.pos.set(x, y, z);
    if (yaw !== undefined) player.yaw = yaw;
    if (pitch !== undefined) player.pitch = pitch;
    player.vel.set(0, 0, 0);
    /* leftover recoil from an earlier shot silently re-aims the camera */
    player.recoilPitch = player.recoilYaw = player.recoilVelP = player.recoilVelY = 0;
    player.burstCount = 0; player.shake = 0; player.landShake = 0; player.fovKick = 0;
    for (const w of WEAPONS) w.spread = w.spreadBase;
  },

  /* One frame of the real loop, so values written during update/render settle */
  frame(){ return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); },

  /* An open firing lane: a spot the player can stand with `d` metres of clear
     air in front of it, so an accuracy test measures the gun and not a crate. */
  lane(d){
    const R = new THREE.Raycaster();
    for (let i = 0; i < 900; i++){
      const x = rand(-24, 24), z = rand(-24, 24);
      if (blocked(x, z, 0.3, 1.65, 0.5)) continue;
      const a = rand(0, Math.PI*2);
      const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
      const tx = x + dir.x*d, tz = z + dir.z*d;
      if (Math.abs(tx) > 26 || Math.abs(tz) > 26) continue;
      if (blocked(tx, tz, 0.3, 1.65, 0.5)) continue;
      let clear = true;
      for (const h of [0.6, 1.2, 1.7]){
        R.set(new THREE.Vector3(x, h, z), dir); R.far = d + 1.2;
        if (R.intersectObjects(worldSolid, false).length){ clear = false; break; }
      }
      if (!clear) continue;
      /* yaw such that camera forward (-Z rotated by yaw) points down `dir` */
      return {x, z, tx, tz, yaw: Math.atan2(-dir.x, -dir.z)};
    }
    return null;
  },

  /* The real "no phantom misses" test.
     For each shot, cast the crosshair ray first. Whenever that ray lands on an
     enemy hitbox, the game must register a hit; whenever it lands on the world,
     it must not. Aim wanders (scope sway, recoil) are irrelevant — we compare
     what the crosshair was on against what the shot did. */
  async fidelity(n, d, ads){
    const e = enemies.find(x => !x.dead);
    const L = H.lane(d);
    if (!L) return {err:'no clear lane at ' + d + 'm'};
    G.over = false; G.running = true; player.dead = false; window.__god = true;
    H.ads(!!ads);
    for (let f = 0; f < 24; f++) await H.frame();
    const R = new THREE.Raycaster();
    let onTarget = 0, registered = 0, falsePos = 0, ghostMiss = 0;
    for (let i = 0; i < n; i++){
      /* jitter the aim so the crosshair lands on and off the body */
      const jx = rand(-0.010, 0.010), jy = rand(-0.008, 0.012);
      H.place(L.x, 0, L.z, L.yaw + jx, jy);
      e.dead = false; e.hp = 1e6; e.deathT = 0; e.flinch = 0; e.gunDropped = false;
      e.obj.visible = true;
      e.obj.position.set(L.tx, 0, L.tz); e.obj.updateMatrixWorld(true);
      G.kills = 0; G.over = false; G.running = true;
      rebuildHitMeshes();
      await H.frame();                       // let the camera adopt the new aim
      e.obj.position.set(L.tx, 0, L.tz); e.obj.updateMatrixWorld(true);
      const fw = new THREE.Vector3(); camera.getWorldDirection(fw);
      R.set(camera.position, fw); R.far = WEAPONS[player.weapon].range;
      const pre = R.intersectObjects(enemyHitMeshes.concat(worldSolid), false)[0];
      const preEnemy = !!(pre && pre.object.userData && pre.object.userData.enemy);
      const h0 = G.hits;
      player.fireCooldown = 0; player.pumpT = 0; player.boltT = 0; player.reloadT = 0;
      const w = WEAPONS[player.weapon];
      if (w.mag <= 0) w.mag = w.magSize;
      fireWeapon();
      const got = G.hits > h0;
      if (preEnemy){ onTarget++; if (got) registered++; else ghostMiss++; }
      else if (got) falsePos++;
    }
    H.ads(false);
    e.hp = 100;
    return {weapon: WEAPONS[player.weapon].name, dist:d, ads:!!ads,
            crosshairOnEnemy:onTarget, registered, ghostMisses:ghostMiss,
            hitsWithoutTarget:falsePos};
  },

  /* Fire n settled shots at a target d metres dead ahead and count the hits.
     This is the "crosshair is on him, did it register" test. */
  async accuracy(n, d, ads){
    const e = enemies.find(x => !x.dead);
    const L = H.lane(d);
    if (!L) return {err: 'no clear lane at ' + d + 'm'};
    G.over = false; G.running = true; player.dead = false; window.__god = true;
    H.wep(player.weapon);
    H.ads(!!ads);
    /* let the ADS ease actually finish — it is a 0.2s lerp */
    for (let f = 0; f < 24; f++) await H.frame();
    let hit = 0, shots = 0;
    for (let i = 0; i < n; i++){
      H.place(L.x, 0, L.z, L.yaw, 0);
      /* Revive fully between shots. A sniper body shot kills outright, which
         pulls the target out of enemyHitMeshes — every later round then has
         nothing to hit and the test reads as a broken gun. */
      e.dead = false; e.hp = 1e6; e.deathT = 0; e.flinch = 0; e.gunDropped = false;
      e.obj.visible = true;
      e.obj.position.set(L.tx, 0, L.tz); e.obj.updateMatrixWorld(true);
      G.kills = 0; G.over = false; G.running = true;
      rebuildHitMeshes();
      const h0 = G.hits;
      player.fireCooldown = 0; player.pumpT = 0; player.boltT = 0; player.reloadT = 0;
      const wep = WEAPONS[player.weapon];
      if (wep.mag <= 0){ wep.mag = wep.magSize; }
      if (fireWeapon()){ shots++; if (G.hits > h0) hit++; }
      await H.frame();
    }
    H.ads(false);
    e.hp = 100;
    return {weapon: WEAPONS[player.weapon].name, dist: d, ads: !!ads, shots, hit,
            pct: shots ? Math.round(hit/shots*100) : 0, adsEase: +player.adsEase.toFixed(2)};
  },
  wep(i){ switchWeapon(i); player.switching = 0; player.switchTo = -1; player.weapon = i;
          for (const w of WEAPONS) w.vm.group.visible = false;
          WEAPONS[i].vm.group.visible = true;
          updateAmmoUI(); },
  ads(on){ setADS(on); },

  /* ---- breath-hold (sniper scope sway) machinery ------------------------
     These are reusable primitives; H.breathTest() runs the full regression.
     Keys go through the real window keyboard events, so the game's edge
     latch (player.shiftEdge) is exercised exactly like a human hand. */
  _key(code, down){
    window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup',
      {code, bubbles:true, cancelable:true}));
  },
  shiftDown(){ this._key('ShiftLeft', true); },
  shiftUp(){ this._key('ShiftLeft', false); },

  /* run n real frames of the game loop and settle */
  async frames(n){ for (let i = 0; i < n; i++) await this.frame(); },

  /* clean slate for a breath scenario: sniper, running, alive, scope up and
     fully through its 0.2s ADS ease, no reload/bolt, no breath, Shift released */
  async breathSetup(){
    window.__god = true;
    G.over = false; G.running = true; G.paused = false;
    player.dead = false;
    this.shiftUp();
    this.wep(3);                                   /* SR-7 LONGBOW sniper */
    const w = WEAPONS[3];
    w.mag = w.magSize; w.res = w.reserve;
    player.reloadT = 0; player.boltT = 0; player.pumpT = 0; player.switching = 0;
    player.fireCooldown = 0;
    clearBreath();
    player.swayAmp = 1;
    this.place(0, 0, 24, 0, 0);
    this.ads(true);
    await this.frames(24);                         /* let the 0.2s ADS lerp finish */
    return this.breathState();
  },

  /* raw breath state machine + the numbers that drive the lens drift */
  breathState(){
    return {held: player.breathHeld, lock: player.breathLock,
            edge: player.shiftEdge, breath: +player.breath.toFixed(4),
            amp: +player.swayAmp.toFixed(4),
            swayX: +player.swayX.toFixed(6), swayY: +player.swayY.toFixed(6),
            scoped: !!WEAPONS[player.weapon].scope && player.adsEase > 0.55,
            adsEase: +player.adsEase.toFixed(3),
            reloadT: +player.reloadT.toFixed(3), boltT: +player.boltT.toFixed(3)};
  },

  /* Sample the real per-frame lens offset for win frames (after warm frames).
     amp is the internal damped multiplier; peak/rms are what the camera
     actually rotates by, measured across genuine frame advances. An optional
     cond() cuts sampling early (e.g. only while a breath hold is alive) and
     cut/n report that so callers can tell a full window from a truncated one. */
  async swaySample(warm, win, cond){
    warm = warm || 0; win = win || 30;
    await this.frames(warm);
    let peak = 0, sum2 = 0, sumAbs = 0, n = 0, minAmp = 2, maxAmp = 0, cut = false;
    for (let i = 0; i < win; i++){
      await this.frame();
      if (cond && !cond()){ cut = true; break; }
      const s = this.breathState();
      const m = Math.hypot(s.swayX, s.swayY);
      if (m > peak) peak = m;
      sum2 += s.swayX*s.swayX + s.swayY*s.swayY;
      sumAbs += m;
      if (s.amp < minAmp) minAmp = s.amp;
      if (s.amp > maxAmp) maxAmp = s.amp;
      n++;
    }
    return {peak:n?+peak.toFixed(6):0, rms:n?+Math.sqrt(sum2/n).toFixed(6):0,
            meanAbs:n?+(sumAbs/n).toFixed(6):0, minAmp:n?+minAmp.toFixed(3):0,
            maxAmp:n?+maxAmp.toFixed(3):0, n, cut};
  },

  /* The game clock: G.elapsed accumulates the exact dt each update consumed,
     so timing assertions stay correct whether the browser runs at 60fps or a
     headless shell runs at 12fps with dt clamped to 0.05. */
  gameTime(){ return G.elapsed; },

  /* Advance real frames until secs of *game* time have passed. An optional
     cond() is evaluated after every frame and cuts the wait early when it
     returns false; the returned {cut,n,elapsed} says which happened. */
  async waitGame(secs, cond){
    const t0 = G.elapsed;
    let n = 0;
    while (G.elapsed - t0 < secs){
      if (cond && !cond()) return {cut:true, n, elapsed:+(G.elapsed-t0).toFixed(3)};
      await this.frame();
      if (++n > 6000) throw new Error('waitGame frame runaway');
    }
    return {cut:false, n, elapsed:+(G.elapsed-t0).toFixed(3)};
  },

  /* Sway sampling measured in game time, not frame counts: warmSecs of settle,
     then winSecs of lens-offset samples. cond() can truncate the window (e.g.
     sample only while a breath is actually held); maxStep is the largest
     frame-to-frame jump, which is the number a press-time snap would inflate. */
  async swaySampleGame(warmSecs, winSecs, cond){
    await this.waitGame(warmSecs || 0);
    const t0 = G.elapsed;
    let peak = 0, sum2 = 0, sumAbs = 0, n = 0, minAmp = 2, maxAmp = 0, cut = false;
    let maxStep = 0, prev = null;
    while (G.elapsed - t0 < winSecs){
      await this.frame();
      if (cond && !cond()){ cut = true; break; }
      const s = this.breathState();
      const m = Math.hypot(s.swayX, s.swayY);
      if (prev !== null) maxStep = Math.max(maxStep, Math.abs(m - prev));
      prev = m;
      if (m > peak) peak = m;
      sum2 += s.swayX*s.swayX + s.swayY*s.swayY;
      sumAbs += m;
      if (s.amp < minAmp) minAmp = s.amp;
      if (s.amp > maxAmp) maxAmp = s.amp;
      n++;
    }
    return {peak:n?+peak.toFixed(6):0, rms:n?+Math.sqrt(sum2/n).toFixed(6):0,
            meanAbs:n?+(sumAbs/n).toFixed(6):0, minAmp:n?+minAmp.toFixed(3):0,
            maxAmp:n?+maxAmp.toFixed(3):0, maxStep:n?+maxStep.toFixed(6):0, n, cut};
  },

  /* Full breath-hold regression, driven entirely through real frames and real
     keyboard events. All timing is measured in game time (G.elapsed) so the
     suite is immune to headless rAF throttling. Returns one report with a
     check per requirement; every check carries the observed numbers so a
     failure explains itself. */
  async breathTest(){
    const R = [];
    const check = (name, pass, detail) => R.push({name, pass: !!pass, detail});
    const assert = (c, msg) => { if (!c) throw new Error(msg); };
    const isSniper = () => WEAPONS[player.weapon].id === 'sniper';

    /* ---- 1. a legal hold cuts the lens drift, with no press-time jump ---- */
    let s = await this.breathSetup();
    assert(s.scoped, 'scope never came up: ' + JSON.stringify(s));
    const base = await this.swaySampleGame(0.3, 0.7);
    this.shiftDown();
    await this.frame();                                     /* edge consumed here */
    s = this.breathState();
    check('hold: shift press enters breath', s.held && s.breath > 2.9 && !s.lock,
          {breath:s.breath, held:s.held, lock:s.lock});
    const entry = await this.swaySampleGame(0, 0.25);       /* entry ramp */
    const held = await this.swaySampleGame(0.3, 1.0, () => this.breathState().held);
    check('hold: drift clearly reduced while breathing',
          held.rms < base.rms * 0.4 && held.maxAmp <= 0.10 && !held.cut,
          {baseRms:base.rms, heldRms:held.rms, ratio:+(held.rms/base.rms).toFixed(3),
           heldMaxAmp:held.maxAmp, cut:held.cut});
    /* a snap at press time would show up as a per-frame jump far larger than
       the smooth sine drift; damp() keeps every step inside the natural range */
    check('hold: smooth entry, no press-time snap', entry.maxStep <= base.peak * 1.25,
          {entryMaxStep:entry.maxStep, basePeak:base.peak});

    /* ---- 2. three seconds of hold force exhaustion ------------------------ */
    /* fresh hold so the stopwatch covers a full three seconds, not the tail
       of the hold the sway sampling above was burning down */
    this.shiftUp(); await this.waitGame(0.05);
    this.shiftDown(); await this.frame();
    assert(this.breathState().held, 'fresh hold did not engage for exhaustion test');
    const tStart = this.gameTime();
    const w = await this.waitGame(BREATH_TIME + 0.5, () => this.breathState().held);
    const dur = +(this.gameTime() - tStart).toFixed(3);
    s = this.breathState();
    check('exhaust: hold lasts 3s then fails', w.cut && !s.held && s.lock && s.breath === 0
          && dur >= 2.85 && dur <= 3.2,
          {holdSecs:dur, cut:w.cut, state:s});

    /* ---- 3. the same held key cannot restart the breath ------------------- */
    await this.waitGame(0.5);
    s = this.breathState();
    check('exhaust: still locked while shift stays down', s.lock && !s.held, s);

    /* ---- 4. release then re-press restores a legal hold ------------------- */
    this.shiftUp();
    await this.waitGame(0.05);
    s = this.breathState();
    check('release: breath and lock cleared on key up', !s.held && !s.lock && s.breath === 0, s);
    this.shiftDown();
    await this.frame();
    s = this.breathState();
    check('re-press: fresh shift press re-enters breath', s.held && s.breath > 2.9 && !s.lock, s);
    this.shiftUp();
    await this.waitGame(0.05);

    /* ---- 5. drift returns to the unheld baseline after exhaustion --------- */
    await this.breathSetup();
    const base2 = await this.swaySampleGame(0.3, 0.7);
    this.shiftDown();
    await this.waitGame(BREATH_TIME + 0.3, () => this.breathState().held);
    this.shiftUp();
    const recovered = await this.swaySampleGame(1.2, 0.8); /* wait out the ease-up */
    check('exhaust: drift recovers to baseline',
          recovered.rms > base2.rms * 0.8 && recovered.minAmp > 0.85,
          {baseRms:base2.rms, recoveredRms:recovered.rms,
           ratio:+(recovered.rms/base2.rms).toFixed(3), minAmp:recovered.minAmp});

    /* ---- 6. Shift during a reload never starts a breath ------------------- */
    await this.breathSetup();
    WEAPONS[3].mag = 1; updateAmmoUI();
    this._key('KeyR', true);
    await this.waitGame(0.1);
    this._key('KeyR', false);
    s = this.breathState();
    assert(s.reloadT > 0, 'reload did not start');
    this.shiftDown();
    await this.waitGame(0.4);
    s = this.breathState();
    check('reload: shift during reload is ignored', s.reloadT > 0 && !s.held && !s.lock,
          {reloadT:s.reloadT, held:s.held, lock:s.lock});
    while (this.breathState().reloadT > 0){ await this.frame(); }
    await this.waitGame(0.1);
    s = this.breathState();
    check('reload: no deferred breath while shift stays held', !s.held && !s.lock, s);
    this.shiftUp(); await this.waitGame(0.05);
    this.ads(true); await this.waitGame(0.3);               /* reloading dropped ADS */
    this.shiftDown(); await this.frame();
    s = this.breathState();
    check('reload: later legal press still works', s.held && !s.lock, s);
    this.shiftUp(); await this.waitGame(0.05);

    /* ---- 7. Shift during the sniper bolt cycle never starts a breath ------ */
    await this.breathSetup();
    player.fireCooldown = 0;
    assert(fireWeapon(), 'sniper shot failed');
    await this.frame();
    s = this.breathState();
    assert(s.boltT > 0, 'bolt cycle did not start');
    let heldDuringBolt = false;
    this.shiftDown();
    while (this.breathState().boltT > 0){
      await this.frame();
      if (this.breathState().held){ heldDuringBolt = true; break; }
    }
    s = this.breathState();
    check('bolt: no breath while the bolt is worked',
          !heldDuringBolt && !s.held && s.boltT >= 0,
          {boltT:s.boltT, held:s.held});
    while (this.breathState().boltT > 0) await this.frame();
    await this.waitGame(0.1);
    s = this.breathState();
    check('bolt: no deferred breath after the cycle', !s.held, s);
    this.shiftUp(); await this.waitGame(0.05);
    this.shiftDown(); await this.frame();
    s = this.breathState();
    check('bolt: later legal press still works', s.held && !s.lock, s);
    this.shiftUp(); await this.waitGame(0.05);

    /* ---- 8. switching weapons clears the breath instantly ----------------- */
    await this.breathSetup();
    this.shiftDown(); await this.frame();
    assert(this.breathState().held, 'hold did not engage before switch');
    this.wep(0);                                           /* M4, no scope */
    await this.waitGame(0.1);
    s = this.breathState();
    check('switch: hold and lock cleared on weapon swap',
          !isSniper() && !s.held && !s.lock && s.breath === 0, s);
    this.shiftUp(); await this.waitGame(0.05);
    this.wep(3); this.ads(true); await this.waitGame(0.3);
    this.shiftDown(); await this.frame();
    check('switch: breath works again back on the sniper', this.breathState().held,
          this.breathState());
    this.shiftUp(); await this.waitGame(0.05);

    /* ---- 9. leaving the scope clears the breath instantly ----------------- */
    await this.breathSetup();
    this.shiftDown(); await this.frame();
    assert(this.breathState().held, 'hold did not engage before ADS exit');
    this.ads(false);
    await this.waitGame(0.1);
    s = this.breathState();
    check('exit ADS: hold and lock cleared', !s.held && !s.lock && s.breath === 0, s);
    this.shiftUp(); await this.waitGame(0.05);
    this.ads(true); await this.waitGame(0.3);
    this.shiftDown(); await this.frame();
    check('exit ADS: re-scope plus re-press holds again', this.breathState().held,
          this.breathState());
    this.shiftUp(); this.ads(false);

    /* ---- 10. death clears the breath instantly ---------------------------- */
    await this.breathSetup();
    this.shiftDown(); await this.frame();
    assert(this.breathState().held, 'hold did not engage before death');
    window.__god = false;
    damagePlayer(9999, player.pos.clone().add(new THREE.Vector3(1, 0, 0)));
    /* endGame stops the clock, so advance plain frames rather than waitGame */
    await this.frames(2);
    s = this.breathState();
    check('death: breath cleared when killed', player.dead && !s.held && !s.lock && s.breath === 0,
          {dead:player.dead, state:s});
    this.shiftUp();
    window.__god = true;

    const pass = R.every(r => r.pass);
    return {pass, checks: R,
            summary: R.filter(r => !r.pass).map(r => r.name),
            samples: {baseRms: base.rms, heldRms: held.rms,
                      recoveredRms: recovered.rms}};
  },

  shoot(n){ for (let i = 0; i < (n || 1); i++){ player.fireCooldown = 0; fireWeapon(); } },
  resume(){ G.paused = false; G.running = true; UI.pause.classList.remove('on'); },
  state(){ return {hp:+player.hp.toFixed(0), ar:+player.armor.toFixed(0), k:G.kills, w:player.weapon,
                   mag:WEAPONS[player.weapon].mag, ads:player.ads, adsK:+player.adsK.toFixed(2),
                   alive:enemies.filter(e => !e.dead).length, over:G.over, run:G.running,
                   errs:window.__errs.length}; },
  epos(){ return enemies.map(e => ({n:e.name, x:+e.obj.position.x.toFixed(1), y:+e.obj.position.y.toFixed(2),
                                    z:+e.obj.position.z.toFixed(1), s:e.state, hp:e.hp})); },
  rig(){
    if (!H._dp){ H._dp = damagePlayer; window.damagePlayer = (a, f) => { if (!window.__god) return H._dp(a, f); }; }
    clearInterval(window.__ri);
    window.__ri = setInterval(() => {
      if (G.started && !G.over && G.paused) H.resume();
      if (window.__clock) G.time = 170;
    }, 80);
  },
  god(on){ window.__god = on; if (on){ player.hp = 100; player.armor = 50; } },
  clock(on){ window.__clock = on; },

  /* ---- collision audit -------------------------------------------------- */

  /* every worldSolid mesh whose body is not covered by a movement collider.
     Reports world-space box, so a "solid" you can walk through is obvious. */
  audit(minSize){
    minSize = minSize === undefined ? 0.30 : minSize;
    const box = new THREE.Box3(), c = new THREE.Vector3(), s = new THREE.Vector3();
    const out = [];
    for (const m of worldSolid){
      if (m.isInstancedMesh) continue;              // handled per-instance below
      box.setFromObject(m); box.getCenter(c); box.getSize(s);
      if (Math.min(s.x, s.z) < minSize && s.y < minSize) continue;   // trim / debris
      /* sample the body of the object rather than just its centre: a long wall
         can be half covered and still let you through at one end */
      let covered = 0, tries = 0;
      for (let fx = 0.2; fx <= 0.8; fx += 0.3)
        for (let fz = 0.2; fz <= 0.8; fz += 0.3){
          const px = box.min.x + s.x*fx, pz = box.min.z + s.z*fz;
          const y0 = Math.max(box.min.y, 0.3), y1 = Math.min(box.max.y, 1.7);
          if (y1 <= y0) { continue; }
          tries++;
          if (blocked(px, pz, y0, y1, 0.05)) covered++;
        }
      if (!tries) continue;                          // entirely above head height
      if (covered === tries) continue;               // fully solid, fine
      out.push({name: m.name || m.geometry.type, cov: covered + '/' + tries,
                at: [+c.x.toFixed(1), +c.y.toFixed(1), +c.z.toFixed(1)],
                size: [+s.x.toFixed(1), +s.y.toFixed(1), +s.z.toFixed(1)]});
    }
    return out;
  },

  /* Drive the player along straight lines across the whole map using the real
     movement code, and flag any step whose segment crosses a worldSolid surface.
     If an object is shootable but has no collider, the player walks through it
     and the crossing shows up here with the exact spot and the mesh hit. */
  tunnel(lines, probeY){
    lines = lines || 96;
    const R = new THREE.Raycaster();
    const from = new THREE.Vector3(), to = new THREE.Vector3(), dir = new THREE.Vector3();
    const hitsOut = [], seen = new Set();
    const ys = probeY ? [probeY] : [0.35, 1.0, 1.6];
    const savedPos = player.pos.clone();

    for (let i = 0; i < lines; i++){
      const a = (i / lines) * Math.PI * 2;
      /* chords across the yard from the perimeter, hitting the interior at many angles */
      const sx = Math.cos(a) * (HALF - 1.5), sz = Math.sin(a) * (HALF - 1.5);
      const ex = -sx * 0.9, ez = -sz * 0.9;
      const L = Math.hypot(ex - sx, ez - sz);
      const ux = (ex - sx) / L, uz = (ez - sz) / L;
      if (blocked(sx, sz, 0.3, 1.65, 0.34)) continue;
      player.pos.set(sx, 0, sz); player.vel.set(0, 0, 0);
      let px = player.pos.x, pz = player.pos.z;
      for (let s = 0; s < 420; s++){
        moveSlide(player.pos, ux * 0.08, uz * 0.08, 0.36, player.height);
        const g = groundAt(player.pos.x, player.pos.z, player.pos.y + 1.2);
        if (g !== null && g < player.pos.y + 0.6) player.pos.y = g;
        const nx = player.pos.x, nz = player.pos.z;
        const dx = nx - px, dz = nz - pz, d = Math.hypot(dx, dz);
        if (d > 1e-4){
          for (const y of ys){
            /* a step that starts inside geometry is a separate problem; only
               report a clean crossing of a surface during the step */
            from.set(px, player.pos.y + y, pz);
            dir.set(dx / d, 0, dz / d);
            R.set(from, dir); R.far = d;
            const h = R.intersectObjects(worldSolid, false)[0];
            if (h){
              const key = h.object.uuid + '|' + Math.round(h.point.x) + ',' + Math.round(h.point.z);
              if (!seen.has(key)){
                seen.add(key);
                hitsOut.push({at: [+h.point.x.toFixed(1), +h.point.z.toFixed(1)], y: y,
                              mesh: h.object.name || h.object.geometry.type,
                              inst: h.instanceId === undefined ? null : h.instanceId});
              }
            }
          }
        }
        px = nx; pz = nz;
        if (Math.hypot(nx - ex, nz - ez) < 0.5) break;
      }
    }
    player.pos.copy(savedPos);
    return hitsOut;
  },

  /* walk a dense grid at torso height and report any spot the player can stand
     that is inside a worldSolid mesh — i.e. clipped into geometry */
  inside(step){
    step = step || 0.5;
    const R = new THREE.Raycaster();
    const dirs = [new THREE.Vector3(1,0,0), new THREE.Vector3(-1,0,0),
                  new THREE.Vector3(0,0,1), new THREE.Vector3(0,0,-1)];
    const bad = [];
    for (let x = -HALF + 1; x <= HALF - 1; x += step)
      for (let z = -HALF + 1; z <= HALF - 1; z += step){
        if (blocked(x, z, 0.3, 1.65, 0.34)) continue;   // can't stand here anyway
        /* inside a closed mesh, a ray out hits a back face in every direction */
        let enclosed = 0;
        for (const d of dirs){
          R.set(new THREE.Vector3(x, 1.0, z), d); R.far = 40;
          if (R.intersectObjects(worldSolid, false).length) enclosed++;
        }
        if (enclosed === 4){
          /* four hits also happens in a corridor, so confirm with a short probe */
          let near = 0;
          for (const d of dirs){
            R.set(new THREE.Vector3(x, 1.0, z), d); R.far = 0.5;
            if (R.intersectObjects(worldSolid, false).length) near++;
          }
          if (near >= 3) bad.push([+x.toFixed(1), +z.toFixed(1)]);
        }
      }
    return bad;
  },

  /* Fire each weapon at a target placed dead on the crosshair and report
     whether the shot registered, plus the state of every feedback channel. */
  async wtest(){
    const out = [];
    const e = enemies.find(x => !x.dead);
    for (let i = 0; i < WEAPONS.length; i++){
      const w = WEAPONS[i];
      H.wep(i); H.ads(false);
      G.over = false; G.running = true; player.dead = false; window.__god = true;
      /* player looking down -Z, target 12m ahead in the open */
      H.place(0, 0, 24, 0, 0);
      e.obj.position.set(0, 0, 12); e.obj.updateMatrixWorld(true);
      e.hp = 1e6; e.dead = false; e.flinch = 0;
      const h0 = G.hits, s0 = G.shots, sh0 = SHELLS.filter(s => s.life > 0).length;
      player.fireCooldown = 0; player.pumpT = 0; player.boltT = 0; player.reloadT = 0;
      const hp0 = e.hp;
      fireWeapon();
      /* the flash is written during update, so it only exists after a frame */
      await H.frame();
      const flash = {sprite:+muzzleSprite.material.opacity.toFixed(2),
                     vmLight:+vmMuzzleLight.intensity.toFixed(1),
                     worldLight:+muzzleLight.intensity.toFixed(1)};
      await new Promise(r => setTimeout(r, 60));
      const shellsNow = SHELLS.filter(s => s.life > 0).length;
      const shellSide = (() => {
        const s = SHELLS.filter(x => x.life > 0).sort((a,b) => b.life - a.life)[0];
        if (!s) return null;
        const rel = s.mesh.position.clone().sub(camera.position);
        const rgt = new THREE.Vector3(); camera.getWorldDirection(rgt);
        rgt.cross(new THREE.Vector3(0,1,0)).normalize();
        return +rel.dot(rgt).toFixed(2);            // >0 means it left to the right
      })();
      /* ADS: request it and let the ease run */
      H.ads(true);
      await new Promise(r => setTimeout(r, 420));
      const adsK = +player.adsEase.toFixed(2);
      const fov = +camera.fov.toFixed(1);
      const scope = +getComputedStyle(UI.scope).opacity;
      const crossHidden = UI.cross.classList.contains('hidden');
      H.ads(false);
      await new Promise(r => setTimeout(r, 300));
      /* reload from a partial mag */
      w.mag = 1; w.res = w.reserve; updateAmmoUI();
      startReload();
      const reloading = player.reloadT > 0 || player.pumpT > 0 || player.boltT > 0;
      out.push({wep:w.name, id:w.id,
                fired: G.shots - s0, hit: G.hits - h0, dmgDealt: +(hp0 - e.hp).toFixed(0),
                shellsEjected: shellsNow - sh0, shellSide, flash,
                adsEase: adsK, adsFov: fov, wantFov: w.adsFov,
                scopeOpacity: scope, crosshairHidden: crossHidden, reloadStarted: reloading});
      player.reloadT = 0; player.pumpT = 0; player.boltT = 0;
      w.mag = w.magSize; w.res = w.reserve;
    }
    e.hp = 100;
    return out;
  },

  /* Watch every enemy for `secs`: flag any that end up inside geometry, or that
     sit in one spot while not in combat. Resolves with a report. */
  watch(secs){
    const start = performance.now();
    const rec = enemies.map(e => ({n:e.name, inSolid:0, still:0, maxStill:0,
                                   lx:e.obj.position.x, lz:e.obj.position.z,
                                   states:{}, minY:9, maxY:-9}));
    return new Promise(resolve => {
      const iv = setInterval(() => {
        for (let i = 0; i < enemies.length; i++){
          const e = enemies[i], r = rec[i], p = e.obj.position;
          if (e.dead) continue;
          r.states[e.state] = (r.states[e.state] || 0) + 1;
          r.minY = Math.min(r.minY, p.y); r.maxY = Math.max(r.maxY, p.y);
          if (blocked(p.x, p.z, p.y + 0.35, p.y + 1.6, 0.40)) r.inSolid++;
          const moved = Math.hypot(p.x - r.lx, p.z - r.lz);
          if (moved < 0.05){ r.still += 0.1; r.maxStill = Math.max(r.maxStill, r.still); }
          else r.still = 0;
          r.lx = p.x; r.lz = p.z;
        }
        if (performance.now() - start > secs * 1000){
          clearInterval(iv);
          resolve(rec.map(r => ({n:r.n, inSolid:r.inSolid,
                                 maxStill:+r.maxStill.toFixed(1),
                                 y:[+r.minY.toFixed(2), +r.maxY.toFixed(2)],
                                 states:r.states})));
        }
      }, 100);
    });
  },

  /* Charge the player into every collider from four sides and report any that
     it ends up standing inside. This is the direct test of "solid means solid". */
  charge(){
    const bad = [];
    const saved = player.pos.clone();
    for (let i = 0; i < colliders.length; i++){
      const c = colliders[i];
      if (c.maxY <= 0.35) continue;                       // step-over lip
      const cx = (c.minX + c.maxX) / 2, cz = (c.minZ + c.maxZ) / 2;
      const hw = (c.maxX - c.minX) / 2, hd = (c.maxZ - c.minZ) / 2;
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]){
        const off = (dx ? hw : hd) + 3.0;
        const sx = cx - dx*off, sz = cz - dz*off;
        if (Math.abs(sx) > HALF - 0.6 || Math.abs(sz) > HALF - 0.6) continue;
        if (blocked(sx, sz, 0.3, 1.65, 0.34)) continue;    // can't start there
        player.pos.set(sx, 0, sz); player.vel.set(0,0,0);
        for (let s = 0; s < 120; s++){
          moveSlide(player.pos, dx*0.07, dz*0.07, 0.36, player.height);
          const g = groundAt(player.pos.x, player.pos.z, player.pos.y + 1.2);
          if (g !== null && g < player.pos.y + 0.6) player.pos.y = g;
        }
        /* standing inside the footprint, and not on top of it, is a failure */
        const p = player.pos;
        const inX = p.x > c.minX - 0.05 && p.x < c.maxX + 0.05;
        const inZ = p.z > c.minZ - 0.05 && p.z < c.maxZ + 0.05;
        /* the body has to actually overlap the box in Y — walking under a
           second-floor parapet is not a penetration */
        const overlapY = (p.y + player.height - 0.05) > c.minY + 0.02 && (p.y + 0.30) < c.maxY - 0.02;
        if (inX && inZ && overlapY){
          bad.push({i, at: [+p.x.toFixed(1), +p.y.toFixed(2), +p.z.toFixed(1)],
                    boxY: [+c.minY.toFixed(2), +c.maxY.toFixed(2)], dir: [dx,dz]});
        }
      }
    }
    player.pos.copy(saved);
    return bad;
  },

  /* try to leave the map in 32 directions; reports the furthest distance reached */
  escape(){
    const saved = player.pos.clone();
    let worst = 0, at = null;
    for (let i = 0; i < 32; i++){
      const a = (i/32) * Math.PI * 2;
      const dx = Math.cos(a), dz = Math.sin(a);
      player.pos.set(0, 0, 24); player.vel.set(0,0,0);
      for (let s = 0; s < 900; s++){
        moveSlide(player.pos, dx*0.09, dz*0.09, 0.36, player.height);
        const g = groundAt(player.pos.x, player.pos.z, player.pos.y + 1.2);
        if (g !== null && g < player.pos.y + 0.6) player.pos.y = g;
      }
      const d = Math.max(Math.abs(player.pos.x), Math.abs(player.pos.z));
      if (d > worst){ worst = d; at = [+player.pos.x.toFixed(1), +player.pos.z.toFixed(1)]; }
    }
    player.pos.copy(saved);
    return {furthestFromCentre: +worst.toFixed(2), at, wallAt: HALF};
  },

  /* push the player at a wall from `dist` away and report whether they ended up
     on the far side. dirs is a list of [dx,dz] unit-ish vectors. */
  ram(x, z, dirs, dist){
    dist = dist || 2.5;
    const res = [];
    for (const [dx, dz] of dirs){
      const sx = x - dx*dist, sz = z - dz*dist;
      if (blocked(sx, sz, 0.3, 1.65, 0.34)){ res.push('start-blocked'); continue; }
      player.pos.set(sx, 0, sz); player.vel.set(0,0,0);
      for (let i = 0; i < 90; i++){
        moveSlide(player.pos, dx*0.09, dz*0.09, 0.36, player.height);
        const g = groundAt(player.pos.x, player.pos.z, player.pos.y + 1.2);
        if (g !== null && g < player.pos.y + 0.6) player.pos.y = g;
      }
      /* did we end up past the wall? */
      const travelled = (player.pos.x - sx)*dx + (player.pos.z - sz)*dz;
      res.push(+travelled.toFixed(2));
    }
    return res;
  }
};
H.rig();
'dev ready';
