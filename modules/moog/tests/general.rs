use clawdio_moog::MoogModule;
use test_helpers::{
    generate_silence_samples, plotting::plot_waveform_comparison, signal::generate_sine_wave,
};

fn rms(samples: &[f32]) -> f32 {
    let sum_sq: f32 = samples.iter().map(|sample| sample * sample).sum();
    (sum_sq / samples.len() as f32).sqrt()
}

#[test]
fn test_silence_input() {
    let mut filter = MoogModule::new(0.5, 0.5);
    // Generate silence samples
    let silence = generate_silence_samples();

    // Run the filter process
    let result = filter.process_vec(silence);

    // Output should be close to zero for zero input
    for sample in result {
        assert!(sample.abs() < 0.001, "Sample too large: {}", sample);
    }
}

#[test]
fn test_impulse_response() {
    let mut filter = MoogModule::new(0.5, 0.1);
    // Generate a single impulse sample
    let mut impulse = vec![0.0; 128];
    impulse[0] = 1.0;

    let output = filter.process_vec(impulse);

    // First sample should be non-zero
    assert!(output[0] != 0.0);
    // Should decay over time (lowpass behavior)
    assert!(output[10].abs() < output[0].abs());
}

#[test]
fn test_no_nan_or_inf() {
    let mut filter = MoogModule::new(0.9, 0.9); // High settings
    // Generate sine wave samples
    let input_data: Vec<f32> = (0..128).map(|i| (i as f32 * 0.1).sin()).collect();

    let output = filter.process_vec(input_data);

    for (i, sample) in output.iter().enumerate() {
        assert!(sample.is_finite(), "Found NaN or Inf at index {}: {}", i, sample);
        assert!(sample.abs() < 10.0, "Output too large at index {}: {}", i, sample);
    }
}

#[test]
fn test_signal_effect() {
    let num_samples = 1024;
    let mut filter = MoogModule::new(0.7, 0.8);
    let original = generate_sine_wave(num_samples);
    let input = generate_sine_wave(num_samples);
    let output = filter.process_vec(input);

    // Visualize signal
    plot_waveform_comparison(
        &output,
        &original,
        num_samples as f32,
        "Moog Test - Comparison (Sine)",
    )
    .expect("Failed to create plot");
}

#[test]
fn test_stability_over_time() {
    let mut filter = MoogModule::new(0.7, 0.8);

    // Process many samples to test long-term stability
    // Ensures filter decays properly and doesn't go to infinity
    for _ in 0..10 {
        let input: Vec<f32> = (0..1024).map(|i| (i as f32 * 0.01).sin()).collect();
        let output = filter.process_vec(input);

        // Check last few samples are still reasonable
        for &sample in output.iter().rev().take(10) {
            assert!(sample.is_finite() && sample.abs() < 2.0);
        }
    }
}

// ---------------------------------------------------------------------------
// Runtime parameter changes
// ---------------------------------------------------------------------------

#[test]
fn test_runtime_cutoff_changes_amplitude_response() {
    // A signal with frequency content well above the low cutoff corner.
    let input: Vec<f32> = (0..8192).map(|i| (i as f32 * 0.35).sin()).collect();
    let block = 512;
    let mut filter = MoogModule::new(0.05, 0.5);

    // Warm up at a low cutoff and measure the steady-state output energy.
    let _ = filter.process_vec(input[0..block].to_vec());
    let low_output = filter.process_vec(input[block..2 * block].to_vec());
    let low_rms = rms(&low_output);

    // Raise the cutoff *while the filter is running*.
    filter.set_cutoff(0.9);
    let _ = filter.process_vec(input[2 * block..3 * block].to_vec()); // re-settle
    let high_output = filter.process_vec(input[3 * block..4 * block].to_vec());
    let high_rms = rms(&high_output);

    // Low-pass filter: opening the cutoff lets more of the signal through.
    assert!(
        high_rms > low_rms * 2.0,
        "raising cutoff did not increase output energy: low={} high={}",
        low_rms,
        high_rms
    );

    // Lower the cutoff again and the energy should fall back toward the
    // original attenuated level.
    filter.set_cutoff(0.05);
    let _ = filter.process_vec(input[4 * block..5 * block].to_vec()); // re-settle
    let low_again_output = filter.process_vec(input[5 * block..6 * block].to_vec());
    let low_again_rms = rms(&low_again_output);

    assert!(
        low_again_rms < high_rms * 0.75,
        "lowering cutoff did not reduce output energy: low={} high={}",
        low_again_rms,
        high_rms
    );
    assert!(low_output.iter().all(|sample| sample.is_finite()));
    assert!(high_output.iter().all(|sample| sample.is_finite()));
    assert!(low_again_output.iter().all(|sample| sample.is_finite()));
}

