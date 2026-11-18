use wasm_bindgen::prelude::*;

/// Inclusive lower bound for the normalized cutoff parameter.
pub const MIN_CUTOFF: f32 = 0.0;
/// Inclusive upper bound for the normalized cutoff parameter.
pub const MAX_CUTOFF: f32 = 1.0;
/// Inclusive lower bound for the resonance parameter.
pub const MIN_RESONANCE: f32 = 0.0;
/// Inclusive upper bound for the resonance parameter.
pub const MAX_RESONANCE: f32 = 4.0;

/// Clamp a parameter into `[min, max]`.
///
/// Non-finite inputs (`NaN`, `+Inf`, `-Inf`) cannot be ordered, so `clamp`
/// would propagate them. We route every non-finite value to `min` instead,
/// which guarantees the stored parameters (and therefore the filter math)
/// always work with finite, in-range numbers.
fn clamp_param(value: f32, min: f32, max: f32) -> f32 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        min
    }
}

#[wasm_bindgen]
pub struct MoogModule {
    cutoff: f32,
    resonance: f32,

    // Input and output
    in1: f32,
    in2: f32,
    in3: f32,
    in4: f32,
    out1: f32,
    out2: f32,
    out3: f32,
    out4: f32,
}

#[wasm_bindgen]
impl MoogModule {
    pub fn new(cutoff: f32, resonance: f32) -> MoogModule {
        MoogModule {
            cutoff: clamp_param(cutoff, MIN_CUTOFF, MAX_CUTOFF),
            resonance: clamp_param(resonance, MIN_RESONANCE, MAX_RESONANCE),
            in1: 0.0,
            in2: 0.0,
            in3: 0.0,
            in4: 0.0,
            out1: 0.0,
            out2: 0.0,
            out3: 0.0,
            out4: 0.0,
        }
    }

    /// Update the cutoff while the filter is running.
    ///
    /// The new value is clamped into `[0, 1]` (non-finite values become `0`).
    /// Only the parameter is touched: `in1..in4` / `out1..out4` keep their
    /// current state so the next `process_vec` call picks up the new cutoff
    /// without a discontinuity or a click.
    pub fn set_cutoff(&mut self, cutoff: f32) {
        self.cutoff = clamp_param(cutoff, MIN_CUTOFF, MAX_CUTOFF);
    }

    /// Update the resonance while the filter is running.
    ///
    /// The new value is clamped into `[0, 4]` (non-finite values become `0`).
    /// Filter state is preserved, so parameter changes are click-free.
    pub fn set_resonance(&mut self, resonance: f32) {
        self.resonance = clamp_param(resonance, MIN_RESONANCE, MAX_RESONANCE);
    }

    pub fn cutoff(&self) -> f32 {
        self.cutoff
    }

    pub fn resonance(&self) -> f32 {
        self.resonance
    }

    pub fn process(&mut self, samples: &js_sys::Float32Array) -> js_sys::Float32Array {
        let samples_vec: Vec<f32> = samples.to_vec();
        let output = self.process_vec(samples_vec);
        js_sys::Float32Array::from(&output[..])
    }

    pub fn process_vec(&mut self, mut samples: Vec<f32>) -> Vec<f32> {
        // Coefficients are derived from the *current* parameters on every call,
        // so a set_cutoff / set_resonance between calls takes effect immediately.
        let f = (self.cutoff * 1.16).clamp(0.0, 0.99);
        let input_factor = 0.35013 * (f * f) * (f * f);
        let fb = (self.resonance * (1.0 - 0.15 * f * f)).clamp(0.0, 0.95);

        // Loop over samples and apply moog filter
        for sample in samples.iter_mut() {
            let mut base = *sample;
            base -= self.out4 * fb;
            base *= input_factor;

            // Add stability check
            // Was having an issue where it increments to infinity sometimes
            // if !base.is_finite() {
            //     base = 0.0;
            // }

            // Pole 1
            self.out1 = base + 0.3 * self.in1 + (1.0 - f) * self.out1;
            self.in1 = base;

            // Pole 2
            self.out2 = self.out1 + 0.3 * self.in2 + (1.0 - f) * self.out2;
            self.in2 = self.out1;

            // Pole 3
            self.out3 = self.out2 + 0.3 * self.in3 + (1.0 - f) * self.out3;
            self.in3 = self.out2;

            // Pole 4
            self.out4 = self.out3 + 0.3 * self.in4 + (1.0 - f) * self.out4;
            self.in4 = self.out3;

            let output = self.out4.clamp(-1.0, 1.0);

            // Final safety net: with clamped parameters the ladder is stable,
            // but if the running state ever becomes non-finite we emit silence
            // instead of NaN/Inf and reset the (already poisoned) state so the
            // filter recovers on the next sample. Normal parameter changes
            // never take this branch and never clear in1..in4 / out1..out4.
            *sample = if output.is_finite() {
                output
            } else {
                self.in1 = 0.0;
                self.in2 = 0.0;
                self.in3 = 0.0;
                self.in4 = 0.0;
                self.out1 = 0.0;
                self.out2 = 0.0;
                self.out3 = 0.0;
                self.out4 = 0.0;
                0.0
            };
        }

        samples
    }
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn constructor_clamps_parameters() {
        let module = MoogModule::new(-2.0, 10.0);
        assert_eq!(module.cutoff(), MIN_CUTOFF);
        assert_eq!(module.resonance(), MAX_RESONANCE);

        let module = MoogModule::new(5.0, -5.0);
        assert_eq!(module.cutoff(), MAX_CUTOFF);
        assert_eq!(module.resonance(), MIN_RESONANCE);
    }

    #[test]
    fn non_finite_parameters_fall_back_to_lower_bound() {
        let module = MoogModule::new(f32::NAN, f32::INFINITY);
        assert_eq!(module.cutoff(), MIN_CUTOFF);
        assert_eq!(module.resonance(), MIN_RESONANCE);

        let mut module = MoogModule::new(0.5, 2.0);
        module.set_cutoff(f32::NAN);
        module.set_resonance(f32::NEG_INFINITY);
        assert_eq!(module.cutoff(), MIN_CUTOFF);
        assert_eq!(module.resonance(), MIN_RESONANCE);
    }
}
