import { useEffect, useState } from 'react';
import { api, type Me } from './api';
import { Auth } from './features/auth/Auth';
import { Home } from './features/portfolios/Home';

/** Composition root: session check, then the auth screen or the portfolios home. */
export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<Me>('/v1/me')
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="shell">Loading…</div>;
  if (!me) return <Auth onAuthed={setMe} />;
  return <Home me={me} onLogout={() => api.post('/v1/auth/logout').then(() => setMe(null))} />;
}
