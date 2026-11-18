import { useEffect, useCallback, useRef } from 'react';
import { useAtom, useSetAtom, useAtomValue } from 'jotai';
import {
  screenAtom,
  currentLevelAtom,
  playerStateAtom,
  currentStepAtom,
  startTimeAtom,
  finalTimeAtom,
  gameActiveAtom,
} from '../atoms/gameAtoms';
import { audioManager } from '../lib/audio';
import { KEY_CODE_MAP, keyStateManager } from '../lib/keyState';

export function useGameLogic() {
  const setScreen = useSetAtom(screenAtom);
  const currentLevel = useAtomValue(currentLevelAtom);
  const setPlayerState = useSetAtom(playerStateAtom);
  const [currentStep, setCurrentStep] = useAtom(currentStepAtom);
  const [startTime, setStartTime] = useAtom(startTimeAtom);
  const setFinalTime = useSetAtom(finalTimeAtom);
  const gameActive = useAtomValue(gameActiveAtom);

  // Use refs to hold the latest state for use in event handlers
  // This avoids re-creating handlers on every state change
  const stateRef = useRef({
    currentLevel,
    currentStep,
    startTime,
    gameActive,
  });

  useEffect(() => {
    stateRef.current = {
      currentLevel,
      currentStep,
      startTime,
      gameActive,
    };
  }, [currentLevel, currentStep, startTime, gameActive]);

  const resetGameState = useCallback(() => {
    keyStateManager.reset(); // Clear every input source (keyboard + touches)
    audioManager.releaseAll();
    setPlayerState([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    setCurrentStep(0);
    setStartTime(0);
  }, [setPlayerState, setCurrentStep, setStartTime]);

  const checkWinCondition = useCallback((currentState: number[]) => {
    const { currentLevel: level, currentStep: step, startTime: time } = stateRef.current;
    if (!level) return;

    const targetPattern = level.patterns[step];
    const match = currentState.every((val, index) => val === targetPattern[index]);

    if (match) {
      if (step < level.patterns.length - 1) {
        setCurrentStep(step + 1);
      } else {
        keyStateManager.reset();
        audioManager.releaseAll();
        setPlayerState([0, 0, 0, 0, 0, 0, 0, 0, 0]);
        const endTime = Date.now();
        setFinalTime(endTime - time);
        setScreen('result');
      }
    }
  }, [setCurrentStep, setFinalTime, setScreen, setPlayerState]);

  useEffect(() => {
    const handlePress = (code: string) => {
      const keyInfo = KEY_CODE_MAP[code];
      if (keyInfo === undefined || !stateRef.current.gameActive) return;

      setStartTime((prevStartTime) => {
        if (prevStartTime === 0) {
          return Date.now();
        }
        return prevStartTime;
      });

      setPlayerState(prevPlayerState => {
        const newState = [...prevPlayerState];
        newState[keyInfo.index] = 1;
        checkWinCondition(newState);
        return newState;
      });
    };

    const handleRelease = (code: string) => {
      const keyInfo = KEY_CODE_MAP[code];
      if (keyInfo === undefined || !stateRef.current.gameActive) return;

      setPlayerState(prevPlayerState => {
        const newState = [...prevPlayerState];
        newState[keyInfo.index] = 0;
        checkWinCondition(newState);
        return newState;
      });
    };

    const unsubscribePress = keyStateManager.onPress(handlePress);
    const unsubscribeRelease = keyStateManager.onRelease(handleRelease);

    return () => {
      unsubscribePress();
      unsubscribeRelease();
    };
  }, [checkWinCondition, setPlayerState, setStartTime]); // Dependencies are now stable

  useEffect(() => {
    resetGameState();
  }, [currentLevel, resetGameState]);

  return { resetGameState };
}
