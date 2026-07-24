/**
 * Weekly Review (§6.5) — the retention engine. Built to be worth reading on a
 * week when nothing happened: the one thing first, then what changed, then the
 * restraint section (what Atlas reviewed and chose not to send), your rules,
 * and the open questions.
 */
import { useEffect, useState } from 'react';
import { api } from './api';

interface ReviewSection {
  type: string;
  title: string;
  lines: string[];
}

interface WeeklyReview {
  id: string;
  week_start: string;
  one_thing: string;
  sections: ReviewSection[];
  generated_at: string;
  read_at: string | null;
}

export function WeeklyReviewView() {
  const [review, setReview] = useState<WeeklyReview | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api
      .get<{ data: WeeklyReview | null }>('/v1/weekly-reviews/latest')
      .then((r) => {
        setReview(r.data);
        if (r.data && !r.data.read_at) api.patch(`/v1/weekly-reviews/${r.data.id}`, {}).catch(() => {});
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  if (!loaded) return <div className="card">Loading…</div>;
  if (!review) {
    return (
      <div className="card quiet">
        <h3>Your first weekly review lands Sunday.</h3>
        <p className="muted">
          Once a week Atlas writes up what changed, what it reviewed and chose not to tell you, how your rules
          held, and what is still an open question. It is worth reading even on a quiet week.
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="muted small">Week of {review.week_start}</div>
      <h3>{review.one_thing}</h3>
      {review.sections.map((s) => (
        <div key={s.type} style={{ marginTop: 18 }}>
          <h4>{s.title}</h4>
          <ul className="plain">
            {s.lines.map((l, i) => (
              <li key={i} className={l.startsWith('- ') ? 'muted small' : undefined}>
                {l}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
