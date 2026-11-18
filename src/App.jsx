import React, { useEffect, useRef, useState } from 'react';
import './App.css';
import { Header } from './components/Header';
import { PlantSvg } from './components/PlantSvg';
import { WaterDroplets } from './components/WaterDroplets';
import { FinalCard } from './components/FinalCard';
import { ParticleCanvas } from './components/ParticleCanvas';
import { audioSynth } from './utils/audio';

const STAGES = [
  {
    // Stage 0: Maceta + tallo verde base (sin hojas)
    stemHeight: 50,
    visibleLeaves: 0,
    reasons: [],
    showTitle: false,
    showSpecial: false,
    btnText: "Regar con amor",
    btnEmoji: "💛"
  },
  {
    // Stage 1: Tallo igual, aparece 1° hoja
    stemHeight: 50,
    visibleLeaves: 1,
    reasons: ["Sos hermosa"],
    showTitle: true,
    showSpecial: false,
    btnText: "Otro poquito",
    btnEmoji: "💧"
  },
  {
    // Stage 2: Crece el tallo y aparece 2° hoja
    stemHeight: 110,
    visibleLeaves: 2,
    reasons: ["Sos hermosa", "Sos divertida"],
    showTitle: true,
    showSpecial: false,
    btnText: "Está creciendo",
    btnEmoji: "🌱"
  },
  {
    // Stage 3: Crece el tallo, mantiene 2° hoja (NO aparece hoja nueva)
    stemHeight: 170,
    visibleLeaves: 2,
    reasons: ["Sos hermosa", "Sos divertida", "Sos mi mundo"],
    showTitle: true,
    showSpecial: false,
    btnText: "Está creciendo",
    btnEmoji: "🌱"
  },
  {
    // Stage 4: Tallo igual, aparece 3° hoja
    stemHeight: 170,
    visibleLeaves: 3,
    reasons: ["Sos hermosa", "Sos divertida", "Sos mi mundo", "Sos auténtica"],
    showTitle: true,
    showSpecial: false,
    btnText: "Está creciendo",
    btnEmoji: "🌱"
  },
  {
    // Stage 5: Crece el tallo y aparece 4° hoja
    stemHeight: 225,
    visibleLeaves: 4,
    reasons: ["Sos hermosa", "Sos divertida", "Sos mi mundo", "Sos auténtica", "Sos perfecta"],
    showTitle: true,
    showSpecial: true,
    btnText: "Regar con mas amor",
    btnEmoji: "💛",
    triggersModal: true
  }
];

// Timing of a single watering flow (one click = one cancellable sequence).
const GROW_DELAY_MS = 350;      // stage/stem update, then the grow sound
const MODAL_DELAY_MS = 400;     // blessing card popup
const RIPPLE_DELAY_MS = 650;    // splash ripple under the pot
// The flow is done once the stem transition (0.35s delay + 0.7s) and the
// ripple (0.65s + 0.5s) have finished; until then extra clicks are ignored.
const FLOW_DURATION_MS = 1150;

export function App() {
  const [currentStage, setCurrentStage] = useState(0);
  const [showModal, setShowModal] = useState(false);
  const [bloomSunflower, setBloomSunflower] = useState(false);
  const [dropsKey, setDropsKey] = useState(0);
  const [showRipple, setShowRipple] = useState(false);
  const [triggerBurst, setTriggerBurst] = useState(false);
  const [particlesResetKey, setParticlesResetKey] = useState(0);

  // Every delayed callback of the current watering flow is tracked here so a
  // reset can cancel all of them before they mutate state.
  const timersRef = useRef(new Set());
  // True while a watering flow is in progress: repeated clicks are ignored.
  const flowLockRef = useRef(false);

  const stage = STAGES[currentStage];

  const clearTimers = () => {
    timersRef.current.forEach((id) => clearTimeout(id));
    timersRef.current.clear();
  };

  const schedule = (callback, delay) => {
    const id = setTimeout(() => {
      timersRef.current.delete(id);
      callback();
    }, delay);
    timersRef.current.add(id);
    return id;
  };

  // Unmount cleanup: never let a pending callback or tone outlive the page.
  useEffect(() => () => {
    timersRef.current.forEach((id) => clearTimeout(id));
    timersRef.current.clear();
    audioSynth.stopAll();
  }, []);

  const playWaterEffects = () => {
    audioSynth.playWaterSound();
    setDropsKey((key) => key + 1);
    setShowRipple(false);
    schedule(() => setShowRipple(true), RIPPLE_DELAY_MS);
  };

  // One watering = one locked, cancellable flow: startWatering() schedules the
  // work and releases the input lock only once the visible effects are done.
  const startFlow = () => {
    flowLockRef.current = true;
    playWaterEffects();
    schedule(() => {
      flowLockRef.current = false;
    }, FLOW_DURATION_MS);
  };

  const resetExperience = () => {
    // Cancel anything the previous flows left pending before touching state.
    clearTimers();
    flowLockRef.current = false;
    audioSynth.stopAll();

    setCurrentStage(0);
    setShowModal(false);
    setBloomSunflower(false);
    setShowRipple(false);
    setTriggerBurst(false);
    setParticlesResetKey((key) => key + 1);
  };

  const handleWater = () => {
    // A flow is already running: ignore extra clicks until it finishes.
    if (flowLockRef.current) return;

    // The blessing card is already on screen: the button must not advance.
    if (showModal) return;

    if (bloomSunflower) {
      // Bloomed flower: watering restarts the experience from stage 0.
      resetExperience();
      startFlow();
      return;
    }

    if (stage.triggersModal) {
      // The popup is scheduled exactly once per arrival at this stage.
      startFlow();
      schedule(() => setShowModal(true), MODAL_DELAY_MS);
      return;
    }

    if (currentStage < STAGES.length - 1) {
      const nextStage = currentStage + 1;
      startFlow();
      schedule(() => {
        setCurrentStage(nextStage);
        audioSynth.playGrowSound(nextStage);
      }, GROW_DELAY_MS);
      return;
    }

    // Nothing to advance: still play the water effects, then release the lock.
    startFlow();
  };

  const handleRevealFlower = () => {
    // Only the visible card can bloom the flower, and only once.
    if (!showModal || bloomSunflower) return;
    // Any pending watering timers are irrelevant once the flower blooms.
    clearTimers();
    // Blooming is terminal: the next watering click restarts the experience.
    flowLockRef.current = false;
    setShowModal(false);
    setBloomSunflower(true);
    setTriggerBurst(true);
    audioSynth.playFanfareSound();
  };

  return (
    <>
      <div className="background-decorations">
        <div className="bg-sun-glow"></div>
      </div>

      <ParticleCanvas triggerBurst={triggerBurst} resetKey={particlesResetKey} />

      <main className="app-container">
        <Header
          showTitle={stage.showTitle}
          reasons={stage.reasons}
          showSpecial={stage.showSpecial}
        />

        <section className="plant-section">
          <WaterDroplets dropsKey={dropsKey} showRipple={showRipple} />
          <PlantSvg
            stage={currentStage}
            stemHeight={stage.stemHeight}
            visibleLeaves={stage.visibleLeaves}
            bloomSunflower={bloomSunflower}
          />
        </section>

        <FinalCard
          show={showModal}
          onRevealFlower={handleRevealFlower}
        />

        <footer className="footer-section">
          <button className="water-button" onClick={handleWater}>
            <span>{bloomSunflower ? "Floreció" : stage.btnText}</span>
            <span className="btn-emoji">{bloomSunflower ? "💛" : stage.btnEmoji}</span>
          </button>
        </footer>
      </main>
    </>
  );
}

export default App;
