//! Carry manual identities across re-diarization even when local speaker numbers change.
use crate::{db, speakers, transcript};
use anyhow::Result;
use rusqlite::Connection;
use serde_json::Value;
use std::collections::HashMap;

pub struct Label {
    id: String,
    prints: Vec<Vec<f32>>,
    ranges: Vec<(f64, f64)>,
}
fn ranges(values: impl Iterator<Item = (f64, f64)>) -> Vec<(f64, f64)> {
    let mut sorted: Vec<_> = values
        .filter(|(a, b)| a.is_finite() && b.is_finite() && b > a)
        .collect();
    sorted.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out: Vec<(f64, f64)> = Vec::new();
    for (a, b) in sorted {
        if let Some(last) = out.last_mut().filter(|last| a <= last.1) {
            last.1 = last.1.max(b);
        } else {
            out.push((a, b));
        }
    }
    out
}
pub fn read(db: &Connection, media: &str) -> Result<Vec<Label>> {
    let mut map: HashMap<String, Label> = HashMap::new();
    let mut locals = HashMap::new();
    let mut q=db.prepare("SELECT local_id,speaker_id,centroid FROM assignments WHERE media_id=?1 AND speaker_id IS NOT NULL AND confidence IS NULL")?;
    for row in q.query_map([media], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<Vec<u8>>>(2)?,
        ))
    })? {
        let (local, id, centroid) = row?;
        locals.insert(local, id.clone());
        let label = map.entry(id.clone()).or_insert(Label {
            id,
            prints: vec![],
            ranges: vec![],
        });
        if let Some(c) = centroid {
            label.prints.push(speakers::floats(&c));
        }
    }
    if map.is_empty() {
        return Ok(vec![]);
    }
    for s in db::rows(
        db,
        "SELECT start,end,speaker FROM segments WHERE media_id=?1",
        [media],
    )? {
        if let Some(id) = s["speaker"].as_str().and_then(|s| locals.get(s)) {
            if let (Some(a), Some(b)) = (s["start"].as_f64(), s["end"].as_f64()) {
                map.get_mut(id).unwrap().ranges.push((a, b));
            }
        }
    }
    let mut values: Vec<_> = map.into_values().collect();
    for v in &mut values {
        v.ranges = ranges(v.ranges.iter().copied());
    }
    Ok(values)
}
pub fn matching<'a>(
    labels: &'a [Label],
    local: &str,
    centroid: &[f32],
    segments: &[Value],
) -> Option<&'a str> {
    // Multiple old fingerprints may belong to one identity. Never compare local IDs.
    let mut voice: Vec<_> = labels
        .iter()
        .map(|l| {
            (
                l,
                l.prints
                    .iter()
                    .map(|p| transcript::cosine(p, centroid))
                    .filter(|s| s.is_finite())
                    .fold(-1., f64::max),
            )
        })
        .collect();
    voice.sort_by(|a, b| b.1.total_cmp(&a.1));
    if let Some((label, score)) = voice.first() {
        if *score >= 0.75 && voice.get(1).is_none_or(|v| score - v.1 >= 0.12) {
            return Some(&label.id);
        }
    }
    // A model change can make vectors incomparable. Recover only an unambiguous
    // time alignment, requiring most of the new voice's speech to be accounted for.
    let spans = ranges(
        segments
            .iter()
            .filter(|s| s["speaker"] == local)
            .filter_map(|s| Some((s["start"].as_f64()?, s["end"].as_f64()?))),
    );
    let duration: f64 = spans.iter().map(|(a, b)| b - a).sum();
    if duration <= 0. {
        return None;
    }
    let mut scores: Vec<_> = labels
        .iter()
        .map(|l| {
            let overlap: f64 = spans
                .iter()
                .flat_map(|(a, b)| {
                    l.ranges
                        .iter()
                        .map(move |(c, d)| (b.min(*d) - a.max(*c)).max(0.))
                })
                .sum();
            (l, overlap)
        })
        .collect();
    scores.sort_by(|a, b| b.1.total_cmp(&a.1));
    let total: f64 = scores.iter().map(|v| v.1).sum();
    scores
        .first()
        .filter(|(_, n)| *n >= duration * 0.6 && *n >= total * 0.9)
        .map(|(l, _)| l.id.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn changed_local_ids_keep_manual_identity_without_guessing_ambiguous_turns() {
        let labels = vec![
            Label {
                id: "alice".into(),
                prints: vec![],
                ranges: vec![(0., 10.)],
            },
            Label {
                id: "bob".into(),
                prints: vec![],
                ranges: vec![(10., 20.)],
            },
        ];
        let segments = vec![
            json!({"speaker":"new_12","start":1.,"end":8.}),
            json!({"speaker":"new_7","start":12.,"end":19.}),
        ];
        assert_eq!(matching(&labels, "new_12", &[], &segments), Some("alice"));
        assert_eq!(matching(&labels, "new_7", &[], &segments), Some("bob"));
        assert_eq!(
            matching(
                &labels,
                "mixed",
                &[],
                &[json!({"speaker":"mixed","start":0.,"end":20.})]
            ),
            None
        );
        assert_eq!(
            matching(
                &labels,
                "uncovered",
                &[],
                &[json!({"speaker":"uncovered","start":0.,"end":100.})]
            ),
            None
        );
    }
    #[test]
    fn overlapping_asr_lines_do_not_multiply_evidence() {
        assert_eq!(
            ranges([(0., 4.), (1., 5.), (7., 9.), (8., 8.)].into_iter()),
            vec![(0., 5.), (7., 9.)]
        );
        let labels = vec![
            Label {
                id: "alice".into(),
                prints: vec![vec![1., 0.], vec![0.9, 0.1]],
                ranges: vec![],
            },
            Label {
                id: "bob".into(),
                prints: vec![vec![0., 1.]],
                ranges: vec![],
            },
        ];
        assert_eq!(
            matching(&labels, "renumbered", &[1., 0.], &[]),
            Some("alice")
        );
    }
}
