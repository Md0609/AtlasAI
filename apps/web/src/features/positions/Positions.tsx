import { useEffect, useState } from 'react';
import { api, type Portfolio, type PositionRow } from '../../api';
import { num } from '../../components/format';

export function Positions({ portfolio }: { portfolio: Portfolio }) {
  const [rows, setRows] = useState<PositionRow[]>([]);
  const [cash, setCash] = useState<Array<{ currency: string; amount: string }>>([]);
  const [amount, setAmount] = useState('10000');

  const refresh = () =>
    api
      .get<{ data: { positions: PositionRow[]; cash: Array<{ currency: string; amount: string }> } }>(
        `/v1/portfolios/${portfolio.id}/positions`,
      )
      .then((r) => {
        setRows(r.data.positions);
        setCash(r.data.cash);
      });
  useEffect(() => {
    refresh();
  }, [portfolio.id]);

  const deposit = async () => {
    await api.post(`/v1/portfolios/${portfolio.id}/transactions`, {
      type: 'deposit',
      trade_date: new Date().toISOString().slice(0, 10),
      amount,
      currency: portfolio.base_currency,
    });
    await refresh();
  };

  return (
    <div className="card">
      <h3>Positions</h3>
      {rows.length === 0 ? (
        <p className="muted">No positions. Import a CSV or add transactions.</p>
      ) : (
        <table>
          <thead><tr><th>Security</th><th>Qty</th><th>Avg cost</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.security_id}>
                <td>{r.name} <span className="muted">{r.pricing_currency}</span></td>
                <td>{num(r.quantity, 4)}</td>
                <td>{r.avg_cost ? `${num(r.avg_cost)} ${r.cost_currency}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>Cash</h3>
      {cash.length === 0 ? <p className="muted">No cash recorded.</p> : (
        <ul className="plain">
          {cash.map((c) => <li key={c.currency}>{num(c.amount)} {c.currency}</li>)}
        </ul>
      )}
      <div className="inline">
        <input value={amount} onChange={(e) => setAmount(e.target.value)} />
        <button onClick={deposit}>Deposit {portfolio.base_currency}</button>
      </div>
    </div>
  );
}
