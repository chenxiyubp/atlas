// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::VecDeque;
use std::f64::consts::PI;

const OUTPUT_RATE: f64 = 16_000.0;
const HALF_TAPS: i64 = 32;

/// Streaming, windowed-sinc sample-rate converter.
///
/// For downsampling, the sinc cutoff follows the output/input Nyquist ratio,
/// with a small transition band. A 64-tap Blackman window gives strong
/// rejection above the 8 kHz output Nyquist frequency without a dependency on
/// a platform DSP library.
pub(crate) struct SincResampler {
    samples: VecDeque<f32>,
    first_index: i64,
    next_output_position: f64,
    input_per_output: f64,
    cutoff: f64,
}

impl SincResampler {
    pub(crate) fn new(input_rate: u32) -> Option<Self> {
        if input_rate == 0 {
            return None;
        }

        let mut samples = VecDeque::with_capacity((HALF_TAPS as usize) * 4);
        samples.extend(std::iter::repeat(0.0).take(HALF_TAPS as usize));
        let input_rate = f64::from(input_rate);
        Some(Self {
            samples,
            first_index: -HALF_TAPS,
            next_output_position: 0.0,
            input_per_output: input_rate / OUTPUT_RATE,
            cutoff: (OUTPUT_RATE / input_rate).min(1.0) * 0.94,
        })
    }

    pub(crate) fn push(&mut self, sample: f32) {
        self.samples.push_back(sample);
    }

    pub(crate) fn next_sample(&mut self) -> Option<i16> {
        let newest_index = self
            .first_index
            .checked_add(i64::try_from(self.samples.len()).ok()?)?
            .checked_sub(1)?;
        if self.next_output_position.ceil() as i64 + HALF_TAPS > newest_index {
            return None;
        }

        let center = self.next_output_position.floor() as i64;
        let start = center - HALF_TAPS + 1;
        let end = center + HALF_TAPS;
        let mut weighted_sum = 0.0_f64;
        let mut weight_sum = 0.0_f64;

        for index in start..=end {
            let offset = self.next_output_position - index as f64;
            let normalized_offset = offset / HALF_TAPS as f64;
            if normalized_offset.abs() >= 1.0 {
                continue;
            }

            let window = 0.42
                + 0.5 * (PI * normalized_offset).cos()
                + 0.08 * (2.0 * PI * normalized_offset).cos();
            let sinc_argument = self.cutoff * offset;
            let sinc = if sinc_argument.abs() < f64::EPSILON {
                1.0
            } else {
                (PI * sinc_argument).sin() / (PI * sinc_argument)
            };
            let weight = self.cutoff * sinc * window;
            let buffer_index = usize::try_from(index - self.first_index).ok()?;
            let sample = f64::from(*self.samples.get(buffer_index)?);
            weighted_sum += sample * weight;
            weight_sum += weight;
        }

        let output = if weight_sum.abs() > f64::EPSILON {
            weighted_sum / weight_sum
        } else {
            0.0
        };
        self.next_output_position += self.input_per_output;
        self.discard_consumed_input();
        Some(float_to_i16(output))
    }

    fn discard_consumed_input(&mut self) {
        let earliest_needed = self.next_output_position.floor() as i64 - HALF_TAPS;
        while self.first_index < earliest_needed {
            if self.samples.pop_front().is_none() {
                break;
            }
            self.first_index += 1;
        }
    }
}

fn float_to_i16(value: f64) -> i16 {
    let scaled = value.clamp(-1.0, 1.0) * 32_767.0;
    scaled.round() as i16
}

#[cfg(test)]
mod tests {
    use super::SincResampler;
    use std::f64::consts::PI;

    fn resample_tone(frequency: f64) -> f64 {
        let mut resampler = SincResampler::new(48_000).expect("valid rate");
        let mut output = Vec::new();
        for index in 0..48_000 {
            let phase = 2.0 * PI * frequency * f64::from(index) / 48_000.0;
            resampler.push((phase.sin() * 0.5) as f32);
            while let Some(sample) = resampler.next_sample() {
                output.push(f64::from(sample) / 32_768.0);
            }
        }
        let stable = &output[1_000..];
        (stable.iter().map(|sample| sample * sample).sum::<f64>() / stable.len() as f64).sqrt()
    }

    #[test]
    fn suppresses_frequencies_above_output_nyquist() {
        let passband_rms = resample_tone(1_000.0);
        let stopband_rms = resample_tone(12_000.0);
        assert!(passband_rms > 0.3);
        assert!(stopband_rms < passband_rms * 0.01);
    }
}
