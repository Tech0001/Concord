use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    pub text: String,
    #[serde(default)]
    pub speaker: Option<String>,
}
#[derive(Clone)]
struct Span {
    start: f64,
    end: f64,
    speaker: String,
}

/// Preserve Concord's overlap assignment and 1.5-second short-run absorption.
/// Local window tracks have already been clustered by the existing voice matcher.
pub fn merge(mut raw: Value, diar: &Value) -> Result<Value> {
    let spans: Vec<Span> = diar["segments"]
        .as_array()
        .context("Missing speaker turns")?
        .iter()
        .map(|s| {
            let number = s["speakerId"]
                .as_str()
                .unwrap_or("0")
                .parse::<u32>()
                .unwrap_or(0);
            Span {
                start: s["startTimeSeconds"].as_f64().unwrap_or(0.),
                end: s["endTimeSeconds"].as_f64().unwrap_or(0.),
                speaker: format!("S{}", number.saturating_sub(1)),
            }
        })
        .collect();
    let assign = |start: f64, end: f64| -> Option<String> {
        let mut best = None;
        let mut overlap = -1.;
        for span in &spans {
            let n = (end.min(span.end) - start.max(span.start)).max(0.);
            if n > overlap {
                overlap = n;
                best = Some(span);
            }
        }
        if overlap <= 0. {
            let mid = (start + end) / 2.;
            best = spans.iter().min_by(|a, b| {
                ((a.start + a.end) / 2. - mid)
                    .abs()
                    .total_cmp(&((b.start + b.end) / 2. - mid).abs())
            });
        }
        best.map(|s| s.speaker.clone())
    };
    let mut words: Vec<Segment> = serde_json::from_value(raw["words"].clone())?;
    let segments: Vec<Segment> = serde_json::from_value(raw["segments"].clone())?;
    for word in &mut words {
        word.speaker = assign(word.start, word.end);
    }
    words.sort_by(|a, b| a.start.total_cmp(&b.start));
    let mut result = Vec::new();
    for mut seg in segments {
        let selected: Vec<Segment> = words
            .iter()
            .filter(|w| w.end > seg.start && w.start < seg.end)
            .cloned()
            .collect();
        if selected.is_empty() {
            seg.speaker = assign(seg.start, seg.end);
            result.push(seg);
            continue;
        }
        let mut runs: Vec<Vec<Segment>> = Vec::new();
        for word in selected {
            if runs.last().is_some_and(|r| r[0].speaker == word.speaker) {
                runs.last_mut().unwrap().push(word);
            } else {
                runs.push(vec![word]);
            }
        }
        let duration = |r: &Vec<Segment>| r.last().unwrap().end - r[0].start;
        while runs.len() > 1 {
            let Some(i) = runs.iter().position(|r| duration(r) < 1.5) else {
                break;
            };
            let prev = if i > 0 { duration(&runs[i - 1]) } else { -1. };
            let next = if i + 1 < runs.len() {
                duration(&runs[i + 1])
            } else {
                -1.
            };
            let short = runs.remove(i);
            if i > 0 && prev >= next {
                runs[i - 1].extend(short);
            } else {
                let speaker = runs[i][0].speaker.clone();
                let mut joined = short;
                joined.append(&mut runs[i]);
                joined[0].speaker = speaker;
                runs[i] = joined;
            }
        }
        let mut merged: Vec<Vec<Segment>> = Vec::new();
        for run in runs {
            if merged
                .last()
                .is_some_and(|r| r[0].speaker == run[0].speaker)
            {
                merged.last_mut().unwrap().extend(run);
            } else {
                merged.push(run);
            }
        }
        for run in merged {
            result.push(Segment {
                start: run[0].start,
                end: run.last().unwrap().end,
                speaker: run[0].speaker.clone(),
                text: run
                    .iter()
                    .map(|w| w.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" "),
            });
        }
    }
    let count = spans
        .iter()
        .map(|s| &s.speaker)
        .collect::<std::collections::HashSet<_>>()
        .len();
    raw["schema_version"] = json!(3);
    raw["words"] = json!(words);
    raw["segments"] = json!(result);
    raw["segment_count"] = json!(result.len());
    raw["speaker_count"] = json!(count);
    Ok(raw)
}

pub fn markdown(raw: &Value) -> String {
    let mut text = format!(
        "# Transcript\n\n- **Model**: {}\n\n",
        raw["model"].as_str().unwrap_or("Nemotron")
    );
    for s in raw["segments"].as_array().into_iter().flatten() {
        text.push_str(&format!(
            "- [{} → {}] **{}:** {}\n",
            timestamp(s["start"].as_f64().unwrap_or(0.)),
            timestamp(s["end"].as_f64().unwrap_or(0.)),
            s["speaker"].as_str().unwrap_or("Speaker"),
            s["text"].as_str().unwrap_or("")
        ));
    }
    text
}
fn timestamp(seconds: f64) -> String {
    let n = seconds.max(0.) as u64;
    format!("{:02}:{:02}:{:02}", n / 3600, n / 60 % 60, n % 60)
}

pub fn cosine(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return -1.;
    }
    let dot: f64 = a.iter().zip(b).map(|(a, b)| *a as f64 * *b as f64).sum();
    let norm = |x: &[f32]| x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>().sqrt();
    let d = norm(a) * norm(b);
    if d <= 0. {
        -1.
    } else {
        dot / d
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn speaker_changes_and_ids_above_eight_survive() {
        let words =
            json!([{"start":0.,"end":2.,"text":"First"},{"start":2.,"end":4.,"text":"Second"}]);
        let raw = json!({"words":words,"segments":[{"start":0.,"end":4.,"text":"First Second"}]});
        let diar = json!({"segments":[{"speakerId":"1","startTimeSeconds":0.,"endTimeSeconds":2.},{"speakerId":"16","startTimeSeconds":2.,"endTimeSeconds":4.}]});
        let merged = merge(raw, &diar).unwrap();
        assert_eq!(merged["segments"][1]["speaker"], "S15");
        assert_eq!(merged["segment_count"], 2);
        assert_eq!(merged["words"][0]["text"], "First");
    }
    #[test]
    fn short_initial_turn_joins_the_next_speaker_without_relabeling_words() {
        let raw = json!({"words":[{"start":0.,"end":0.5,"text":"Yes."},{"start":0.5,"end":3.,"text":"Continuing."}],"segments":[{"start":0.,"end":3.,"text":"Yes. Continuing."}]});
        let diar = json!({"segments":[{"speakerId":"1","startTimeSeconds":0.,"endTimeSeconds":0.5},{"speakerId":"12","startTimeSeconds":0.5,"endTimeSeconds":3.}]});
        let merged = merge(raw, &diar).unwrap();
        assert_eq!(merged["segment_count"], 1);
        assert_eq!(merged["segments"][0]["speaker"], "S11");
        assert_eq!(merged["segments"][0]["text"], "Yes. Continuing.");
        assert_eq!(merged["words"][0]["speaker"], "S0");
    }
    #[test]
    fn voice_matching_handles_invalid_vectors() {
        assert_eq!(cosine(&[0., 0.], &[1., 0.]), -1.);
        assert_eq!(cosine(&[1., 0.], &[1., 0.]), 1.);
        assert_eq!(cosine(&[1.], &[1., 0.]), -1.);
    }
}
