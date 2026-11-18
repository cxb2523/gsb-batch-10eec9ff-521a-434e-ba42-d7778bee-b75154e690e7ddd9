import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  ViewerState,
  DEFAULT_PPI,
  MIN_PPI,
  MAX_PPI,
  LoadedModel,
  Vec3,
} from './types';

const VALID_EXTENSIONS = new Set(['obj', 'stl', '3mf']);
const LAYOUT_GAP = 10;

const generateModelColor = () => {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}, 60%, 50%)`;
};

const getDefaultScreenSize = () => ({
  width: typeof window !== 'undefined' ? window.screen.width : 1920,
  height: typeof window !== 'undefined' ? window.screen.height : 1080,
});

/**
 * Assigns initial X-axis positions to newly dimensioned models without
 * overwriting any positions that already exist (including user drags).
 */
const layoutNewModels = (
  models: LoadedModel[],
  dimensions: Record<string, Vec3>,
  existingPositions: Record<string, Vec3>,
  scales: Record<string, Vec3>
): Record<string, Vec3> => {
  const nextPositions: Record<string, Vec3> = { ...existingPositions };
  const newlyDimensioned: LoadedModel[] = [];
  let hasPositionedModels = false;
  let maxRightEdge = -Infinity;

  for (const model of models) {
    const dim = dimensions[model.id];
    const existingPos = existingPositions[model.id];

    if (existingPos) {
      hasPositionedModels = true;
      if (dim) {
        const scaleX = Math.abs(scales[model.id]?.x ?? 1);
        const halfWidth = (dim.x * scaleX) / 2;
        maxRightEdge = Math.max(maxRightEdge, existingPos.x + halfWidth);
      }
    } else if (dim) {
      newlyDimensioned.push(model);
    }
  }

  if (newlyDimensioned.length === 0) {
    return nextPositions;
  }

  if (!hasPositionedModels) {
    // Fresh plate: center the initial batch around X = 0.
    let currentX = 0;
    for (const model of newlyDimensioned) {
      const dim = dimensions[model.id];
      const scaleX = Math.abs(scales[model.id]?.x ?? 1);
      const width = dim.x * scaleX;
      nextPositions[model.id] = { x: currentX + width / 2, y: 0, z: 0 };
      currentX += width + LAYOUT_GAP;
    }

    const totalWidth = currentX - LAYOUT_GAP;
    const shiftX = totalWidth > 0 ? -totalWidth / 2 : 0;
    for (const model of newlyDimensioned) {
      nextPositions[model.id] = {
        ...nextPositions[model.id],
        x: nextPositions[model.id].x + shiftX,
      };
    }
    return nextPositions;
  }

  // Append newly loaded models to the right of existing ones.
  let cursorX = Number.isFinite(maxRightEdge) ? maxRightEdge + LAYOUT_GAP : 0;
  for (const model of newlyDimensioned) {
    const dim = dimensions[model.id];
    const scaleX = Math.abs(scales[model.id]?.x ?? 1);
    const width = dim.x * scaleX;
    nextPositions[model.id] = { x: cursorX + width / 2, y: 0, z: 0 };
    cursorX += width + LAYOUT_GAP;
  }

  return nextPositions;
};

// Debounce state for batching simultaneous model dimension updates.
let dimensionUpdateTimer: ReturnType<typeof setTimeout> | null = null;
let pendingDimensionUpdates: Record<string, Vec3> = {};

// Monotonic token identifying the single in-flight AR export. Every new export,
// selection change, or session close invalidates previous tokens so a late
// completion can never overwrite the current AR state.
let arRequestSequence = 0;

export type ArStatus = 'idle' | 'preparing' | 'ready' | 'error';

export interface ArState {
  isArSupported: boolean;
  arStatus: ArStatus;
  // Token + model id captured at the moment an export is initiated.
  arGenerationRequest: number | null;
  arTargetModelId: string | null;
  arModelUrl: string | null;
  arUsdzUrl: string | null;
  arFileName: string | null;
  arError: string | null;
  setArSupported: (supported: boolean) => void;
  triggerArGeneration: () => void;
  clearArGenerationRequest: () => void;
  // resolve* reject results whose token no longer matches the active export.
  resolveArAsset: (
    requestToken: number,
    modelId: string,
    kind: 'usdz' | 'glb',
    url: string,
    fileName: string
  ) => void;
  resolveArError: (requestToken: number, modelId: string, message: string) => void;
  closeArSession: () => void;
}

const initialScreen = getDefaultScreenSize();

export const useStore = create<ViewerState & ArState>()(
  persist(
    (set, get) => ({
      models: [],
      selectedModelId: null,
      ppi: DEFAULT_PPI,
      isGridVisible: true,
      isWireframeVisible: false,
      gizmoMode: 'translate',
      rotationSnap: Math.PI / 4,
      sidebarOpen: true,
      is1to1Mode: false,
      isCalibrationModalOpen: false,
      uploadError: null,

      isArSupported: false,
      arStatus: 'idle',
      arGenerationRequest: null,
      arTargetModelId: null,
      arModelUrl: null,
      arUsdzUrl: null,
      arFileName: null,
      arError: null,

      calibrationSettings: {
        resolutionWidth: initialScreen.width,
        resolutionHeight: initialScreen.height,
        diagonalInches: 24,
      },

      modelDimensions: {},
      modelPositions: {},
      modelRotations: {},
      modelScales: {},

      addModels: (files) => {
        const validFiles: File[] = [];
        const rejectedNames: string[] = [];

        for (const file of files) {
          const ext = file.name.split('.').pop()?.toLowerCase();
          if (ext && VALID_EXTENSIONS.has(ext)) {
            validFiles.push(file);
          } else {
            rejectedNames.push(file.name);
          }
        }

        const uploadError =
          rejectedNames.length > 0
            ? `Unsupported format (${rejectedNames.join(', ')}). Use .obj, .stl, or .3mf.`
            : null;

        if (validFiles.length === 0) {
          if (uploadError) set({ uploadError });
          return;
        }

        const newModels: LoadedModel[] = validFiles.map((file) => ({
          id: crypto.randomUUID(),
          file,
          url: URL.createObjectURL(file),
          color: generateModelColor(),
          visible: true,
        }));

        set((state) => {
          const updatedModels = [...state.models, ...newModels];
          const newRotations = { ...state.modelRotations };
          const newScales = { ...state.modelScales };

          for (const model of newModels) {
            newRotations[model.id] = { x: 0, y: 0, z: 0 };
            newScales[model.id] = { x: 1, y: 1, z: 1 };
          }

          return {
            models: updatedModels,
            selectedModelId: newModels[newModels.length - 1].id,
            modelRotations: newRotations,
            modelScales: newScales,
            uploadError,
          };
        });
      },

      addExampleModel: async () => {
        try {
          const { cubeData } = await import('./cubeData');
          const blob = new Blob([cubeData], { type: 'application/octet-stream' });
          const file = new File([blob], 'Calibration_cube.stl', {
            type: 'application/octet-stream',
          });
          get().addModels([file]);
        } catch (error) {
          console.error('Error loading embedded example model:', error);
          set({ uploadError: 'Failed to load example model.' });
        }
      },

      removeModel: (id) => {
        // Drop any queued dimension updates for this model before the debounce fires.
        delete pendingDimensionUpdates[id];

        set((state) => {
          const model = state.models.find((m) => m.id === id);
          if (model) URL.revokeObjectURL(model.url);

          const newModels = state.models.filter((m) => m.id !== id);
          const { [id]: _dim, ...remainingDimensions } = state.modelDimensions;
          const { [id]: _rot, ...remainingRotations } = state.modelRotations;
          const { [id]: _scale, ...remainingScales } = state.modelScales;
          const { [id]: _pos, ...remainingPositions } = state.modelPositions;

          // If the removed model owns the active AR session, invalidate any
          // in-flight export for it and release its AR temporary URLs.
          const resettingAr = state.arTargetModelId === id;
          if (resettingAr) {
            if (state.arModelUrl) URL.revokeObjectURL(state.arModelUrl);
            if (state.arUsdzUrl) URL.revokeObjectURL(state.arUsdzUrl);
            arRequestSequence += 1;
          }

          return {
            models: newModels,
            selectedModelId: state.selectedModelId === id ? null : state.selectedModelId,
            modelDimensions: remainingDimensions,
            modelRotations: remainingRotations,
            modelScales: remainingScales,
            modelPositions: remainingPositions,
            ...(resettingAr
              ? {
                  arStatus: 'idle' as ArStatus,
                  arGenerationRequest: null,
                  arTargetModelId: null,
                  arModelUrl: null,
                  arUsdzUrl: null,
                  arFileName: null,
                  arError: null,
                }
              : {}),
          };
        });
      },

      selectModel: (id) =>
        set((state) => {
          // Switching the selection while an AR session is active invalidates the
          // export bound to the previous model: return to a clean, re-launchable
          // state and release the previous model's temporary GLB/USDZ URLs.
          if (id !== state.selectedModelId && state.arStatus !== 'idle') {
            if (state.arModelUrl) URL.revokeObjectURL(state.arModelUrl);
            if (state.arUsdzUrl) URL.revokeObjectURL(state.arUsdzUrl);
            arRequestSequence += 1;
            return {
              selectedModelId: id,
              arStatus: 'idle',
              arGenerationRequest: null,
              arTargetModelId: null,
              arModelUrl: null,
              arUsdzUrl: null,
              arFileName: null,
              arError: null,
            };
          }
          return { selectedModelId: id };
        }),

      setPPI: (ppi) => {
        if (typeof ppi === 'number' && Number.isFinite(ppi) && ppi > 0) {
          const clamped = Math.min(MAX_PPI, Math.max(MIN_PPI, ppi));
          set({ ppi: clamped });
        }
      },

      setCalibrationSettings: (settings) =>
        set((state) => ({
          calibrationSettings: { ...state.calibrationSettings, ...settings },
        })),

      toggleGrid: () => set((state) => ({ isGridVisible: !state.isGridVisible })),

      toggleWireframe: () => set((state) => ({ isWireframeVisible: !state.isWireframeVisible })),

      setGizmoMode: (mode) => set({ gizmoMode: mode }),

      setRotationSnap: (angleDeg) =>
        set({
          rotationSnap: angleDeg ? angleDeg * (Math.PI / 180) : null,
        }),

      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),

      set1to1Mode: (is1to1) => set({ is1to1Mode: is1to1 }),

      setCalibrationModalOpen: (isOpen) => set({ isCalibrationModalOpen: isOpen }),

      clearUploadError: () => set({ uploadError: null }),

      updateModelDimensions: (id, x, y, z) => {
        pendingDimensionUpdates[id] = { x, y, z };

        if (dimensionUpdateTimer) clearTimeout(dimensionUpdateTimer);

        dimensionUpdateTimer = setTimeout(() => {
          dimensionUpdateTimer = null;
          set((state) => {
            const activeIds = new Set(state.models.map((m) => m.id));
            const validUpdates: Record<string, Vec3> = {};

            for (const [modelId, dim] of Object.entries(pendingDimensionUpdates)) {
              if (activeIds.has(modelId)) {
                validUpdates[modelId] = dim;
              }
            }
            pendingDimensionUpdates = {};

            if (Object.keys(validUpdates).length === 0) {
              return {};
            }

            const newDimensions = {
              ...state.modelDimensions,
              ...validUpdates,
            };

            const newPositions = layoutNewModels(
              state.models,
              newDimensions,
              state.modelPositions,
              state.modelScales
            );

            return {
              modelDimensions: newDimensions,
              modelPositions: newPositions,
            };
          });
        }, 50);
      },

      updateModelTransform: (id, transform) => {
        set((state) => {
          const updates: Partial<ViewerState> = {};
          if (transform.position) {
            updates.modelPositions = { ...state.modelPositions, [id]: transform.position };
          }
          if (transform.rotation) {
            updates.modelRotations = { ...state.modelRotations, [id]: transform.rotation };
          }
          if (transform.scale) {
            updates.modelScales = { ...state.modelScales, [id]: transform.scale };
          }
          return updates;
        });
      },

      setArSupported: (supported) => set({ isArSupported: supported }),

      triggerArGeneration: () =>
        set((state) => {
          const targetModelId = state.selectedModelId;
          if (!targetModelId) {
            return {};
          }

          // Re-issuing (or retrying) an export invalidates the previous one and
          // releases every temporary URL it produced.
          if (state.arModelUrl) URL.revokeObjectURL(state.arModelUrl);
          if (state.arUsdzUrl) URL.revokeObjectURL(state.arUsdzUrl);

          const requestToken = ++arRequestSequence;
          return {
            // The export is permanently bound to the model selected right now.
            arGenerationRequest: requestToken,
            arTargetModelId: targetModelId,
            arStatus: 'preparing',
            arModelUrl: null,
            arUsdzUrl: null,
            arFileName: null,
            arError: null,
          };
        }),

      clearArGenerationRequest: () => set({ arGenerationRequest: null }),

      resolveArAsset: (requestToken, modelId, kind, url, fileName) =>
        set((state) => {
          // Drop results from superseded, cancelled, or re-targeted exports.
          if (
            requestToken !== arRequestSequence ||
            state.arTargetModelId !== modelId ||
            state.arStatus !== 'preparing'
          ) {
            URL.revokeObjectURL(url);
            return {};
          }

          if (state.arModelUrl && state.arModelUrl !== url) {
            URL.revokeObjectURL(state.arModelUrl);
          }
          if (state.arUsdzUrl && state.arUsdzUrl !== url) {
            URL.revokeObjectURL(state.arUsdzUrl);
          }

          return kind === 'usdz'
            ? {
                arUsdzUrl: url,
                arModelUrl: null,
                arFileName: fileName,
                arStatus: 'ready',
                arError: null,
              }
            : {
                arModelUrl: url,
                arUsdzUrl: null,
                arFileName: fileName,
                arStatus: 'ready',
                arError: null,
              };
        }),

      resolveArError: (requestToken, modelId, message) =>
        set((state) => {
          // A failure from an outdated export must never surface in the UI.
          if (
            requestToken !== arRequestSequence ||
            state.arTargetModelId !== modelId ||
            state.arStatus !== 'preparing'
          ) {
            return {};
          }
          return {
            arStatus: 'error',
            arError: message,
            arGenerationRequest: null,
          };
        }),

      closeArSession: () =>
        set((state) => {
          if (state.arModelUrl) URL.revokeObjectURL(state.arModelUrl);
          if (state.arUsdzUrl) URL.revokeObjectURL(state.arUsdzUrl);
          // Any export still running completes against a dead token and is discarded.
          arRequestSequence += 1;
          return {
            arStatus: 'idle',
            arGenerationRequest: null,
            arTargetModelId: null,
            arModelUrl: null,
            arUsdzUrl: null,
            arFileName: null,
            arError: null,
          };
        }),
    }),
    {
      name: '1to13d-storage',
      partialize: (state) => ({
        ppi: state.ppi,
        calibrationSettings: {
          diagonalInches: state.calibrationSettings.diagonalInches,
        },
      }),
      merge: (persistedState: unknown, currentState) => {
        const persisted = (persistedState ?? {}) as Partial<ViewerState>;
        const screen = getDefaultScreenSize();
        return {
          ...currentState,
          ...persisted,
          calibrationSettings: {
            ...currentState.calibrationSettings,
            ...(persisted.calibrationSettings || {}),
            resolutionWidth: screen.width,
            resolutionHeight: screen.height,
          },
        };
      },
    }
  )
);