#[test]
fn test_runtime_resonance_changes_amplitude_response() {
    // Frequency near the filter corner where the resonance feedback peak
    // produces its strongest boost.
    let input: Vec<f32> = (0..8192).map(|i| (i as f32 * 0.2).sin()).collect();
    let block = 512;
    let mut filter = MoogModule::new(0.2, 0.0);

    let _ = filter.process_vec(input[0..block].to_vec());
    let flat_output = filter.process_vec(input[block..2 * block].to_vec());
    let flat_rms = rms(&flat_output);

    // Increase resonance while running: the corner peak should boost energy
    // (measured boost for this filter is ~1.4x at the corner frequency).
    filter.set_resonance(4.0);
    let _ = filter.process_vec(input[2 * block..3 * block].to_vec()); // re-settle
    let resonant_output = filter.process_vec(input[3 * block..4 * block].to_vec());
    let resonant_rms = rms(&resonant_output);

    assert!(
        resonant_rms > flat_rms * 1.25,
        "raising resonance did not increase output energy: flat={} resonant={}",
        flat_rms,
        resonant_rms
    );

    // Back to no resonance and the boost should disappear again.
    filter.set_resonance(0.0);
    let _ = filter.process_vec(input[4 * block..5 * block].to_vec()); // re-settle
    let flat_again_output = filter.process_vec(input[5 * block..6 * block].to_vec());
    let flat_again_rms = rms(&flat_again_output);

    assert!(
        flat_again_rms < resonant_rms * 0.85,
        "lowering resonance did not reduce output energy: flat={} resonant={}",
        flat_again_rms,
        resonant_rms
    );
    assert!(resonant_output.iter().all(|sample| sample.is_finite()));
    assert!(flat_again_output.iter().all(|sample| sample.is_finite()));
}

// ---------------------------------------------------------------------------
// Boundary clamping
// ---------------------------------------------------------------------------

#[test]
fn test_setters_clamp_out_of_range_inputs() {
    let mut filter = MoogModule::new(0.5, 2.0);

    filter.set_cutoff(-0.7);
    assert_eq!(filter.cutoff(), 0.0);
    filter.set_cutoff(3.0);
    assert_eq!(filter.cutoff(), 1.0);

    filter.set_resonance(-1.0);
    assert_eq!(filter.resonance(), 0.0);
    filter.set_resonance(42.0);
    assert_eq!(filter.resonance(), 4.0);

    // Non-finite values are invalid input too: route them to the lower bound.
    filter.set_cutoff(f32::NAN);
    assert_eq!(filter.cutoff(), 0.0);
    filter.set_resonance(f32::INFINITY);
    assert_eq!(filter.resonance(), 0.0);

    let output = filter.process_vec((0..128).map(|i| (i as f32 * 0.2).sin()).collect());
    assert!(
        output.iter().all(|sample| sample.is_finite()),
        "clamped parameters produced non-finite output"
    );
}

