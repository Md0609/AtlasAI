import { useState } from 'react';
import type { Portfolio } from '../../api';
import { Button } from '../../components/Button';
import { ThemeToggle } from '../../components/ThemeToggle';
import { Exposure } from '../exposure/Exposure';
import { ImportCsv } from '../import/ImportCsv';
import { Performance } from '../performance/Performance';
import { Positions } from '../positions/Positions';
import { Summary } from '../summary';

type Tab = 'summary' | 'positions' | 'exposure' | 'performance' | 'import';

export function PortfolioView({ portfolio, onBack }: { portfolio: Portfolio; onBack: () => void }) {
  const [tab, setTab] = useState<Tab>('summary');
  return (
    <div className="shell">
      <header>
        <Button variant="link" onClick={onBack}>← Portfolios</Button>
        <h1>{portfolio.name} <span className="muted">{portfolio.base_currency}</span></h1>
        <ThemeToggle />
      </header>
      <nav className="tabs">
        {(['summary', 'positions', 'exposure', 'performance', 'import'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            className={tab === t ? 'tab active' : 'tab'}
            aria-pressed={tab === t}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </nav>
      {tab === 'summary' && <Summary key={portfolio.id} portfolio={portfolio} />}
      {tab === 'positions' && <Positions portfolio={portfolio} />}
      {tab === 'exposure' && <Exposure portfolio={portfolio} />}
      {tab === 'performance' && <Performance portfolio={portfolio} />}
      {tab === 'import' && <ImportCsv portfolio={portfolio} onDone={() => setTab('summary')} />}
    </div>
  );
}
