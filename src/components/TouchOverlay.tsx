import { useState, useRef, useCallback, useEffect } from 'react';
import { keyStateManager, TouchKeyTracker } from '../lib/keyState';

function TouchOverlay() {
  // Each touch point becomes its own source in the shared key state
  // manager, so a key stays pressed until every finger (and the keyboard)
  // holding it has been released.
  const [tracker] = useState(() => new TouchKeyTracker(keyStateManager));
  const [pressedZones, setPressedZones] = useState<boolean[]>(Array(9).fill(false));
  const zoneRefs = useRef<(HTMLDivElement | null)[]>([]);
  const overlayRef = useRef<HTMLDivElement>(null);

  const getZoneIndexFromCoordinates = useCallback((x: number, y: number) => {
    for (let i = 0; i < zoneRefs.current.length; i++) {
      const node = zoneRefs.current[i];
      if (node) {
        const rect = node.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          return i;
        }
      }
    }
    return -1;
  }, []);

  const syncPressedZones = useCallback(() => {
    setPressedZones(Array.from({ length: 9 }, (_, i) => tracker.isZoneTouched(i)));
  }, [tracker]);

  useEffect(() => {
    const overlayNode = overlayRef.current;
    if (!overlayNode) return;

    const handleTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      for (const touch of Array.from(e.changedTouches)) {
        tracker.touchStart(
          touch.identifier,
          getZoneIndexFromCoordinates(touch.clientX, touch.clientY),
        );
      }
      syncPressedZones();
    };

    const handleTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      for (const touch of Array.from(e.changedTouches)) {
        tracker.touchMove(
          touch.identifier,
          getZoneIndexFromCoordinates(touch.clientX, touch.clientY),
        );
      }
      syncPressedZones();
    };

    const handleTouchEndOrCancel = (e: TouchEvent) => {
      e.preventDefault();
      for (const touch of Array.from(e.changedTouches)) {
        tracker.touchEnd(touch.identifier);
      }
      syncPressedZones();
    };

    overlayNode.addEventListener('touchstart', handleTouchStart as EventListener, { passive: false });
    overlayNode.addEventListener('touchmove', handleTouchMove as EventListener, { passive: false });
    overlayNode.addEventListener('touchend', handleTouchEndOrCancel as EventListener, { passive: false });
    overlayNode.addEventListener('touchcancel', handleTouchEndOrCancel as EventListener, { passive: false });

    return () => {
      overlayNode.removeEventListener('touchstart', handleTouchStart as EventListener);
      overlayNode.removeEventListener('touchmove', handleTouchMove as EventListener);
      overlayNode.removeEventListener('touchend', handleTouchEndOrCancel as EventListener);
      overlayNode.removeEventListener('touchcancel', handleTouchEndOrCancel as EventListener);
      // Release every key still held by a touch point when the overlay goes away.
      tracker.reset();
    };
  }, [getZoneIndexFromCoordinates, tracker, syncPressedZones]);

  // Drop any leftover touches when the game state is reset
  // (level restart, back to menu, level complete).
  useEffect(() => {
    return keyStateManager.onReset(() => {
      tracker.reset();
      setPressedZones(Array(9).fill(false));
    });
  }, [tracker]);

  return (
    <div
      ref={overlayRef}
      className="absolute inset-0 z-10 flex flex-col"
      style={{ touchAction: 'none' }}
    >
      <div className="grow flex">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            ref={el => { zoneRefs.current[i] = el; }}
            className={`flex-1 h-full border-r border-white/10 ${
              pressedZones[i] ? 'bg-white/30' : 'bg-transparent'
            } transition-colors duration-200`}
          />
        ))}
      </div>
      <div
        ref={el => { zoneRefs.current[8] = el; }}
        className={`h-1/5 border-t border-white/10 ${
          pressedZones[8] ? 'bg-white/30' : 'bg-transparent'
        } transition-colors duration-200`}
      />
    </div>
  );
}

export default TouchOverlay;