#[test]
fn test_extreme_bounded_parameters_never_emit_non_finite() {
    let extremes = [
        (0.0_f32, 0.0_f32),
        (0.0, 4.0),
        (1.0, 0.0),
        (1.0, 4.0),
        (0.001, 4.0),
        (0.5, 4.0),
    ];

    for (cutoff, resonance) in extremes {
        let mut filter = MoogModule::new(cutoff, resonance);
        for _ in 0..20 {
            let input: Vec<f32> = (0..1024).map(|i| (i as f32 * 0.5).sin()).collect();
            let output = filter.process_vec(input);
            assert!(
                output.iter().all(|sample| sample.is_finite()),
                "non-finite output at cutoff={} resonance={}",
                cutoff,
                resonance
            );
            assert!(
                output.iter().all(|sample| sample.abs() <= 1.0),
                "output exceeded output clamp at cutoff={} resonance={}",
                cutoff,
                resonance
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Filter state continuity across parameter changes
// ---------------------------------------------------------------------------

#[test]
fn test_setters_preserve_filter_state() {
    let mut filter = MoogModule::new(0.2, 1.0);

    // Drive the filter into a non-zero steady state.
    let input: Vec<f32> = (0..512).map(|i| (i as f32 * 0.1).sin()).collect();
    let pre_switch = filter.process_vec(input);
    assert!(pre_switch.last().copied().unwrap_or(0.0).abs() > 0.0);

    // Switch parameters while running.
    filter.set_cutoff(0.8);
    filter.set_resonance(3.0);

    // A fresh module with the same new parameters has zero filter state.
    let mut fresh = MoogModule::new(0.8, 3.0);
    let silence = vec![0.0_f32; 64];

    let switched_output = filter.process_vec(silence.clone());
    let fresh_output = fresh.process_vec(silence);

    // The zero-state module stays silent, while the switched module must ring
    // out from its carried-over in1..in4 / out1..out4 state. If the setters
    // cleared the state, switched_output[0] would be exactly 0 like the fresh
    // module's output.
    assert!(fresh_output.iter().all(|sample| sample.abs() < 1e-9));
    assert!(
        switched_output[0].abs() > 1e-6,
        "filter state appears to have been reset by the parameter change"
    );
    assert!(switched_output.iter().all(|sample| sample.is_finite()));
}

#[test]
fn test_repeated_parameter_switching_stays_finite() {
    let mut filter = MoogModule::new(0.5, 2.0);
    let switches = [
        (0.0_f32, 0.0_f32),
        (1.0, 4.0),
        (0.01, 3.99),
        (0.99, 0.01),
        (-1.0, -1.0),         // out of range -> clamped to (0, 0)
        (2.0, 5.0),           // out of range -> clamped to (1, 4)
        (f32::NAN, f32::NAN), // non-finite -> clamped to (0, 0)
        (0.5, 2.0),
    ];

    for (cutoff, resonance) in switches {
        filter.set_cutoff(cutoff);
        filter.set_resonance(resonance);

        assert!(filter.cutoff().is_finite() && filter.resonance().is_finite());
        assert!((0.0..=1.0).contains(&filter.cutoff()));
        assert!((0.0..=4.0).contains(&filter.resonance()));

        let input: Vec<f32> = (0..256).map(|i| (i as f32 * 0.2).sin()).collect();
        let output = filter.process_vec(input);
        assert!(
            output.iter().all(|sample| sample.is_finite()),
            "non-finite output after switching to cutoff={} resonance={}",
            cutoff,
            resonance
        );
    }
}

#[test]
fn test_silence_after_setter_stays_near_zero() {
    let mut filter = MoogModule::new(0.5, 2.0);

    // Changing parameters must not inject energy into a silent, zero-state
    // filter.
    filter.set_cutoff(0.1);
    filter.set_resonance(3.5);

    let result = filter.process_vec(generate_silence_samples());
    for sample in result {
        assert!(sample.abs() < 0.001, "Sample too large: {}", sample);
    }
}
