import React, { useEffect, useState } from 'react';
import { requestQuota, type QuotaStatus } from '../../assessment/issuer';
import { getSecrets, getSettings } from '../../core/settings';
import { Confirm, useToast } from '../bridge';

/**
 * Today's assessment-token count on the assessment server, with a button that starts the count again.
 * It uses the saved server address and issuer key (save the settings first after changing them).
 */
export function TokenQuotaPanel() {
  const toast = useToast();
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [askReset, setAskReset] = useState(false);
  const [error, setError] = useState('');

  const run = async (reset: boolean) => {
    setBusy(true);
    setError('');
    try {
      const [settings, secrets] = await Promise.all([getSettings(), getSecrets()]);
      const status = await requestQuota({ fetch: (u, i) => fetch(u, i) }, { baseUrl: settings.assessmentServerUrl, issuerKey: secrets.assessmentIssuerKey ?? '' }, reset);
      setQuota(status);
      if (reset) toast(`Token count restarted: ${status.remainingToday} of ${status.dailyCap} left for today.`, 'good');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { void run(false); }, []);

  return (
    <div className="col">
      <div className="row">
        {quota
          ? <span className={`chip ${quota.remainingToday > 0 ? 'good' : 'warn'}`}>{quota.usedToday} of {quota.dailyCap} used today · {quota.remainingToday} left</span>
          : <span className="muted small">{error ? '' : 'Checking…'}</span>}
        <button disabled={busy} onClick={() => run(false)}>Check usage</button>
        <button className="danger" disabled={busy || !quota} onClick={() => setAskReset(true)}>Reset today’s count…</button>
      </div>
      {quota && (
        <div className="muted small">
          Counting restarts automatically at midnight UTC (next: {new Date(quota.resetsAt).toLocaleString()}). A reset keeps the record of every token issued.
        </div>
      )}
      {error && <div className="note warn">{error}</div>}
      {askReset && quota && (
        <Confirm
          danger
          confirmLabel="Reset count"
          message={`Start today's count again? The ${quota.usedToday} token(s) issued so far today stop counting toward the limit of ${quota.dailyCap}. Tokens already issued stay valid, and the record of them is kept.`}
          onNo={() => setAskReset(false)}
          onYes={async () => { setAskReset(false); await run(true); }}
        />
      )}
    </div>
  );
}
